"""Local web dashboard: a thin REST layer over PacsServer plus the static UI.

Bound to localhost by default, where it runs unauthenticated: only a process on
this machine can reach it, and the X-Carino header stops a page the operator has
open from firing cross-site writes. Binding it anywhere else requires
web.auth_token (enforced by config validation, applied by pacs.auth), because an
open API here hands out patient studies, storage paths and /api/shutdown.

Auth and the X-Carino header are two different controls and both stay on: the
token says *who* may call, the header says *from where*. A stolen token still
cannot be used by a foreign page, and a same-origin XSS still cannot write
without the token.
"""

from __future__ import annotations

import copy
import json
import mimetypes
import os
import sys
import threading
import time
from urllib.parse import urlsplit

from flask import Flask, jsonify, redirect, request, send_file, send_from_directory

from . import APP_NAME, __version__, audit, auth, users
from .config import (auth_token_of, deid_secret_of, is_loopback_host,
                     notify_secrets_of, web_host_of)
from .server import PacsServer

# The bundled editor's JPEG 2000 and JPEG-LS decoders are WebAssembly, and a
# .wasm served as anything other than application/wasm cannot be handed to the
# streaming compiler — the loader falls back to a buffered compile and logs it,
# which is a slow decode and a console full of noise on a reading-room machine.
# Python resolves MIME types from /etc/mime.types on Linux and from the registry
# on Windows, where .wasm is frequently absent. Register it rather than hope.
mimetypes.add_type("application/wasm", ".wasm")

WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
# When frozen by PyInstaller the package modules live in the archive; the web/
# assets are unpacked under _MEIPASS/pacs/web instead.
if not os.path.isdir(WEB_DIR) and hasattr(sys, "_MEIPASS"):
    WEB_DIR = os.path.join(sys._MEIPASS, "pacs", "web")

# The manual, served from this appliance rather than from the internet. It is
# the same docs/manual/ that GitHub Pages publishes — one copy, not a fork —
# which is why the routes below mount it at /manual/ and nothing rewrites its
# markup. Every relative path in those pages then resolves against the
# dashboard: ../carino-clock.js, ../carino-lang.js, ../carino-navbar.js and
# ../favicon.webp land on this server's own copies (that is what the clock and
# the favicon in pacs/web/ are for), and the "back to Carino DICOM" link lands
# on the dashboard instead of on the marketing page. A page that renders
# identically in both places can only do so if neither copy is edited for the
# other, so nothing here may "fix" a path.
#
# Frozen and containerised builds unpack it beside the package; from a source
# checkout it is read out of the repository. A build that ships without it is
# not an error — the routes report it missing and the dashboard hides the link
# rather than offering a dead one.
_MANUAL_CANDIDATES = (
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "manual"),
    os.path.join(getattr(sys, "_MEIPASS", ""), "manual") if hasattr(sys, "_MEIPASS") else "",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "manual"),
)
MANUAL_DIR = next(
    (p for p in _MANUAL_CANDIDATES
     if p and os.path.isfile(os.path.join(p, "index.html"))),
    "",
)


