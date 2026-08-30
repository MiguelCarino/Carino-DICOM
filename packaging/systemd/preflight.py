"""Refuse to start Carino DICOM on a configuration that would expose patient data.

Run as ExecStartPre= by carino-pacs.service:

    preflight.py /var/lib/carino-pacs/config.json

Exits 0 to let the service start, or 78 (EX_CONFIG) with an explanation on
stderr, which the journal picks up. Everything it prints is meant to be read by
whoever runs `systemctl status carino-pacs` at 2am.

Why this exists at all, rather than trusting the application to check itself:

  * pacs.config.Config.load() does not call validate(). validate() runs on the
    dashboard's save path, so a config.json edited by hand — which is the normal
    way to configure a headless box — is never checked before the listeners bind.
  * When config.json is MISSING, load() silently falls back to the built-in
    defaults instead of failing. Those defaults have every service disabled and
    the dashboard on 127.0.0.1, so a typo in the path produces a unit that starts
    cleanly, reports active, and does nothing, on an address no one can reach.
    On an appliance that failure mode can go unnoticed for weeks.

This runs inside the same sandbox as the service, as the same unprivileged user,
so it also doubles as a check that the service user can actually reach its data.
"""

from __future__ import annotations

import json
import os
import sys

EX_CONFIG = 78          # sysexits.h — "configuration error", for humans and log
                        # greppers. Note that systemd's RestartPreventExitStatus=
                        # does NOT act on ExecStartPre= exit codes (measured), so
                        # this does not stop the restart loop; the unit retries
                        # every RestartSec and prints this again until it is
                        # fixed, which is the intended behaviour for an appliance.


def fail(msg: str) -> "None":
    print(f"carino-pacs preflight: {msg}", file=sys.stderr)
    raise SystemExit(EX_CONFIG)


def main(argv: list) -> int:
    if len(argv) != 2:
        fail("usage: preflight.py /path/to/config.json")
    path = argv[1]

    if not os.path.isfile(path):
        fail(
            f"{path} does not exist. Carino DICOM would start on built-in defaults "
            "with every service disabled and the dashboard on 127.0.0.1, so it is "
            "refused instead. Create it with:\n"
            f"    sudo -u carino-pacs /opt/carino-pacs/venv/bin/python -m pacs --config {path} init"
        )

    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except OSError as exc:
        fail(f"cannot read {path} as the service user: {exc}")
    except ValueError as exc:
        fail(f"{path} is not valid JSON: {exc}")
    if not isinstance(raw, dict):
        fail(f"{path} must contain a JSON object")

    # The directory holding config.json has to be writable, not just readable:
    # Config.save() creates a config.json.tmp.<pid>.<random> beside it and
    # renames that over the config — a new name every save, so the directory
    # entry has to be creatable, not merely the file writable — and the folder
    # watcher keeps .carinopacs_state.json there. Read-only means the
    # dashboard's Save silently 400s long after the service looked healthy.
    cfg_dir = os.path.dirname(os.path.abspath(path))
    if not os.access(cfg_dir, os.W_OK | os.X_OK):
        fail(f"{cfg_dir} is not writable by this service user ({_whoami()}); "
             "saving settings from the dashboard would fail")

    # Load through the application's own code so the preflight sees exactly the
    # merged config the service will see — including defaults filled in for keys
    # the operator left out.
    try:
        from pacs.config import Config, is_loopback_host, validate
    except ImportError as exc:
        fail(f"cannot import the pacs package (check PYTHONPATH): {exc}")

    try:
        cfg = Config(path)
    except Exception as exc:
        fail(f"{path} could not be loaded: {exc}")

    web = cfg.data.get("web", {})
    host = web.get("host", "127.0.0.1")
    token = str(web.get("auth_token", "") or "").strip()

    # This duplicates a check inside validate() on purpose. It is the one rule
    # that must not be lost to a refactor in a file this script does not own:
    # the dashboard API can read and write everything, and even an unauthenticated
    # GET /api/status returns patient names and IDs from the last stored study and
    # the last HL7 order. Exposing that on a network address without a token is
    # not a misconfiguration to warn about, it is a reason not to start.
    if not is_loopback_host(host) and not token:
        fail(
            f"web.host is '{host}', which is reachable from the network, but "
            "web.auth_token is empty. The dashboard API would serve patient data "
            "and full control to anyone who can route to this machine.\n"
            "    Generate a token:  python3 -c \"import secrets; print(secrets.token_urlsafe(32))\"\n"
            f"    then set web.auth_token in {path},\n"
            "    or set web.host back to 127.0.0.1 and reach the dashboard over an SSH tunnel."
        )

    # Everything else validate() enforces: port ranges, two enabled listeners on
    # the same port, malformed destinations.
    try:
        validate(cfg.data)
    except ValueError as exc:
        fail(f"{path} is not valid: {exc}")

    # Non-fatal notes. These are not reasons to refuse a start, but they are the
    # two states most likely to be mistaken for a broken install.
    warn = []
    if not str(cfg.data.get("setup_completed", "")).strip():
        warn.append("setup_completed is empty, so the dashboard opens the service chooser")
    enabled = [name for name in ("scp", "scu", "print", "mwl", "qr", "ris")
               if cfg.data.get(name, {}).get("enabled")]
    if not enabled:
        warn.append("no listener is enabled in the config, so this will serve the dashboard and nothing else")
    for w in warn:
        print(f"carino-pacs preflight: note: {w}", file=sys.stderr)

    where = "loopback only" if is_loopback_host(host) else f"{host} — token required and present"
    print(f"carino-pacs preflight: ok — dashboard {where}; "
          f"enabled: {', '.join(enabled) if enabled else 'none'}")
    return 0


def _whoami() -> str:
    try:
        import pwd
        return f"uid {os.getuid()} / {pwd.getpwuid(os.getuid()).pw_name}"
    except Exception:
        return f"uid {os.getuid()}"


if __name__ == "__main__":
    sys.exit(main(sys.argv))