def create_app(server: PacsServer) -> Flask:
    from . import dicomweb          # pulls pydicom in; keep it off the CLI's import path

    app = Flask(__name__, static_folder=None)

    # ---- authentication ---------------------------------------------------
    # No-op while web.auth_token is empty — which config validation only permits
    # while web.host is loopback. The moment the dashboard is bound anywhere
    # reachable, a token is mandatory and every /api and /dicom-web route needs
    # it. Registered BEFORE the write guard on purpose: an unauthenticated
    # request must answer 401-with-a-prompt, not 403-missing-header, or the
    # dashboard shows the operator the wrong recovery path. The static UI is
    # left open so the token prompt can actually render — justified in auth.py.
    # The audit sink goes in here rather than being wired up afterwards: login,
    # a failed login and logout are the three records that have to exist before
    # anything else can be attributed to anybody, and they happen inside the
    # endpoints auth.install() owns.
    guard = auth.install(app, server.cfg, log=server.log, audit_log=server.audit)
    # The guard is otherwise trapped in this closure, and it is the only object
    # that knows whether a request arrived authenticated. Parking it on the app
    # is Flask's own idiom for exactly that and costs nothing.
    app.extensions["carino_auth"] = guard

    # ---- cross-site write protection --------------------------------------
    # The API is localhost-only and (by default) unauthenticated, so the one
    # realistic attack is a cross-site request fired from a web page the
    # operator has open: multipart forms and no-cors POSTs never trigger a CORS
    # preflight, which is how /api/shutdown or /api/studies/attach could be hit
    # remotely. Requiring a custom header on every write forces a preflight that
    # no foreign origin passes, with zero auth ceremony for the dashboard.
    #
    # /dicom-web is exempt because a conforming DICOMweb client cannot send the
    # header and STOW-RS would be dead on arrival. That does not reopen the hole:
    # STOW only accepts multipart/related, which is not a CORS-safelisted
    # content type, so a cross-site POST there already has to survive a preflight
    # the blueprint answers only for the origins in dicomweb.cors_origins.
    @app.before_request
    def _require_write_header():
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        if request.path == "/dicom-web" or request.path.startswith("/dicom-web/"):
            return None
        if request.headers.get("X-Carino") != "1":
            return jsonify(ok=False, message="missing X-Carino header"), 403
        return None

    # ---- DICOMweb (QIDO-RS / WADO-RS / STOW-RS) ---------------------------
    # Registered unconditionally and gated per-request on dicomweb.enabled
    # inside the blueprint (it answers 503 while off). Gating the *registration*
    # would mean an operator ticking the box in Settings has to restart the
    # engine before a viewer can connect, and every other service in this app
    # applies from config with no restart.
    bp = dicomweb.create_blueprint(server)
    app.register_blueprint(bp)          # the blueprint already carries url_prefix="/dicom-web"
    server.dicomweb = bp.stats          # so status() can report the counters

    @app.before_request
    def _guard_dicomweb():
        """Capability gate for /dicom-web, and a hard stop for restricted profiles.

        Registered after auth.install()'s guard, so a request without a
        credential is already a 401 by the time it gets here and this only ever
        sees somebody identified.

        The second half is the uncomfortable one and it is deliberate. QIDO
        answers in DICOM tag keys (00100010, not patient_name) and WADO-RS
        answers raw Part 10 bytes, so the identifier redactor that covers the
        dashboard cannot reach either — de-identification in this appliance is
        something that happens on FORWARD, driven by a routing rule, and there
        is no scrub on the retrieval path at all. A profile that may not see a
        patient's name would therefore be handed it in full by a single QIDO
        query, and the dashboard would be the only place the restriction held.

        Rather than let a per-field policy be true on one surface and false on
        another, a restricted profile does not get DICOMweb. It is refused out
        loud, naming what it would take, because the operator has to be able to
        tell this apart from an outage. The alternative — quietly serving the
        identifiers — is the failure this whole feature exists to prevent.
        """
        path = request.path
        if not (path == "/dicom-web" or path.startswith("/dicom-web/")):
            return None
        if request.method == "OPTIONS":
            return None
        if not guard.profiles_enabled:
            return None
        who = guard.identify(headers=request.headers, cookies=request.cookies)
        write = request.method in ("POST", "PUT", "PATCH", "DELETE")
        denied = guard.deny("studies.send" if write else "studies.read")
        if denied:
            return denied
        if who.phi_visible() < frozenset(users.PHI_FIELDS):
            withheld = sorted(frozenset(users.PHI_FIELDS) - who.phi_visible())
            return jsonify({
                "ok": False,
                "error": "not permitted",
                "forbidden": {
                    "capability": "phi.all",
                    "profile": who.name,
                    "withheld": withheld,
                },
                "detail": "DICOMweb returns DICOM datasets, which carry identifiers in "
                          "the data itself — there is no redaction on the retrieval "
                          "path, only on forwarding. A profile that may not see "
                          f"{', '.join(withheld)} cannot be served here without "
                          "handing them over anyway. Use the dashboard, or ask an "
                          "administrator to widen this profile.",
            }), 403
        return None

    # ---- static UI --------------------------------------------------------
    @app.get("/")
    def index():
        return send_from_directory(WEB_DIR, "index.html")

    # Bundled DICOM-editor (served same-origin so the ✎ Edit deep-link needs no
    # CORS / mixed-content / PNA gymnastics). Sub-assets fall through to the
    # catch-all below; only the trailing-slash index needs its own route so the
    # editor's relative <script> paths resolve under /editor/.
    @app.get("/editor")
    def editor_redirect():
        return redirect("/editor/", code=301)

    @app.get("/editor/")
    def editor_index():
        return send_from_directory(os.path.join(WEB_DIR, "editor"), "index.html")

    # The manual. Public on purpose: it is the document that explains the token
    # rule, so gating it behind the token it explains would be a locked door
    # with the key inside. It carries no patient data and no configuration —
    # only the same pages the project publishes on the web.
    @app.get("/manual")
    def manual_redirect():
        return redirect("/manual/", code=301)

    @app.get("/manual/")
    def manual_index():
        if not MANUAL_DIR:
            return _manual_absent()
        return send_from_directory(MANUAL_DIR, "index.html")

    # Sub-paths need their own rule rather than the catch-all below, which only
    # ever looks inside WEB_DIR: the language directories, manual.css and every
    # figure live outside it. send_from_directory rejects traversal itself, so
    # a crafted filename cannot climb out of MANUAL_DIR.
    @app.get("/manual/<path:filename>")
    def manual_files(filename):
        if not MANUAL_DIR:
            return _manual_absent()
        # The translations are directories — /manual/es/, /manual/ja/ — and
        # send_from_directory serves files, so each needs its index.html named.
        # A static file server does this silently and the published site gets it
        # from GitHub Pages, which is why nothing in the markup asks for it.
        #
        # The redirect matters as much as the rewrite: every translated page
        # reaches its stylesheet as ../manual.css and the fleet scripts as
        # ../../, and those resolve against the DIRECTORY the browser thinks it
        # is in. Answering /manual/es without the trailing slash would put it in
        # /manual/, one level too high, and the page would arrive unstyled with
        # no navbar. Redirecting first costs one round trip and cannot be got
        # wrong later.
        # Containment is checked before the directory question is even asked.
        # send_from_directory refuses traversal on its own and is what actually
        # serves the bytes, but the branch below decides between a redirect and
        # an index.html on the strength of an isdir() — and that must never be
        # asked about a path that resolved outside the manual.
        root = os.path.realpath(MANUAL_DIR)
        target = os.path.realpath(os.path.join(root, filename))
        if target != root and not target.startswith(root + os.sep):
            return _manual_absent()
        if os.path.isdir(target):
            if not filename.endswith("/"):
                return redirect("/manual/" + filename + "/", code=301)
            return send_from_directory(MANUAL_DIR, filename + "index.html")
        return send_from_directory(MANUAL_DIR, filename)

    def _manual_absent():
        # A build that did not bundle docs/manual/. Said plainly, with the
        # address of the published copy, because the reader is looking at this
        # instead of the page they asked for.
        return jsonify(
            ok=False,
            message="This build does not carry the manual. It is published at "
                    "https://dicom.carino.systems/manual/",
        ), 404

    # The catch-all matches slashes, so it is the one rule that can shadow an
    # entire API tree. Werkzeug ranks a blueprint's static rules above a
    # converter rule and routes /dicom-web/studies correctly today, but that is
    # an implementation detail of the router — an unmatched or later-removed
    # endpoint under a reserved prefix would silently fall through to
    # send_from_directory and answer a modality with the dashboard's 404 page.
    # Naming the prefixes here makes the separation the code's, not the router's.
    # "manual" is listed for the same reason: if the rules above were ever
    # removed, a request for /manual/ must 404 rather than be answered from
    # WEB_DIR, where an attacker-supplied path is the only thing that could
    # match.
    _RESERVED = ("api", "dicom-web", "manual")

    @app.get("/<path:filename>")
    def static_files(filename):
        if filename.split("/", 1)[0] in _RESERVED:
            return jsonify(ok=False, message="no such endpoint"), 404
        return send_from_directory(WEB_DIR, filename)

    # ---- API --------------------------------------------------------------
    @app.get("/api/status")
    def api_status():
        """Deliberately NOT in auth.PUBLIC_PATHS. This payload carries the last
        received patient's name and ID, the last order's accession, every
        storage path, every destination's host/port/AE and the config file
        location — it is the single most disclosive endpoint in the app. The
        dashboard shell renders anonymously, but every tile stays empty until
        the operator logs in; app.js must call GET /api/auth first and prompt.

        Composed per profile rather than filtered in the browser. That is not a
        preference: this one payload carries the last patient's name and ID, the
        last order's accession, every storage path and every destination's
        host, port and AE title, and it is what fills all ten panels. Hiding a
        nav button in app.js would leave all of it sitting in the receptionist's
        browser, one devtools tab away. So the parts a profile has no capability
        for are never assembled into the response at all."""
        body = _status_for(guard.identify(headers=request.headers,
                                          cookies=request.cookies))
        body["auth"] = guard.status(headers=request.headers, cookies=request.cookies)
        return jsonify(app=APP_NAME, version=__version__, **body)

    # Which capability each top-level section of the status payload answers to.
    # A section named here is dropped entirely from the response when the caller
    # lacks it — not blanked, dropped, so nothing downstream can render a stale
    # shape. Anything NOT named is common ground: service up/down, counters,
    # uptime, disk, the setup state. Those carry no identifier and no address,
    # and a profile that cannot see whether the receiver is running cannot do
    # any job this appliance has.
    #
    # New section, new entry. The test that walks a live payload against this
    # table is what stops the next one from defaulting to visible — which is the
    # failure mode that matters here, since nobody notices an extra field going
    # out the way they notice a missing one.
    _STATUS_GATES = {
        "destinations":   "routing.read",   # host, port and AE of every node
        "routing":        "routing.read",
        "deid":           "routing.read",   # which nodes get scrubbed, and held
        "config_path":    "config.read",
        "config_problem": "config.read",
        "logs_dir":       "config.read",
        "host_ip":        "config.read",
        "host_ips":       "config.read",
        "disk":           "config.read",    # storage paths and free space
        "pending":        "studies.read",
        "stuck":          "studies.read",
        "index":          "studies.read",
        "ris":            "orders.read",    # carries the last order's identity
        "editor_url":     "studies.read",
        "audit":          "audit.read",
        # Carries the SMTP host and whether a signing key is set. Not secrets,
        # but infrastructure, and it belongs with the rest of the configuration
        # rather than on a receptionist's screen.
        "notify":         "config.read",
        # The disposable test archive: its AE title, its loopback ports and the
        # temp path it lives in. Only present at all when the process was
        # started with --dev-peer, and only for somebody who may work it.
        "dev_peer":       "devpeer.manage",
    }

    # Sections that survive the gate but still carry an identifier inside them:
    # the receiver's last stored instance, the watcher's last send. Redacted
    # per profile rather than dropped, because "a study arrived 4 seconds ago"
    # is exactly what a receptionist needs to see and the patient's name is not.
    def _status_for(profile) -> dict:
        body = server.status()
        # Recomposed for THIS person. server.status() cannot answer it: whether
        # the failover modal opens depends on who is asking, whether they are
        # someone emergency.notify names, and whether they have already
        # acknowledged this particular outage.
        if "emergency" in body:
            body["emergency"] = server.emergency.status(_as_profile(profile))
        out = {}
        for key, value in body.items():
            need = _STATUS_GATES.get(key)
            if need is None or profile.can(need):
                out[key] = value
        return users.redact(out, profile)

    def _as_profile(profile):
        """A Profile for the policy layer, or None when profiles are not in use.

        The emergency controller treats None as "one operator, everything
        permitted", which is what an appliance without profiles is. Passing the
        SERVICE_PROFILE stand-in instead would make it evaluate activate_by
        against a synthetic identity that matches nothing, and a policy naming a
        real radiologist would silently stop the token from activating anything.
        """
        if not guard.profiles_enabled:
            return None
        return profile

    def _profile_or_none():
        return _as_profile(guard.current())

    # ---- no secret is ever part of a config payload ------------------------
    # web.auth_token is the permanent shared secret for this whole API. It used
    # to be readable from GET /api/config, which meant a 12-hour session cookie
    # could upgrade itself into the secret — inverting the entire reason the
    # cookie exists (the token stays out of the browser, so an XSS or a rogue
    # extension steals at most a session that dies with the process).
    #
    # So the token leaves the server exactly once, in the response to the call
    # that MINTS it, to a caller that proved it already holds the current one.
    # Everywhere else it is a boolean.
    #
    # deid.secret is the other one, and it went out verbatim to the same cookie
    # holder for the same reason nobody looked. It is the HMAC site key behind
    # every pseudonymous UID and every date shift: holding it turns the exported
    # "ANON-..." set back into a lookup table — confirm a PatientID, re-link a
    # study across exports, recover the true dates. That makes it at least as
    # sensitive as the dashboard token (the token gets you this box; the key
    # gets you the archives that already left it), so it is redacted the same
    # way and set through the same proof-of-secret ceremony.
    #
    # Nothing else in the config is secret-shaped. Audited, and left verbatim on
    # purpose: scp/scu/print/mwl/qr tls_cert/tls_key/tls_ca are filesystem PATHS
    # (never contents — the dashboard has to show them so a typo is fixable, and
    # /api/status already reports every storage path); destinations carry only
    # name/host/port/aet/flags, with no credential field anywhere in the sender;
    # qr.move_destinations is host/port/aet; ris.allowed_hosts and *.allowed_aets
    # are access lists, not keys.
    @app.after_request
    def _withhold_identifiers(resp):
        """Strip identifiers this profile may not see from every JSON response.

        A choke point, deliberately, and not a call added to each handler. There
        are forty-odd endpoints and the ones that carry a patient name are not
        the obvious ones — /api/stuck names the study that will not send,
        /api/pending names the file waiting for review, /api/ris/orders is
        nothing but demographics. Redacting at each of them means the next
        endpoint someone adds leaks until a reviewer notices, and the whole
        point of a per-field policy is that it cannot be forgotten in one place.

        Costs nothing on the two paths that matter. An appliance with no
        profiles never enters the body of this function, so an existing install
        pays one boolean per request and behaves exactly as it did. A profile
        that may see every identifier — every administrator, and the radiologist
        and receptionist presets — skips it too, because there is nothing to
        take out.
        """
        if not guard.profiles_enabled:
            return resp
        if not (resp.is_json and 200 <= resp.status_code < 300):
            return resp
        who = guard.identify(headers=request.headers, cookies=request.cookies)
        if who.phi_visible() >= frozenset(users.PHI_FIELDS):
            return resp
        try:
            body = resp.get_json(silent=True)
        except Exception:
            return resp
        if body is None:
            return resp
        resp.set_data(json.dumps(users.redact(body, who)))
        return resp

    def _redacted(data: dict) -> dict:
        out = copy.deepcopy(data)
        web = out.get("web")
        if isinstance(web, dict):
            web.pop("auth_token", None)
            # The dashboard still has to render "a token is set" / "none yet",
            # and this is the whole of what it needs for that.
            web["auth_token_set"] = bool(auth_token_of(server.cfg.web))
        deid = out.get("deid")
        if isinstance(deid, dict):
            deid.pop("secret", None)
            deid["secret_set"] = bool(deid_secret_of(server.cfg.deid))
        # Profiles carry stored password material, and this document goes to
        # anyone holding config.read — which IT holds and which is deliberately
        # NOT auth.manage. A PBKDF2 record handed to someone who may not manage
        # accounts is an offline cracking target against their colleagues'
        # passwords, so the rows are replaced by their describe() form: the
        # administrator's editor gets everything it needs to render, and the
        # salt and hash never leave the file.
        # The list is also read-only through this endpoint (POST refuses to take
        # one), so nothing here is a value a Save has to be able to send back.
        # The notifier's webhook signing key and SMTP password. Same rule as the
        # other two secrets: never in a payload, replaced by a "_set" mirror so
        # the dashboard can render "configured / not configured" without ever
        # holding the value.
        notify = out.get("notify")
        if isinstance(notify, dict):
            live = notify_secrets_of(server.cfg.data.get("notify"))
            for section, field in (("webhook", "secret"), ("smtp", "password")):
                block = notify.get(section)
                if isinstance(block, dict):
                    block.pop(field, None)
                    block[field + "_set"] = bool(live[f"notify.{section}.{field}"])
        cfg_users = out.get("users")
        if isinstance(cfg_users, dict):
            cfg_users["profiles"] = _profiles_view()
        return out

    def _profiles_view() -> list:
        """The profile rows as GET /api/config publishes them.

        One function, because POST has to compare what it was handed against
        exactly this. A caller that GETs the document and posts it straight back
        is doing the documented thing, and refusing that would break every
        client that is not the dashboard — including the two suites in this repo
        that round-trip a config. Refusing a caller who posts something ELSE is
        the actual intent, and that is only expressible if both ends agree on
        what "unchanged" looks like.
        """
        return [p.describe() for p in users.profiles_of(server.cfg.users)]

    def _holds_the_token() -> bool:
        """Is this request carrying the token ITSELF, not just a session?

        A session cookie authenticates a browser; it must not be enough to read
        or replace the secret that issued it. When no token is configured at all
        there is nothing to prove — that is how the first one gets set.
        """
        if not guard.required:
            return True
        presented = auth.token_from_headers(request.headers)
        return bool(presented) and guard.verify_token(presented)

    # ---- optimistic concurrency -------------------------------------------
    # A Save posts a WHOLE document assembled from a page-load snapshot, so two
    # dashboards open on different sections do not merge: both get ok:true and
    # the later one reverts the earlier, silently. On this API that can mean a
    # destination, a routing rule or scp.enabled quietly going back — a study
    # stops being forwarded and nothing anywhere says why.
    #
    # cfg.version() fingerprints the stored document. GET publishes it as an
    # ETag; a POST carrying it back as If-Match is told (409) when it no longer
    # matches. It is OPTIONAL on purpose: the shipped dashboard does not send it
    # yet, and a Save that started failing on something the client does not send
    # would be a worse bug than the one being fixed. No If-Match = exactly the
    # old behaviour.
    #
    # A HEADER rather than a field in the document, for two reasons that pull
    # the same way. More than one client here posts back the body GET handed it
    # verbatim (pacs/web/tests' stuck-panel and dashboard-auth suites both do),
    # so a version living in that body would have turned those round-trips into
    # conflicts the day it shipped. And the alternative — accepting the field
    # and not checking it, to keep them working — is worse than the bug: a
    # client that believes its Save is guarded while nothing is guarding it.
    # A header is opt-in, explicit, and cannot be sent by accident.
    #
    # For app.js to opt in: keep `res.headers.get("ETag")` from the GET in
    # loadConfig(), send it as `If-Match` on the POST in saveConfig(), and treat
    # 409 as "reload and reapply" — never as a retry, which would re-apply the
    # stale document the check just refused. An ETag does not survive an engine
    # restart (cfg.version() keys the two secrets per process, so covering them
    # cannot leak them — see _VERSION_KEY in config.py), so that 409 has to be a
    # reload path a tab can take at any moment, not an error dialog.
    _VERSION_FIELD = "config_version"
    # Keeps two whole applies from interleaving. It is NOT what makes the
    # check-and-apply atomic any more — the config lock is, because the version
    # check now happens inside the same critical section as the merge and the
    # write (see _merge below), which is the only place it can be safe from a
    # token rotation rather than merely safe from another Save. What this still
    # buys is the bounce: apply_config stops and restarts services outside the
    # config lock, and two of those running through each other is a receiver
    # started from one config and stopped by the other. Nothing else takes this
    # lock, and nothing takes it while holding the config lock, so the two
    # cannot deadlock against each other.
    _save_lock = threading.Lock()

    class _Refused(Exception):
        """A refusal decided INSIDE the config lock, carried out to the client.

        The token check, the site-key check and the If-Match check all need the
        stored document, and the whole point of this round is that they must
        read it under the lock that the apply itself holds. They therefore run
        inside _merge, where returning a Flask response is not possible — so
        they raise this and api_set_config turns it into the response. Raised
        before apply_config has touched anything, so nothing is left half-applied.
        """

        def __init__(self, status: int, body: dict):
            super().__init__(body.get("error", ""))
            self.status = status
            self.body = body

    def _tagged(resp):
        """Stamp a config response with the fingerprint of what is now stored."""
        resp.headers["ETag"] = f'"{server.cfg.version()}"'
        return resp

    @app.get("/api/config")
    def api_get_config():
        denied = guard.deny("config.read")
        if denied:
            return denied
        # The body is untouched — every client that posts this document straight
        # back must keep working, and the version rides in the ETag instead.
        # Deliberately not made conditional: a 304 with no body here would leave
        # the dashboard rendering an empty config.
        return _tagged(jsonify(_redacted(server.cfg.data)))

    @app.post("/api/config")
    def api_set_config():
        # config.write is the floor, not the whole answer. This endpoint takes a
        # WHOLE document, so it is the one place where a capability someone does
        # hold reaches sections gated behind two they do not: the profile list
        # (auth.manage) and the de-identification profile (deid.manage). Both
        # are re-checked against what is actually being changed, down in
        # _merge() where the stored document is in hand and a comparison is
        # possible. Without that, config.write silently means "grant yourself
        # admin" and "turn the scrub off", and IT holds config.write.
        denied = guard.deny("config.write")
        if denied:
            return denied
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(error="expected a JSON config object"), 400
        expected = request.headers.get("If-Match") or None
        # Said out loud rather than ignored, exactly as a token posted here is:
        # a caller that put the version in the document believes its Save is
        # being checked, and silently not checking it is the false assurance
        # this whole endpoint is meant to remove. GET never emits this key, so
        # no existing client can trip it.
        if _VERSION_FIELD in data:
            return jsonify(error=f"'{_VERSION_FIELD}' is not a config field — send the version "
                                 f"from the GET's ETag in an If-Match header instead, so a Save "
                                 f"built on a stale copy is refused rather than applied."), 400
        web = data.get("web")
        if web is None:
            web = {}
            data["web"] = web
        if not isinstance(web, dict):
            return jsonify(error="'web' must be an object"), 400
        web.pop("auth_token_set", None)          # a read-only mirror, not a config field
        deid = data.get("deid")
        if deid is None:
            deid = {}
            data["deid"] = deid
        if not isinstance(deid, dict):
            return jsonify(error="'deid' must be an object"), 400
        deid.pop("secret_set", None)        # a read-only mirror, not a config field

        # Everything that has to see the STORED document — the two secrets and
        # the If-Match check — happens in here, and apply_config runs it inside
        # the same cfg.mutate() that swaps and writes.
        #
        # It used to happen above, out in the open, and that was the bug. The
        # stored token and site key were read outside any lock and re-asserted
        # into a document applied some time later, so a rotation that landed in
        # between was written straight back out of existence — while POST
        # /api/auth/token had already answered 200 and told the operator the old
        # token was dead. Measured by restoring that shape and running the
        # rotation hammer in tests/test_web_auth.py against it: 15 and 16 of 40
        # rotations reverted, over two runs. An operator who rotates because
        # they believe the token is compromised, is told it worked, and is still
        # running the old one is worse off than one who got an error.
        #
        # The If-Match check moved in for the same reason and is not merely
        # tidiness: with the check outside, a rotation could land between the
        # comparison and the write, and the version compared against would be
        # one the config no longer had.
        def _merge(stored: dict) -> dict:
            if expected is not None:
                # An If-Match carries the tag quoted, and may weak-mark it.
                # Nobody is refused over punctuation. "*" is the RFC's "as long
                # as something is there", which a config always is.
                tag = expected.strip()
                if tag.startswith("W/"):
                    tag = tag[2:]
                tag = tag.strip('"')
                if tag != "*" and tag != server.cfg.version():
                    # 409, not the 412 an If-Match usually earns: 412 reads as
                    # "your header was wrong" and invites a blind retry, which
                    # here would apply the very document just refused. This is a
                    # conflict — the edits have to be rebuilt on top of someone
                    # else's change, by someone who has seen it.
                    raise _Refused(409, dict(
                        ok=False, code="stale_config",
                        error="this config changed since you loaded it — reload and reapply. "
                              "Someone else saved in the meantime (another dashboard, the setup "
                              "chooser, the token or site-key endpoint, or an edit to "
                              "config.json), and applying this document would silently revert "
                              "their change."))
            # The stored token wins, always. An absent key is the normal case
            # (the dashboard is posting back what GET gave it, which has no
            # token in it) and it must mean "keep", never "clear" — a Save that
            # silently blanked the token would drop the dashboard's only
            # credential on a LAN-bound install and lock the operator out of
            # their own PACS. Anything else is refused out loud rather than
            # ignored: a caller trying to set a value here has the wrong
            # endpoint, and should be told so.
            token = auth_token_of(stored.get("web"))
            incoming = web.get("auth_token")
            if incoming is not None and not (isinstance(incoming, str)
                                             and incoming.strip() == token):
                raise _Refused(400, dict(
                    error="web.auth_token cannot be set from here — it is redacted from "
                          "GET /api/config so a Save has nothing to send back. "
                          "Use POST /api/auth/token to rotate it."))
            web["auth_token"] = token
            # Same treatment for the de-identification site key, and the "keep"
            # case is the one that bites: deid.secret is not in DEFAULTS, so a
            # dashboard Save posting back a redacted GET would merge over a
            # config with no secret in it and silently drop the key. Everything
            # exported after that gets different pseudonyms and different date
            # shifts — the old exports stop lining up with the new ones and
            # nothing says why.
            secret = deid_secret_of(stored.get("deid"))
            offered = deid.get("secret")
            if offered is not None and not (isinstance(offered, str)
                                            and offered.strip() == secret):
                raise _Refused(400, dict(
                    error="deid.secret cannot be set from here — it is redacted from "
                          "GET /api/config so a Save has nothing to send back, and "
                          "changing it re-pseudonymises every future export. "
                          "Use POST /api/deid/secret."))
            if secret:
                deid["secret"] = secret
            else:
                deid.pop("secret", None)    # never write an empty key into the file

            # The notifier's two secrets, by the same rule as the site key and
            # with the same failure if it is skipped. Both ARE in DEFAULTS as
            # "", so a Save that posts back a redacted GET does not merely drop
            # them — it merges an empty string over them and silently
            # unconfigures the webhook signature and the SMTP login. The next
            # emergency then either fails to notify or posts unsigned, and the
            # only symptom is that nobody was told.
            stored_notify = stored.get("notify") if isinstance(stored.get("notify"), dict) else {}
            live_secrets = notify_secrets_of(stored_notify)
            incoming_notify = data.get("notify")
            if isinstance(incoming_notify, dict):
                for section, field in (("webhook", "secret"), ("smtp", "password")):
                    block = incoming_notify.get(section)
                    if not isinstance(block, dict):
                        continue
                    block.pop(field + "_set", None)   # a read-only mirror, not a field
                    kept = live_secrets[f"notify.{section}.{field}"]
                    offered = block.get(field)
                    if offered is not None and offered != kept:
                        raise _Refused(400, dict(
                            error=f"notify.{section}.{field} cannot be set from here — it is "
                                  f"redacted from GET /api/config so a Save has nothing to "
                                  f"send back. Use POST /api/notify/secret."))
                    if kept:
                        block[field] = kept
                    else:
                        block.pop(field, None)

            # ---- the two escalation paths out of config.write ----------------
            # Both are checked HERE rather than at the top of the handler,
            # because both are questions about a DIFFERENCE and the stored
            # document only exists inside this lock. Asking earlier would have
            # meant comparing against a copy read outside it — the precise shape
            # that lost 15 of 40 token rotations before this function was moved
            # in here.
            #
            # The profile list is re-asserted, never taken. Two separate reasons,
            # either sufficient: a caller with config.write could otherwise post
            # themselves an admin row and hold every capability a moment later;
            # and cfg.replace() merges over DEFAULTS, where users.profiles is [],
            # so a dashboard Save that simply does not carry the section — which
            # is every Save built from a page-load snapshot of a redacted GET —
            # would delete every profile on the appliance and turn access
            # control off. Editing goes through /api/profiles, which asks for
            # auth.manage.
            stored_users = copy.deepcopy(stored.get("users", {}))
            offered_users = data.get("users")
            if offered_users is not None:
                # Two shapes are accepted and mean the same thing: no `users` at
                # all (the dashboard, which does not carry it), and the exact
                # document GET published (any client that round-trips the
                # config). Only `profiles` is compared loosely — list_profiles
                # is an ordinary setting and stays editable here.
                echoed = dict(offered_users)
                echoed_profiles = echoed.pop("profiles", None)
                if echoed_profiles is not None and echoed_profiles != _profiles_view():
                    raise _Refused(400, dict(
                        error="users.profiles cannot be set from here — profiles are "
                              "published in a redacted form by GET /api/config, so a Save "
                              "has nothing to send back, and taking them from this "
                              "endpoint would let config.write grant itself anything. "
                              "Use the profile endpoints under /api/profiles."))
                for key, value in echoed.items():
                    stored_users[key] = value
            data["users"] = stored_users

            # The de-identification PROFILE is not a secret, so it survives the
            # GET and a Save legitimately carries it back unchanged. Only a
            # change needs deid.manage: turning the profile off is how a study a
            # rule promised to scrub reaches a research node identified, and
            # that decision is not part of "edit the config".
            stored_deid = stored.get("deid") if isinstance(stored.get("deid"), dict) else {}
            changed = {k: v for k, v in deid.items()
                       if k not in ("secret", "secret_set") and stored_deid.get(k) != v}
            missing = [k for k in stored_deid
                       if k not in ("secret",) and k not in deid]
            if (changed or missing) and not guard.current().can("deid.manage"):
                raise _Refused(403, dict(
                    ok=False, error="not permitted",
                    forbidden={"capability": "deid.manage",
                               "fields": sorted(set(changed) | set(missing))},
                    detail="this Save changes de-identification, which decides whether a "
                           "study a routing rule promised to scrub is sent identified. "
                           "It needs deid.manage, which this profile does not hold."))
            return data

        with _save_lock:
            try:
                server.apply_config(edit=_merge)
            except _Refused as refusal:
                # 409 carries the CURRENT fingerprint so the client's reload has
                # something to compare against; the 400s are plain refusals.
                resp = jsonify(**refusal.body)
                return (_tagged(resp) if refusal.status == 409 else resp), refusal.status
            except ValueError as exc:          # invalid config
                return jsonify(error=str(exc)), 400
            except OSError as exc:             # e.g. TLS cert/key unreadable, port in use
                return jsonify(error=f"could not apply config: {exc}"), 400
            # The new fingerprint rides out on the response, so a client that
            # sent one can keep saving without a re-GET between every Save.
            return _tagged(jsonify(ok=True, config=_redacted(server.cfg.data)))

    @app.post("/api/auth/token")
    def api_auth_token():
        """Rotate, set or clear web.auth_token — the only path that touches it.

        Body: {"action": "rotate"}                 mint a fresh 256-bit token
              {"action": "set", "token": "..."}    adopt one the operator chose
              {"action": "clear"}                  remove it (loopback host only)

        Requires the CURRENT token in an Authorization: Bearer / X-Carino-Token
        header, not the session cookie: replacing a secret has to be proof of
        holding it. Rotating changes the fingerprint every session was signed
        with, so every logged-in browser (including the caller's) is signed out
        the moment this returns — that is the point of a rotation, and the
        dashboard should say so before it fires.
        """
        denied = guard.deny("auth.manage")
        if denied:
            return denied
        if not _holds_the_token():
            return jsonify(ok=False, error="send the current token in an Authorization: Bearer "
                                           "or X-Carino-Token header — a session cookie is not "
                                           "enough to change the token it was issued from."), 403
        d = request.get_json(silent=True) or {}
        action = str(d.get("action") or "").strip().lower()
        minted = ""
        if action == "rotate":
            value = minted = auth.generate_token()
        elif action == "set":
            value = d.get("token")
            if not isinstance(value, str) or not value.strip():
                return jsonify(ok=False, error="'token' must be a non-empty string"), 400
            value = value.strip()
            # A token an operator invents is the weak link; 12 characters is the
            # floor at which a network guess stops being trivial. Generated ones
            # are 43.
            if len(value) < 12:
                return jsonify(ok=False, error="that token is too short to protect a network-"
                                               "reachable API — use at least 12 characters, or "
                                               "{\"action\":\"rotate\"} to get a generated one."), 400
        elif action == "clear":
            host = web_host_of(server.cfg.web)
            if not is_loopback_host(host):
                return jsonify(ok=False, error=f"web.host is '{host}', which is reachable from the "
                                               "network — clearing the token would serve patient "
                                               "data and /api/shutdown to anyone who can route "
                                               "here. Set web.host back to 127.0.0.1 first."), 400
            value = ""
        else:
            return jsonify(ok=False, error="action must be rotate|set|clear"), 400

        # Everything from the read of the current document to the save runs under
        # mutate(). Without it a POST /api/config landing in the gap swaps
        # cfg.data out, our write lands on the document nobody holds any more,
        # and the save that follows writes the OLD token back while this returns
        # ok:true — the operator is told the previous token is dead and it is
        # not. The lock is re-entrant, so save() re-taking it here is free.
        with server.cfg.mutate():
            candidate = copy.deepcopy(server.cfg.data)
            candidate.setdefault("web", {})["auth_token"] = value
            try:
                server.cfg.would_accept(candidate)
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            previous = server.cfg.web.get("auth_token", "")
            server.cfg.web["auth_token"] = value
            try:
                server.cfg.save()
            except OSError as exc:
                # Rolled back on purpose: a token enforced in memory but not on
                # disk survives until the next restart and then reverts, which is
                # the worst of both — the operator holds a token that stops
                # working.
                server.cfg.web["auth_token"] = previous
                return jsonify(ok=False, error=f"could not save the token: {exc}"), 400
        server.log.info("Dashboard token " + ("cleared" if not value else
                                              ("rotated" if minted else "changed")),
                        kind="auth")
        body = {"ok": True, "auth_token_set": bool(value),
                "message": ("Token cleared — the dashboard API is open to this machine again."
                            if not value else
                            "Token saved. Every logged-in browser is signed out; log in again "
                            "with the new token.")}
        if minted:
            # Shown once, to the caller that asked for it. It is not in any other
            # response, not in the log, and not in a URL.
            body["token"] = minted
        return jsonify(body)

    @app.post("/api/deid/secret")
    def api_deid_secret():
        """Set or clear deid.secret — the only path that touches the site key.

        Body: {"action": "set", "secret": "..."}   adopt a site key
              {"action": "clear"}                  remove it

        Requires the token itself, not the session cookie, exactly as the token
        endpoint does: this key is the difference between a pseudonym and a
        lookup table, and a cookie must not be enough to read it, replace it or
        throw it away. There is deliberately no "rotate": a fresh key is not a
        harmless refresh, it re-pseudonymises everything from here on and the
        studies already exported stop lining up with the ones that follow. That
        has to be a value the operator chose and wrote down, not a button.
        """
        denied = guard.deny("deid.manage")
        if denied:
            return denied
        if not _holds_the_token():
            return jsonify(ok=False, error="send the current dashboard token in an Authorization: "
                                           "Bearer or X-Carino-Token header — a session cookie is "
                                           "not enough to change the de-identification site "
                                           "key."), 403
        d = request.get_json(silent=True) or {}
        action = str(d.get("action") or "").strip().lower()
        if action == "set":
            value = d.get("secret")
            if not isinstance(value, str) or not value.strip():
                return jsonify(ok=False, error="'secret' must be a non-empty string"), 400
            value = value.strip()
            # Nobody guesses this over the network — it is attacked offline, by
            # someone holding an export and a guess at a PatientID, who only has
            # to re-derive the HMAC to confirm the patient is in the set. A short
            # key makes that search trivial, so it gets the same floor as the
            # token.
            if len(value) < 12:
                return jsonify(ok=False, error="that site key is too short — it is attacked offline "
                                               "against a known Patient ID, so use at least 12 "
                                               "characters. Generate one with: python3 -c "
                                               "\"import secrets; print(secrets.token_urlsafe(32))\""), 400
        elif action == "clear":
            value = ""
        else:
            return jsonify(ok=False, error="action must be set|clear"), 400

        # Under mutate() for the same reason the token endpoint is, and the cost
        # of losing this one is higher: a Save landing in the gap discards the
        # key while this answers ok:true, so the operator writes the new site key
        # down, restarts, and every export from then on carries pseudonyms
        # derived from the old one — two sets of exports that will not line up
        # and nothing recording which key made which.
        with server.cfg.mutate():
            candidate = copy.deepcopy(server.cfg.data)
            candidate.setdefault("deid", {})["secret"] = value
            try:
                server.cfg.would_accept(candidate)
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            previous = server.cfg.deid.get("secret", "")
            if value:
                server.cfg.deid["secret"] = value
            else:
                server.cfg.deid.pop("secret", None)
            try:
                server.cfg.save()
            except OSError as exc:
                # Rolled back for the same reason the token is: a key that is
                # live in memory but not on disk pseudonymises today's exports
                # one way and tomorrow's (after a restart) another, with nothing
                # to point at.
                if previous:
                    server.cfg.deid["secret"] = previous
                else:
                    server.cfg.deid.pop("secret", None)
                return jsonify(ok=False, error=f"could not save the site key: {exc}"), 400
        # The key itself never reaches the log — only the fact that it moved.
        server.log.info("De-identification site key " + ("cleared" if not value else
                                                         ("changed" if previous else "set")),
                        kind="deid")
        return jsonify(ok=True, secret_set=bool(value),
                       message=("Site key cleared — pseudonyms are now a pure function of the "
                                "input, so anyone who can guess a Patient ID can confirm it is "
                                "in your exported set."
                                if not value else
                                "Site key saved. Studies exported from now on carry different "
                                "pseudonyms and date shifts than the ones exported before it "
                                "changed; they will not line up."))

    @app.post("/api/notify/secret")
    def api_notify_secret():
        """Set or clear the webhook signing key and the SMTP password.

        Body: {"field": "webhook"|"smtp", "action": "set"|"clear", "value": "..."}

        Its own endpoint for the same reason deid.secret has one: both are
        redacted out of GET /api/config, so a Save has nothing to send back and
        must be refused rather than allowed to blank them. Unlike the site key
        this does NOT demand the raw token — neither secret can be used to read
        patient data or to reach anything on this appliance, and requiring the
        token would mean an administrator cannot configure e-mail from the
        dashboard they are already logged into.
        """
        denied = guard.deny("config.write")
        if denied:
            return denied
        d = request.get_json(silent=True) or {}
        field = str(d.get("field") or "").strip().lower()
        if field not in ("webhook", "smtp"):
            return jsonify(ok=False, error="field must be webhook|smtp"), 400
        key = "secret" if field == "webhook" else "password"
        action = str(d.get("action") or "").strip().lower()
        if action == "set":
            value = d.get("value")
            if not isinstance(value, str) or not value:
                return jsonify(ok=False, error=f"'value' must be a non-empty string"), 400
        elif action == "clear":
            value = ""
        else:
            return jsonify(ok=False, error="action must be set|clear"), 400

        with server.cfg.mutate():
            block = server.cfg.data.setdefault("notify", {}).setdefault(field, {})
            previous = block.get(key, "")
            block[key] = value
            try:
                server.cfg.save()
            except OSError as exc:
                block[key] = previous
                return jsonify(ok=False, error=f"could not save: {exc}"), 400
        # The value never reaches the log or the audit trail — only that it moved.
        server.log.info(
            f"notify.{field}.{key} " + ("cleared" if not value else
                                        ("changed" if previous else "set")),
            kind="notify")
        return jsonify(ok=True, configured=bool(value))

    @app.post("/api/setup")
    def api_setup():
        """The service chooser's Apply: enrol the picked services and stamp the
        run, in one save. A service that then fails to bind is a 200 with a
        failed row — enrolled-but-not-running is a state the dashboard shows,
        not a bad request."""
        denied = guard.deny("config.write")
        if denied:
            return denied
        d = request.get_json(silent=True) or {}
        try:
            res = server.apply_setup(d.get("services") or {})
        except ValueError as exc:          # invalid candidate config
            return jsonify(error=str(exc)), 400
        except OSError as exc:             # e.g. config file unwritable
            return jsonify(error=f"could not save setup: {exc}"), 400
        return jsonify(res)

    @app.post("/api/portcheck")
    def api_portcheck():
        """Are these DICOM ports bindable on this machine? POST, not GET, on
        purpose: the write-header guard only covers non-GET, and a GET here
        would hand any page the operator has open a port probe against their
        own loopback."""
        denied = guard.deny("services.control")
        if denied:
            return denied
        items = (request.get_json(silent=True) or {}).get("ports")
        if not isinstance(items, list):
            return jsonify(error="expected a 'ports' array"), 400
        return jsonify(server.check_ports(items))

    # Registered unconditionally and answering 404 when the flag was not given,
    # rather than registered conditionally. Two reasons. An unregistered POST
    # falls through to the GET catch-all at the bottom of this file and comes
    # back 405, which reads as "you used the wrong method" rather than "this
    # build has no such thing". And the capability gate has to run FIRST, so a
    # profile that may not do this is never told whether the feature exists.
    #
    # There is no later Settings checkbox for this to grow into either:
    # --dev-peer is process-lifetime by design, and a restart is the only way to
    # change it.
    def _peer_or_404():
        if server.dev_peer is None:
            return jsonify(ok=False,
                           error="this engine was not started with --dev-peer"), 404
        return None

    @app.get("/api/dev-peer")
    def api_dev_peer_get():
        denied = guard.deny("devpeer.manage")
        if denied:
            return denied
        missing = _peer_or_404()
        if missing:
            return missing
        return jsonify(ok=True, dev_peer=server.dev_peer.status())

    @app.post("/api/dev-peer")
    def api_dev_peer():
        """Create or discard the disposable second archive.

        No explicit audit.record() call: the after_request recorder below
        already records every mutating /api/* call with the real outcome, and
        _TARGET_FIELDS includes "action", so the record reads `action=create`
        for free. A second record here would double every line.
        """
        denied = guard.deny("devpeer.manage")
        if denied:
            return denied
        missing = _peer_or_404()
        if missing:
            return missing
        action = (request.get_json(silent=True) or {}).get("action")
        if action not in ("create", "discard"):
            return jsonify(ok=False, error="action must be create|discard"), 400
        if action == "discard":
            block = server.dev_peer.discard()
            return jsonify(ok=True, dev_peer=block,
                           message="Dev peer discarded. Any sends still stuck against it now "
                                   "have nowhere to retry — clear them in Studies → Stuck.")
        try:
            block = server.dev_peer.create()
        except ValueError as exc:      # one already running, a duplicate name, bad wiring
            return jsonify(ok=False, error=str(exc)), 400
        except OSError as exc:         # a port lost the race, or the temp folder is unwritable
            return jsonify(ok=False, error=f"could not start the dev peer: {exc}"), 400
        return jsonify(ok=True, dev_peer=block,
                       message=f"Dev peer {block['aet']} listening on "
                               f"127.0.0.1:{block['scp_port']}.")

    @app.post("/api/receiver")
    def api_receiver():
        denied = guard.deny("services.control")
        if denied:
            return denied
        action = (request.get_json(silent=True) or {}).get("action")
        try:
            if action == "start":
                server.start_receiver()
            elif action == "stop":
                server.stop_receiver()
            else:
                return jsonify(error="action must be start|stop"), 400
        except OSError as exc:
            return jsonify(error=f"could not start receiver: {exc}"), 400
        return jsonify(ok=True, receiver=server.status()["receiver"])

    @app.post("/api/printer")
    def api_printer():
        denied = guard.deny("services.control")
        if denied:
            return denied
        action = (request.get_json(silent=True) or {}).get("action")
        try:
            if action == "start":
                server.start_printer()
            elif action == "stop":
                server.stop_printer()
            else:
                return jsonify(error="action must be start|stop"), 400
        except OSError as exc:
            return jsonify(error=f"could not start print receiver: {exc}"), 400
        return jsonify(ok=True, printer=server.status()["printer"])

    @app.post("/api/ris")
    def api_ris():
        denied = guard.deny("services.control")
        if denied:
            return denied
        action = (request.get_json(silent=True) or {}).get("action")
        try:
            if action == "start":
                server.start_ris()
            elif action == "stop":
                server.stop_ris()
            else:
                return jsonify(error="action must be start|stop"), 400
        except OSError as exc:
            return jsonify(error=f"could not start RIS listener: {exc}"), 400
        return jsonify(ok=True, ris=server.status()["ris"])

    @app.post("/api/emergency")
    def api_emergency():
        denied = guard.deny("emergency.activate")
        if denied:
            return denied
        action = (request.get_json(silent=True) or {}).get("action")
        res = server.emergency_action(action, _profile_or_none())
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/mwl")
    def api_mwl():
        denied = guard.deny("services.control")
        if denied:
            return denied
        action = (request.get_json(silent=True) or {}).get("action")
        try:
            if action == "start":
                server.start_mwl()
            elif action == "stop":
                server.stop_mwl()
            else:
                return jsonify(error="action must be start|stop"), 400
        except OSError as exc:
            return jsonify(error=f"could not start worklist SCP: {exc}"), 400
        return jsonify(ok=True, mwl=server.status()["mwl"])

    @app.post("/api/qr")
    def api_qr():
        denied = guard.deny("services.control")
        if denied:
            return denied
        action = (request.get_json(silent=True) or {}).get("action")
        try:
            if action == "start":
                server.start_qr()
            elif action == "stop":
                server.stop_qr()
            else:
                return jsonify(error="action must be start|stop"), 400
        # ValueError as well as OSError: Q/R answers exclusively out of the
        # instance index and start_qr refuses to run without it. That is a
        # message the operator has to see, not a 500.
        except (OSError, ValueError) as exc:
            return jsonify(error=f"could not {action} Query/Retrieve SCP: {exc}"), 400
        return jsonify(ok=True, qr=server.status()["qr"])

    # ---- RIS orders (emergency RIS: intake + reconciliation) --------------
    @app.get("/api/ris/orders")
    def api_ris_orders():
        denied = guard.deny("orders.read")
        if denied:
            return denied
        status = request.args.get("status") or None
        return jsonify(server.list_orders(status))

    @app.post("/api/ris/orders")
    def api_ris_add_order():
        denied = guard.deny("orders.write")
        if denied:
            return denied
        d = request.get_json(silent=True) or {}
        res = server.add_order(d)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/ris/orders/update")
    def api_ris_update_order():
        denied = guard.deny("orders.write")
        if denied:
            return denied
        d = request.get_json(silent=True) or {}
        oid = d.get("id")
        if not oid:
            return jsonify(ok=False, message="missing 'id'"), 400
        res = server.update_order(oid, d)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/ris/orders/cancel")
    def api_ris_cancel_order():
        denied = guard.deny("orders.write")
        if denied:
            return denied
        oid = (request.get_json(silent=True) or {}).get("id")
        if not oid:
            return jsonify(ok=False, message="missing 'id'"), 400
        res = server.close_order(oid)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/ris/orders/delete")
    def api_ris_delete_order():
        denied = guard.deny("orders.write")
        if denied:
            return denied
        oid = (request.get_json(silent=True) or {}).get("id")
        if not oid:
            return jsonify(ok=False, message="missing 'id'"), 400
        res = server.delete_order(oid)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/ris/orders/purge")
    def api_ris_purge_orders():
        denied = guard.deny("orders.write")
        if denied:
            return denied
        return jsonify(server.purge_closed_orders())

    @app.post("/api/ris/orders/capture")
    def api_ris_capture():
        """Multipart: an order 'id' and a 'file' (PDF/JPEG/PNG) exported from a
        legacy tool, wrapped as a DICOM study inheriting the order's identity."""
        denied = guard.deny("orders.write")
        if denied:
            return denied
        oid = request.form.get("id")
        up = request.files.get("file")
        if not oid or up is None or not up.filename:
            return jsonify(ok=False, message="need an order 'id' and a 'file'"), 400
        res = server.create_study_from_order(oid, up.filename, up.read())
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/watcher")
    def api_watcher():
        denied = guard.deny("services.control")
        if denied:
            return denied
        action = (request.get_json(silent=True) or {}).get("action")
        if action == "start":
            server.start_watcher()
        elif action == "stop":
            server.stop_watcher()
        else:
            return jsonify(error="action must be start|stop"), 400
        return jsonify(ok=True, watcher=server.status()["watcher"])

    @app.post("/api/echo")
    def api_echo():
        denied = guard.deny("services.control")
        if denied:
            return denied
        dest = request.get_json(silent=True) or {}
        for k in ("host", "port", "aet"):
            if k not in dest:
                return jsonify(error=f"destination missing '{k}'"), 400
        res = server.echo(dest)
        return jsonify(ok=res.ok, message=res.message)

    @app.post("/api/worklist/probe")
    def api_worklist_probe():
        """Ask the other RIS what it would give one of our modalities.

        Gated on config.read rather than orders.read on purpose: this is
        infrastructure diagnosis, and the items that come back are another
        system's patients. The people who run this — IT and administrators —
        are not the people who key orders in."""
        denied = guard.deny("config.read")
        if denied:
            return denied
        body = request.get_json(silent=True) or {}
        station = str(body.get("station_aet", ""))
        res = server.probe_worklist(station)
        if res.get("ok") and server.audit:
            # The AE title borrowed and how much came back — never a patient
            # name. The audit trail is exported and read far more widely than
            # the pane the caught items themselves sit behind.
            server.audit.record(audit.WORKLIST_PROBED, actor=guard.current(), target=station,
                                detail=f"{res.get('items', 0)} item(s) from the other worklist")
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.get("/api/worklist/caught")
    def api_worklist_caught():
        denied = guard.deny("config.read")
        if denied:
            return denied
        return jsonify(rounds=server.caught.rounds(limit=int(request.args.get("limit", 0) or 0)),
                       counts=server.caught.counts())

    @app.post("/api/worklist/caught/clear")
    def api_worklist_caught_clear():
        denied = guard.deny("config.read")
        if denied:
            return denied
        n = server.caught.clear()
        return jsonify(ok=True, message=f"Cleared {n} probe round(s)")

    @app.get("/api/log")
    def api_log():
        denied = guard.deny("logs.read")
        if denied:
            return denied
        try:
            since = int(request.args.get("since", 0))
        except ValueError:
            since = 0
        return jsonify(last_seq=server.log.last_seq, entries=server.log.since(since))

    # ---- study history (received / sent) ----------------------------------
    @app.get("/api/studies")
    def api_studies():
        denied = guard.deny("studies.read")
        if denied:
            return denied
        group = request.args.get("group", "received")
        try:
            return jsonify(server.list_studies(group))
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    def _study_action(fn):
        d = request.get_json(silent=True) or {}
        path = d.get("path")
        if not path:
            return jsonify(ok=False, message="missing 'path'"), 400
        res = fn(d.get("group", "received"), path)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/studies/send")
    def api_studies_send():
        denied = guard.deny("studies.send")
        if denied:
            return denied
        return _study_action(server.send_study)

    @app.post("/api/studies/reveal")
    def api_studies_reveal():
        denied = guard.deny("studies.read")
        if denied:
            return denied
        return _study_action(server.reveal_study)

    @app.post("/api/studies/delete")
    def api_studies_delete():
        denied = guard.deny("studies.delete")
        if denied:
            return denied
        return _study_action(server.delete_study)

    @app.post("/api/studies/delete-all")
    def api_studies_delete_all():
        denied = guard.deny("studies.delete")
        if denied:
            return denied
        group = (request.get_json(silent=True) or {}).get("group", "received")
        res = server.delete_all_studies(group)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/studies/attach")
    def api_studies_attach():
        """Multipart: 'group', 'path', and a 'file' (PDF/JPEG/PNG) to wrap as a
        DICOM instance attached to that study."""
        denied = guard.deny("studies.send")
        if denied:
            return denied
        group = request.form.get("group", "received")
        path = request.form.get("path")
        up = request.files.get("file")
        if not path or up is None or not up.filename:
            return jsonify(ok=False, message="need a study 'path' and a 'file'"), 400
        res = server.attach_to_study(group, path, up.filename, up.read())
        return jsonify(res), (200 if res.get("ok") else 400)

    # ---- DICOM-editor deep-link (CORS restricted to the editor, GET-only) --
    # The editor may be a separate origin (a public HTTPS site like
    # dcm.carino.systems), so these two GET endpoints allow cross-origin
    # reads — but ONLY from the origin configured as web.editor_url. A
    # wildcard here would let any page the operator visits enumerate and
    # download stored studies from their localhost PACS. The bundled
    # same-origin editor ("/editor/") needs no CORS at all, so a relative or
    # empty editor_url emits no CORS headers. When the editor is a PUBLIC
    # page fetching this (private/localhost) PACS, Chrome's Private Network
    # Access sends a CORS preflight expecting
    # `Access-Control-Allow-Private-Network: true`, so we answer OPTIONS and
    # echo that header.
    #
    # What is deliberately NOT here is Access-Control-Allow-Credentials. Two
    # reasons, and they matter more once web.auth_token is set:
    #   * the session cookie is SameSite=Strict, so a browser will not attach it
    #     to a cross-site subresource request no matter what we allow. Sending
    #     Allow-Credentials would be a promise we cannot keep;
    #   * without it, a cross-origin editor can only read studies if it is
    #     holding the token deliberately. With it, ANY page on the configured
    #     editor origin — including one that has been XSS'd — reads the whole
    #     archive on the operator's ambient session. Requiring an explicit
    #     Authorization header is the weaker capability, so it is the right one.
    # This is also why Allow-Headers may stay "*": the wildcard is honoured for
    # non-credentialed requests only. Adding Allow-Credentials later would
    # silently stop Authorization from being allowed and break the editor in a
    # way that looks like a network fault. Note that ACAO is an exact origin and
    # never "*" — a wildcard would let any page the operator visits enumerate
    # and download their archive off localhost, token or no token, because a
    # bearer header is not a credential the browser withholds.
    #
    # Consequence to hand the operator: with a token set, a CROSS-ORIGIN editor
    # needs the token, and there is no safe way to give it one (a deep-link
    # query string is exactly the URL-logging leak the design forbids). The
    # answer is web.editor_url = "/editor/" — the bundled same-origin copy,
    # where _editor_origin() returns None and no CORS is emitted at all.
    def _editor_origin():
        url = (server.cfg.web.get("editor_url") or "").strip()
        p = urlsplit(url)
        if p.scheme in ("http", "https") and p.netloc:
            return f"{p.scheme}://{p.netloc}"
        return None

    def _cors(resp):
        origin = _editor_origin()
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Private-Network"] = "true"
            resp.headers["Vary"] = "Origin"
        return resp

    def _preflight():
        resp = app.make_default_options_response()
        origin = _editor_origin()
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "*"
            resp.headers["Access-Control-Allow-Private-Network"] = "true"
            resp.headers["Access-Control-Max-Age"] = "600"
            resp.headers["Vary"] = "Origin"
        return resp

    _EDITOR_ROUTES = ("/api/studies/files", "/api/studies/file")

    @app.after_request
    def _cors_on_auth_failure(resp):
        # The auth guard short-circuits in before_request, so its 401/429 never
        # passes through _cors() on the way out. Without this a cross-origin
        # editor sees an opaque network failure and cannot tell "log in" from
        # "the PACS is down" — the two recoveries are nothing alike.
        if resp.status_code in (401, 429) and request.path in _EDITOR_ROUTES:
            _cors(resp)
        return resp

    def _deny_unredactable():
        """Refuse a raw Part 10 hand-out to a profile that may not see every
        identifier, or "" when it is allowed.

        studies.read governs what the dashboard SHOWS, and everything it shows
        goes through _withhold_identifiers first. These two routes are the pair
        that leave that world: the payload is the file, the identifiers are
        inside its own header, and nothing on the way out can rewrite them. So a
        profile that is not permitted to read a patient's name on screen must not
        be handed the file that carries the name, the ID and the birth date.

        Same reasoning and the same answer as the audit export, which refuses for
        the same structural reason: what cannot be redacted cannot be narrowed,
        so the only honest gate is the whole of it.
        """
        who = guard.current()
        if who.phi_visible() >= frozenset(users.PHI_FIELDS):
            return ""
        return _cors(jsonify({
            "ok": False, "error": "not permitted",
            "forbidden": {"capability": "phi.all", "profile": who.name},
            "detail": "a DICOM file carries the identifiers in its own header and "
                      "cannot be redacted on the way out, so reading one needs "
                      "every identifier field. Open the study in the dashboard "
                      "instead, or ask an administrator.",
        })), 403

    @app.route("/api/studies/files", methods=["GET", "OPTIONS"])
    def api_studies_files():
        denied = guard.deny("studies.read")
        if denied:
            return denied
        if request.method == "OPTIONS":
            return _preflight()
        # Gated with its sibling below rather than left open: this route exists
        # only to enumerate URLs for it, so letting it answer would buy nothing
        # but a hand-off that fails one file at a time.
        refused = _deny_unredactable()
        if refused:
            return refused
        group = request.args.get("group", "received")
        path = request.args.get("path")
        if not path:
            return _cors(jsonify(ok=False, message="missing 'path'")), 400
        res = server.study_dicom_files(group, path)
        return _cors(jsonify(res)), (200 if res.get("ok") else 400)

    @app.route("/api/studies/file", methods=["GET", "OPTIONS"])
    def api_studies_file():
        denied = guard.deny("studies.read")
        if denied:
            return denied
        if request.method == "OPTIONS":
            return _preflight()
        refused = _deny_unredactable()
        if refused:
            return refused
        group = request.args.get("group", "received")
        path = request.args.get("path", "")
        name = request.args.get("name", "")
        fp = server.study_dicom_file(group, path, name)
        if not fp:
            return _cors(jsonify(error="not found")), 404
        return _cors(send_file(fp, mimetype="application/dicom",
                               as_attachment=False, download_name=os.path.basename(fp)))

    # ---- conditional routing ----------------------------------------------
    @app.get("/api/routing")
    def api_routing():
        """The rule list plus the names a rule may name. Destination names are
        the join key for routing, send state and the archive gate, so the editor
        has to pick from the live enabled set rather than free-text them.

        The field list is read off the router rather than restated here: a rule
        naming a field the matcher does not know is skipped entirely, so a UI
        working from a stale copy would build rules that silently never fire."""
        denied = guard.deny("routing.read")
        if denied:
            return denied
        from . import routing
        r = server.cfg.routing
        return jsonify(ok=True,
                       enabled=bool(r.get("enabled")),
                       rules=r.get("rules") or [],
                       destinations=[d.get("name", "") for d in server.cfg.enabled_destinations()],
                       fields=list(routing._MATCH_FIELDS))

    @app.post("/api/routing/test")
    def api_routing_test():
        """Dry-run the rules and return the per-rule trace, so an operator can
        see WHY a study went where it did before a modality proves it at 3am.

        Two ways to describe the file: 'attributes' (or the match fields at the
        top level) for a hypothetical study, or 'group' + 'path' to evaluate a
        study that is actually on disk. Read-only — nothing is sent, and
        explain() logs nothing, so this can be hammered from a form."""
        denied = guard.deny("routing.read")
        if denied:
            return denied
        from . import routing
        d = request.get_json(silent=True) or {}
        attrs = d.get("attributes")
        if attrs is None:
            attrs = {k: d[k] for k in routing._MATCH_FIELDS if k in d} or None
        if attrs is not None:
            if not isinstance(attrs, dict):
                return jsonify(ok=False, message="'attributes' must be an object"), 400
            # No log: an explain must never be able to flood the activity buffer.
            r = routing.Router.from_config(server.cfg, None)
            described = {str(k): str(v if v is not None else "") for k, v in attrs.items()}
            return jsonify(ok=True, **r.explain(attrs=described))
        path = d.get("path")
        if not path:
            return jsonify(ok=False, message="need 'attributes' or a study 'path'"), 400
        res = server.explain_route(d.get("group", "received"), path)
        return jsonify(res), (200 if res.get("ok") else 400)

    # ---- instance index (what Q/R and DICOMweb query) ---------------------
    @app.get("/api/index")
    def api_index():
        """The same block /api/status carries, on its own, so a dashboard panel
        can refresh it without pulling the whole disclosive status payload.
        index_status() caches the COUNT(DISTINCT) figures itself — do not
        substitute a raw index.stats() call here, it is not free at a million
        instances and this route is pollable."""
        denied = guard.deny("studies.read")
        if denied:
            return denied
        return jsonify(ok=True, index=server.index_status())

    @app.post("/api/index/rescan")
    def api_index_rescan():
        """Reconcile the index with what is on disk. The walk can take minutes
        on a real archive, so the server runs it on its own thread and this
        returns as soon as it is accepted; the outcome lands in the log."""
        denied = guard.deny("services.control")
        if denied:
            return denied
        res = server.rescan_index()
        return jsonify(res), (200 if res.get("ok") else 400)

    # ---- stuck sends (failed / backing-off forwards) ----------------------
    @app.get("/api/stuck")
    def api_stuck():
        denied = guard.deny("studies.read")
        if denied:
            return denied
        return jsonify(server.stuck_sends())

    @app.post("/api/stuck/retry")
    def api_stuck_retry():
        denied = guard.deny("studies.send")
        if denied:
            return denied
        dest = (request.get_json(silent=True) or {}).get("dest") or None
        res = server.retry_stuck(dest)
        return jsonify(res), (200 if res.get("ok") else 400)

    # ---- pending imports (non-DICOM awaiting review) ----------------------
    @app.get("/api/pending")
    def api_pending():
        denied = guard.deny("studies.read")
        if denied:
            return denied
        return jsonify(server.list_pending())

    @app.post("/api/pending/approve")
    def api_pending_approve():
        denied = guard.deny("studies.send")
        if denied:
            return denied
        d = request.get_json(silent=True) or {}
        pid = d.get("id")
        if not pid:
            return jsonify(ok=False, message="missing 'id'"), 400
        edits = {k: d.get(k) for k in ("patient", "patient_id", "study_desc", "series_desc", "study_date", "accession") if k in d}
        res = server.approve_pending(pid, edits)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.post("/api/pending/discard")
    def api_pending_discard():
        denied = guard.deny("studies.delete")
        if denied:
            return denied
        pid = (request.get_json(silent=True) or {}).get("id")
        if not pid:
            return jsonify(ok=False, message="missing 'id'"), 400
        res = server.discard_pending(pid)
        return jsonify(res), (200 if res.get("ok") else 400)

    @app.get("/api/pending/preview")
    def api_pending_preview():
        denied = guard.deny("studies.read")
        if denied:
            return denied
        pid = request.args.get("id", "")
        loc = server.pending_preview(pid)
        if not loc:
            return jsonify(error="not found"), 404
        folder, filename = loc
        return send_from_directory(folder, filename)

    @app.post("/api/shutdown")
    def api_shutdown():
        """Stop the workers and terminate the whole engine process."""
        denied = guard.deny("system.shutdown")
        if denied:
            return denied
        server.log.info("Shutdown requested from dashboard", kind="config")
        server.shutdown()

        def _exit():
            time.sleep(0.3)   # let this HTTP response flush first
            os._exit(0)

        threading.Thread(target=_exit, daemon=True).start()
        return jsonify(ok=True, message="Carino DICOM is shutting down")

    # ---- profiles ----------------------------------------------------------
    # Their own endpoints rather than a section of POST /api/config, for two
    # reasons argued at that handler: config.write would otherwise be a way to
    # grant yourself anything, and a Save built from a page-load snapshot would
    # silently delete every profile on the appliance.
    #
    # Every write here runs inside one cfg.mutate() that reads, edits, validates
    # and saves — the same critical section the token endpoint needed after a
    # concurrent Save was measured reverting 15 of 40 rotations.

    def _capabilities_catalogue() -> dict:
        return {
            "capabilities": [{"name": k, "description": v}
                             for k, v in sorted(users.CAPABILITIES.items())],
            "phi_fields": [{"name": k, "description": v}
                           for k, v in sorted(users.PHI_FIELDS.items())],
            "roles": users.roles_in_use(server.cfg.users),
        }

    @app.get("/api/profiles/manage")
    def api_profiles_manage():
        """The administrator's view: every row in full, plus what can be granted."""
        denied = guard.deny("auth.manage")
        if denied:
            return denied
        return jsonify(ok=True,
                       profiles=[p.describe() for p in users.profiles_of(server.cfg.users)],
                       in_use=users.profiles_in_use(server.cfg.users),
                       list_profiles=guard.lists_profiles(),
                       **_capabilities_catalogue())

    @app.post("/api/profiles/seed")
    def api_profiles_seed():
        """Turn profiles on, with the four presets.

        Refuses when any already exist. This is the one-way door from "the token
        is the only credential" into "people log in as themselves", and doing it
        twice would mean an administrator who clicked it again got four fresh
        presets alongside their real staff — including a brand new open
        Administrator.
        """
        denied = guard.deny("auth.manage")
        if denied:
            return denied
        with server.cfg.mutate():
            if users.profiles_of(server.cfg.users):
                return jsonify(ok=False,
                               error="profiles already exist on this appliance"), 400
            resp = _write_profiles(users.preset_profiles(), audit.PROFILE_CREATED,
                                   "seeded the four preset profiles")
        # Seeding is the moment guard.required flips on, so the request that
        # did it is the last one this caller can make without a session — the
        # very next poll comes back 401 and the dashboard empties. On an
        # appliance with no token set (loopback, which is the common case and
        # the one this feature is aimed at) they would have no credential at
        # all until they noticed the picker.
        #
        # So the act of turning profiles on logs you in as the administrator it
        # just created. Safe by construction: reaching here needed auth.manage,
        # which is strictly more authority than the session being handed back.
        if isinstance(resp, tuple):
            return resp
        admin = next((p for p in users.enabled_profiles(server.cfg.users) if p.admin), None)
        if admin is None:
            return resp
        return auth.set_session_cookie(resp, guard, admin)

    @app.post("/api/profiles/save")
    def api_profiles_save():
        """Create or update one profile.

        Body is a describe()-shaped row plus an optional "password":
          {"action": "set", "value": "..."} | {"action": "clear"} | absent = keep
        """
        denied = guard.deny("auth.manage")
        if denied:
            return denied
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return jsonify(ok=False, error="expected a profile object"), 400

        with server.cfg.mutate():
            rows = copy.deepcopy(users.profiles_of(server.cfg.users))
            rows = [dict(p.data) for p in rows]
            pid = str(body.get("id") or "")
            existing = next((r for r in rows if r.get("id") == pid), None)
            creating = existing is None
            if creating:
                row = {"id": users.new_id(), "password": None}
                rows.append(row)
            else:
                row = existing

            for field, default in (("name", ""), ("role", ""), ("email", ""),
                                   ("locale", "")):
                if field in body:
                    row[field] = str(body.get(field) or default).strip()
            for flag in ("enabled", "admin"):
                if flag in body:
                    row[flag] = body.get(flag) is True
            if "capabilities" in body:
                row["capabilities"] = [c for c in (body.get("capabilities") or [])
                                       if isinstance(c, str)]
            if "phi_visible" in body:
                row["phi_visible"] = [f for f in (body.get("phi_visible") or [])
                                      if isinstance(f, str)]

            pw = body.get("password")
            password_changed = False
            if isinstance(pw, dict):
                action = str(pw.get("action") or "").lower()
                if action == "set":
                    value = pw.get("value")
                    if not isinstance(value, str) or len(value) < 4:
                        return jsonify(ok=False,
                                       error="a password must be at least 4 characters. "
                                             "Leave it unset for an open profile instead — "
                                             "a short password is not a weaker lock, it is "
                                             "the same open door with a step in front of it."), 400
                    row["password"] = users.hash_password(value)
                    password_changed = True
                elif action == "clear":
                    row["password"] = None
                    password_changed = True

            action_name = audit.PROFILE_CREATED if creating else audit.PROFILE_CHANGED
            what = ("created" if creating else "changed") + f" profile '{row.get('name', '')}'"
            if password_changed:
                what += " (password " + ("set)" if row.get("password") else "cleared)")
            return _write_profiles(rows, action_name, what, target=row.get("id", ""))

    @app.post("/api/profiles/delete")
    def api_profiles_delete():
        denied = guard.deny("auth.manage")
        if denied:
            return denied
        pid = str((request.get_json(silent=True) or {}).get("id") or "")
        with server.cfg.mutate():
            rows = [dict(p.data) for p in users.profiles_of(server.cfg.users)]
            target = next((r for r in rows if r.get("id") == pid), None)
            if target is None:
                return jsonify(ok=False, error="no such profile"), 404
            # Deleting the profile you are logged in as is allowed — an
            # administrator tidying up two accounts of their own should not have
            # to work out which one they are using. What is refused, below, is
            # deleting the LAST one that can manage profiles, and that check
            # covers this case whenever it actually matters.
            rows = [r for r in rows if r.get("id") != pid]
            return _write_profiles(rows, audit.PROFILE_DELETED,
                                   f"deleted profile '{target.get('name', '')}'",
                                   target=pid)

    @app.post("/api/profiles/listing")
    def api_profiles_listing():
        """Show or hide the picker (users.list_profiles)."""
        denied = guard.deny("auth.manage")
        if denied:
            return denied
        want = (request.get_json(silent=True) or {}).get("list_profiles") is True
        with server.cfg.mutate():
            previous = server.cfg.users.get("list_profiles", True)
            server.cfg.users["list_profiles"] = want
            try:
                server.cfg.save()
            except OSError as exc:
                server.cfg.users["list_profiles"] = previous
                return jsonify(ok=False, error=f"could not save: {exc}"), 400
        server.audit.record(audit.CONFIG_CHANGED, actor=guard.current(),
                            target="users.list_profiles",
                            source=request.remote_addr or "",
                            detail=f"profile picker {'shown' if want else 'hidden'}")
        return jsonify(ok=True, list_profiles=want)

    def _write_profiles(rows: list, action: str, what: str, target: str = ""):
        """Validate a proposed profile list, save it, and record the change.

        Called with cfg.mutate() already held. Validation runs against a full
        candidate document rather than the list alone, because two of the rules
        are about the rest of the config — an open profile with write access is
        legal on loopback and refused off-box, and that depends on web.host.
        """
        candidate = copy.deepcopy(server.cfg.data)
        candidate.setdefault("users", {})["profiles"] = rows
        try:
            server.cfg.would_accept(candidate)
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        previous = server.cfg.users.get("profiles", [])
        server.cfg.users["profiles"] = rows
        try:
            server.cfg.save()
        except OSError as exc:
            # Rolled back for the reason every other secret-bearing save is: a
            # profile list live in memory but not on disk means the appliance
            # enforces one set of permissions now and a different one after the
            # next restart, with nothing to say which is which.
            server.cfg.users["profiles"] = previous
            return jsonify(ok=False, error=f"could not save profiles: {exc}"), 400
        server.log.info(f"Profiles: {what}", kind="auth")
        server.audit.record(action, actor=guard.current(), target=target or what,
                            source=request.remote_addr or "", detail=what)
        return jsonify(ok=True,
                       profiles=[p.describe() for p in users.profiles_of(server.cfg.users)],
                       in_use=users.profiles_in_use(server.cfg.users),
                       **_capabilities_catalogue())

    # ---- the audit trail ---------------------------------------------------
    @app.get("/api/audit")
    def api_audit():
        """Recent records, newest first. Filterable by action and by actor."""
        denied = guard.deny("audit.read")
        if denied:
            return denied
        try:
            limit = min(2000, max(1, int(request.args.get("limit", 200))))
        except ValueError:
            limit = 200
        rows = server.audit.tail(limit,
                                 action=request.args.get("action", ""),
                                 actor_id=request.args.get("actor", ""))
        return jsonify(ok=True, records=_audit_rows_for(rows),
                       audit=server.audit.stats())

    @app.get("/api/audit/verify")
    def api_audit_verify():
        """Walk the whole chain and report the first place it breaks.

        A real read of every file, not a cached answer: the question is whether
        what is ON DISK still matches itself, and anything this process
        remembers about what it wrote cannot answer that.
        """
        denied = guard.deny("audit.read")
        if denied:
            return denied
        return jsonify(ok=True, verify=server.audit.verify(),
                       audit=server.audit.stats())

    @app.get("/api/audit/export")
    def api_audit_export():
        """The whole trail as JSON Lines, for an inspection or an archive.

        Served with the chain intact and unredacted, which is the point of an
        export — a copy with fields removed cannot be verified, because the
        digests cover what was actually written. That is also why this needs
        audit.read AND every identifier: see the check below.
        """
        denied = guard.deny("audit.read")
        if denied:
            return denied
        who = guard.current()
        if who.phi_visible() < frozenset(users.PHI_FIELDS):
            return jsonify({
                "ok": False, "error": "not permitted",
                "forbidden": {"capability": "phi.all", "profile": who.name},
                "detail": "an export has to carry the records exactly as they were "
                          "written or the hash chain cannot be checked against it, so "
                          "it cannot be redacted. Read the trail in the dashboard "
                          "instead, or ask an administrator.",
            }), 403
        lines = []
        for record in server.audit.read_all():
            if "_unreadable" in record:
                # An export is evidence. A copy that is silently missing whatever
                # this file held — served with a 200, so it reads as the complete
                # trail — is worse than refusing: the reader has no way to tell.
                return jsonify({
                    "ok": False, "error": "audit trail incomplete",
                    "detail": f"{record['_file']} could not be read, so this export "
                              f"would be missing records without saying so: "
                              f"{record['_unreadable']}",
                }), 503
            lines.append(json.dumps({k: v for k, v in record.items()
                                     if not k.startswith("_")},
                                    sort_keys=True, separators=(",", ":"),
                                    default=str))
        body = "\n".join(lines) + ("\n" if lines else "")
        resp = app.response_class(body, mimetype="application/x-ndjson")
        resp.headers["Content-Disposition"] = 'attachment; filename="carino-dicom-audit.jsonl"'
        return resp

    def _audit_rows_for(rows: list) -> list:
        """Audit rows as this profile may see them.

        One field needs care. `target` is often a stored study's path, and the
        storage layout puts the PatientID in it (see dest_path in pacs/scp.py),
        so a profile that may not see patient IDs would read them here — through
        the one endpoint built to prove that access control works. The generic
        redactor cannot catch it, because the key is called "target" and means
        something different on every action.
        """
        who = guard.current()
        if who.sees("patient_id"):
            return rows
        out = []
        for row in rows:
            row = dict(row)
            if row.get("target"):
                row["target"] = users.REDACTED
            out.append(row)
        return out

    # Which audited action each mutating endpoint represents. Anything NOT
    # listed still gets recorded, under an action derived from its path — the
    # default is to record, so a new endpoint is auditable the day it is
    # written rather than the day somebody remembers to add it here. This table
    # only exists to give the common ones a stable, searchable name.
    _AUDIT_ACTIONS = {
        "/api/config":              audit.CONFIG_CHANGED,
        "/api/setup":               audit.CONFIG_CHANGED,
        "/api/auth/token":          audit.TOKEN_ROTATED,
        "/api/deid/secret":         audit.DEID_CHANGED,
        "/api/studies/send":        audit.STUDY_SENT,
        "/api/studies/delete":      audit.STUDY_DELETED,
        "/api/studies/delete-all":  audit.STUDY_DELETED,
        "/api/stuck/retry":         audit.STUDY_SENT,
        "/api/pending/approve":     audit.STUDY_SENT,
        "/api/pending/discard":     audit.STUDY_DELETED,
        "/api/ris/orders":          audit.ORDER_CHANGED,
        "/api/ris/orders/update":   audit.ORDER_CHANGED,
        "/api/ris/orders/cancel":   audit.ORDER_CHANGED,
        "/api/ris/orders/delete":   audit.ORDER_CHANGED,
        "/api/ris/orders/purge":    audit.ORDER_CHANGED,
        "/api/receiver":            audit.SERVICE_CHANGED,
        "/api/printer":             audit.SERVICE_CHANGED,
        "/api/ris":                 audit.SERVICE_CHANGED,
        "/api/mwl":                 audit.SERVICE_CHANGED,
        "/api/qr":                  audit.SERVICE_CHANGED,
        "/api/watcher":             audit.SERVICE_CHANGED,
        "/api/emergency":           audit.EMERGENCY_CHANGED,
        "/api/dev-peer":            audit.DEV_PEER_CHANGED,
        "/api/shutdown":            audit.SHUTDOWN,
    }

    # Endpoints whose body is genuinely uninteresting and high-volume enough
    # that recording each one would bury the records that matter.
    _AUDIT_SKIP = frozenset({"/api/portcheck", "/api/echo", "/api/login",
                             "/api/logout", "/api/routing/test"})

    # Body fields safe to record as the target of an action. Deliberately a
    # whitelist: an order POST body is nothing but demographics and a login body
    # carries a password, and an audit trail that copies request bodies
    # wholesale becomes the largest unredacted pile of PHI on the appliance.
    _TARGET_FIELDS = ("path", "id", "profile", "group", "action", "name")

    def _audit_target() -> str:
        try:
            body = request.get_json(silent=True)
        except Exception:
            body = None
        if not isinstance(body, dict):
            body = request.form if request.form else {}
        parts = []
        for field in _TARGET_FIELDS:
            try:
                value = body.get(field)
            except Exception:
                value = None
            if isinstance(value, (str, int)) and str(value):
                parts.append(f"{field}={value}")
        return " ".join(parts)[:300]

    @app.after_request
    def _record_to_audit(resp):
        """Record every mutating API call, with its outcome.

        In after_request so the record carries what actually HAPPENED. A
        decorator on the way in would have to guess, and an audit trail that
        says a study was deleted when the delete returned 400 is worse than no
        trail — it is a trail that lies in the direction of alarming people.

        Refusals are recorded too, and that is not padding: "who kept trying to
        reach the thing they are not allowed to reach" is one of the few
        questions an audit trail is uniquely able to answer.
        """
        try:
            path = request.path
            if not path.startswith("/api/"):
                return resp
            method = request.method.upper()
            if path in _AUDIT_SKIP or method in ("GET", "HEAD", "OPTIONS"):
                # A 403 on a read is still worth a record — it is the only
                # trace that somebody went looking.
                if not (resp.status_code == 403 and method in ("GET", "POST")):
                    return resp
                server.audit.record(
                    audit.DENIED, actor=guard.current(), target=path,
                    outcome="denied", source=request.remote_addr or "",
                    method=method)
                return resp
            action = _AUDIT_ACTIONS.get(path) or "api" + path[4:].replace("/", ".")
            outcome = ("ok" if 200 <= resp.status_code < 300 else
                       "denied" if resp.status_code in (401, 403) else "failed")
            server.audit.record(
                action if outcome != "denied" else audit.DENIED,
                actor=guard.current(),
                target=_audit_target() or path,
                outcome=outcome,
                source=request.remote_addr or "",
                status=resp.status_code,
                endpoint=path,
            )
        except Exception:
            # Never let recording break the response it is recording. The
            # failure is visible through audit.stats()["broken"] instead.
            pass
        return resp

    return app
