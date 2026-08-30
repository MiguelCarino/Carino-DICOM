"""Carino DICOM command line.

    python -m pacs serve      # web dashboard + whatever services the config enables
    python -m pacs receive    # Storage SCP only, headless
    python -m pacs send       # folder watcher / auto-forward only, headless
    python -m pacs print      # virtual DICOM print receiver only, headless
    python -m pacs ris        # emergency-RIS HL7/MLLP order listener, headless
    python -m pacs mwl        # Modality Worklist SCP (serve orders), headless
    python -m pacs qr         # Query/Retrieve SCP (C-FIND/C-MOVE/C-GET), headless
    python -m pacs echo ...    # C-ECHO connectivity test
    python -m pacs init       # scaffold config.json + folders

Every subcommand loads the config named by -c/--config as its first act, and
only one of them writes it back on its own: `init --token`, which mints
web.auth_token and saves. (`serve` rewrites it too, but through the dashboard —
the Settings pages save the same Config object this process is holding.) The
per-command overrides (--port, --aet, --out, --watch-dir) change the loaded
document in memory for the life of that process and nothing else — enrolling a
service permanently is the dashboard's setup chooser, not this file.

The headless commands are an alternative to `serve`, not a companion to it: they
start the same service objects off the same config sections, so running one
beside a `serve` that already has that service enabled is two processes fighting
over one DICOM port — or, for `send`, two watchers forwarding one folder.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import sys
import time

from . import APP_NAME, __version__
from .config import Config, ConfigError, DEFAULT_CONFIG, auth_token_of, is_loopback_host
from .netclaim import claim
from .scu import Destination
from .server import PacsServer


def _echo_recent_log(server: PacsServer, seen: int) -> int:
    # The ring buffer is bounded, so a burst between two polls scrolls past
    # unprinted. The dated file under logs_dir is the complete record; a
    # headless run's console is only the running commentary.
    for e in server.log.since(seen):
        print(f"  [{e['level'][0].upper()}] {e['message']}")
        seen = e["seq"]
    return seen


def _block_until_signal(server: PacsServer) -> None:
    """Hold a headless command open, echoing the log, until Ctrl+C or SIGTERM.

    The handlers only raise a flag; the shutdown runs back in this loop, in
    ordinary code, rather than inside a signal handler that can land in the
    middle of an association or an sqlite write. This deliberately replaces the
    SIGTERM disposition _install_sigterm() put in place — that one raises
    KeyboardInterrupt to unwind Werkzeug for `serve`, and there is no Werkzeug
    here to unwind.
    """
    stop = {"flag": False}

    def handler(signum, frame):
        stop["flag"] = True

    signal.signal(signal.SIGINT, handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handler)
    print("Running. Press Ctrl+C to stop.")
    seen = 0
    while not stop["flag"]:
        seen = _echo_recent_log(server, seen)
        time.sleep(0.5)
    print("\nShutting down…")
    server.shutdown()


def cmd_init(args) -> int:
    """Scaffold the config file and the folders it names.

    Non-destructive and safe to re-run: an existing config is never overwritten
    (--token is the one thing that may add to one), and the directories are
    created only if missing. What it writes is a
    copy of config.example.json when that file can be found — the example is the
    commented reference for every key, and an operator who has to edit this by
    hand is far better served by it than by the bare document Config.save()
    produces from DEFAULTS.

    --token mints web.auth_token only when there is none; it is not a rotate.
    Scaffolding enables no service — that is the dashboard's setup chooser.
    """
    cfg_path = os.path.abspath(os.path.expanduser(args.config))
    os.makedirs(os.path.dirname(cfg_path) or ".", exist_ok=True)
    if os.path.exists(cfg_path):
        print(f"{cfg_path} already exists — leaving it untouched.")
    else:
        example = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.example.json")
        if os.path.exists(example):
            # copyfile, not copy: copy() brings the example's 0644 with it, and
            # this file is about to hold web.auth_token. Config.save() creates
            # at 0600 and a scaffolded config has to match, whether the token
            # arrives now (--token) or from the dashboard later.
            shutil.copyfile(example, cfg_path)
            try:
                os.chmod(cfg_path, 0o600)
            except OSError:
                pass        # Windows / exotic filesystem: best effort only
        else:
            Config(cfg_path).save()
        print(f"Wrote {cfg_path}")
    cfg = Config(cfg_path)
    for section, field in (("scp", "storage_dir"), ("scu", "watch_dir"), ("scu", "sent_dir")):
        d = cfg.resolved(section, field)
        os.makedirs(d, exist_ok=True)
        print(f"  ensured {d}")
    os.makedirs(cfg.logs_dir, exist_ok=True)
    print(f"  ensured {cfg.logs_dir}")
    if args.token:
        from .auth import generate_token
        if auth_token_of(cfg.web):
            print("  web.auth_token is already set — left alone. Clear it in the config "
                  "to mint a new one (every logged-in browser is signed out when it changes).")
        else:
            cfg.web["auth_token"] = generate_token()
            cfg.save()
            # stdout only, once, at creation. The token is never written to the
            # log buffer or the dated log files, and never appears in a URL.
            print(f"  API token: {cfg.web['auth_token']}")
            print("  Copy it now — it is shown here and nowhere else.")
    # A scaffolded config enables no service on purpose: the dashboard's setup
    # chooser is what enrolls them, so say so rather than let `serve` look dead.
    if not str(cfg.data.get("setup_completed", "")).strip():
        print("No services enabled yet — run `pacs serve` and pick them in the dashboard.")
    return 0


def cmd_serve(args) -> int:
    """Run the dashboard plus whatever the config enables; block until it stops.

    Returns 2 without binding anything when the dashboard would be reachable
    from the network with no token set. This is the one command whose process
    can rewrite config.json, because the dashboard's setup chooser and settings
    pages save through the same Config object it is holding.
    """
    from .web import create_app  # imported lazily so `receive`/`send` don't need Flask

    cfg = Config(args.config)
    # Locals, never cfg.web[...]: the dashboard hands the browser whatever is in
    # this Config and saves back what the browser returns, so an override poked
    # into the document would be displayed as the configured value and made
    # permanent by the next Save anyone presses. A --host meant for one run is
    # how the bind address gets changed for good.
    host = args.host or cfg.web.get("host", "127.0.0.1")
    port = args.port or int(cfg.web.get("port", 8042))
    # Checked BEFORE anything binds. config validation already refuses to SAVE a
    # reachable host with no token, but --host bypasses it entirely — and this is
    # the one mistake that publishes patient studies, storage paths and
    # /api/shutdown to the whole network. Refuse to start, and say how to fix it.
    if not is_loopback_host(host) and not auth_token_of(cfg.web):
        print(f"Refusing to serve the dashboard on '{host}': it is reachable from the network "
              f"and web.auth_token is empty.\n"
              f"  Set a token:  python -m pacs -c {cfg.path} init --token\n"
              f"  Or keep it on this machine only:  --host 127.0.0.1",
              file=sys.stderr)
        return 2

    server = PacsServer(cfg, dev_peer=args.dev_peer)
    # Before the services: the receiver hands every stored instance to the index
    # writer, and a cold boot answers its first query out of whatever the rescan
    # has reached by then rather than out of an empty database.
    server.start_index()
    # What runs is what the config enables — the dashboard's setup chooser is
    # what writes those flags, so a machine that has never been through it
    # starts nothing but the dashboard. Auto-start is best-effort: a failure
    # (e.g. DICOM port in use, bad TLS cert) must NOT stop the dashboard from
    # coming up — it is how the user sees the error and fixes the config.
    for row in server.sync_services():
        if not row.get("ok"):
            print(f"WARNING: {row.get('service')} did not {row.get('action')}: {row.get('error')}",
                  file=sys.stderr)
    # The flags are run-once overrides for headless launches: they start a
    # service for THIS run without enrolling it in the config. start_* is a
    # no-op when the service is already up, so an override never doubles a sync.
    for flag, start, label, kind in (
        (args.receive, server.start_receiver, "receiver", "scp"),
        (args.watch, server.start_watcher, "watcher", "watch"),
        (args.print, server.start_printer, "print receiver", "print"),
        (args.ris, server.start_ris, "RIS listener", "ris"),
        (args.mwl, server.start_mwl, "worklist SCP", "mwl"),
        (args.qr, server.start_qr, "Query/Retrieve SCP", "qr"),
    ):
        if not flag:
            continue
        try:
            start()
        except Exception as exc:
            server.log.error(f"Could not start {label}: {exc}", kind=kind)
            print(f"WARNING: {label} did not start: {exc}", file=sys.stderr)
    # Emergency failover monitor auto-starts if armed in config.
    try:
        server.emergency.start()
    except Exception as exc:
        server.log.error(f"Could not start emergency monitor: {exc}", kind="emergency")

    # A second engine must not come up beside the first. On Windows it would
    # bind every port alongside it rather than be refused, and then neither
    # instance owns the archive — see netclaim. The dashboard port is the one an
    # operator recognises, so this is the place to say so in a sentence they can
    # act on rather than let it surface as a receiver that never receives.
    try:
        claim(host, port)
    except OSError as exc:
        print(f"{APP_NAME} cannot start: {host or '0.0.0.0'}:{port} is already in "
              f"use ({exc}). Another copy is probably already running.")
        server.shutdown()
        return 1

    # AFTER claim(), and NOT gated on --dev-peer. Both halves of that are the
    # answer to a bug:
    #
    #   * It writes to config.json, so it must not run on a launch that is about
    #     to be refused. Above the claim it fired on the ordinary "I started it
    #     twice" mistake and rewrote the destinations of the copy that IS
    #     running, which then disagreed with its own file.
    #   * The restart that follows a crash is the NORMAL one — the developer
    #     finished testing, and Dockerfile's CMD and the desktop launcher never
    #     pass the flag at all. Gating the cleanup on the flag left an enabled
    #     destination aimed at a released loopback port that any local process
    #     can bind, plus a temp archive of real studies, for as long as nobody
    #     happened to run with --dev-peer again.
    #
    # Still the only automatic delete in the feature, and still only at startup:
    # never on a timer, never on a browser closing. A peer whose owner process
    # is alive is left strictly alone, directory and rows both.
    from .devpeer import sweep_stale
    sweep_stale(log=server.log, cfg=cfg)

    app = create_app(server)
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}/"
    print(f"{APP_NAME} {__version__} dashboard → {url}")
    print(f"Config: {cfg.path}")
    if args.dev_peer:
        print("Dev peer enabled — the dashboard may create a second, disposable archive.")
    try:
        app.run(host=host, port=port, threaded=True, use_reloader=False)
    finally:
        server.shutdown()
    return 0


def cmd_receive(args) -> int:
    cfg = Config(args.config)
    if args.port:
        cfg.scp["port"] = args.port
    if args.aet:
        cfg.scp["aet"] = args.aet
    if args.out:
        cfg.scp["storage_dir"] = args.out
    server = PacsServer(cfg)
    server.start_index()      # headless receive still feeds the index
    server.start_receiver()
    _block_until_signal(server)
    return 0


def cmd_send(args) -> int:
    cfg = Config(args.config)
    if args.watch_dir:
        cfg.scu["watch_dir"] = args.watch_dir
    if not cfg.enabled_destinations():
        print("No enabled destinations in config — nothing to send to.", file=sys.stderr)
        return 2
    server = PacsServer(cfg)
    server.start_watcher()
    _block_until_signal(server)
    return 0


def cmd_print(args) -> int:
    cfg = Config(args.config)
    if args.port:
        cfg.printer["port"] = args.port
    if args.aet:
        cfg.printer["aet"] = args.aet
    server = PacsServer(cfg)
    server.start_printer()
    _block_until_signal(server)
    return 0


def cmd_ris(args) -> int:
    cfg = Config(args.config)
    if args.port:
        cfg.ris["port"] = args.port
    server = PacsServer(cfg)
    server.start_ris()
    _block_until_signal(server)
    return 0


def cmd_mwl(args) -> int:
    cfg = Config(args.config)
    if args.port:
        cfg.mwl["port"] = args.port
    if args.aet:
        cfg.mwl["aet"] = args.aet
    server = PacsServer(cfg)
    server.start_mwl()
    _block_until_signal(server)
    return 0


def cmd_qr(args) -> int:
    """Run the Query/Retrieve SCP headless. Returns 2 when the SCP refuses to
    start — most often because the instance index is disabled, which is the one
    configuration Q/R cannot answer out of."""
    cfg = Config(args.config)
    if args.port:
        cfg.qr["port"] = args.port
    if args.aet:
        cfg.qr["aet"] = args.aet
    server = PacsServer(cfg)
    # The index is the archive as far as Q/R is concerned: without the rescan a
    # cold start would answer every C-FIND "no match" on a full disk.
    server.start_index()
    try:
        server.start_qr()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        server.shutdown()
        return 2
    _block_until_signal(server)
    return 0


def cmd_echo(args) -> int:
    """C-ECHO one destination and report the result.

    The exit codes are distinct because this gets used as a health check: 0 the
    peer answered, 1 it was dialled and did not, 2 nothing was dialled at all —
    no such destination in the config, or an incomplete --host/--port/--aet
    triple.
    """
    cfg = Config(args.config)
    if args.name:
        match = next((d for d in cfg.destinations if d.get("name") == args.name), None)
        if not match:
            print(f"No destination named '{args.name}' in config.", file=sys.stderr)
            return 2
        dest = Destination.from_dict(match)
    elif args.host and args.port and args.aet:
        dest = Destination(name=args.host, host=args.host, port=args.port, aet=args.aet, tls=args.tls)
    else:
        print("Provide --name, or all of --host --port --aet.", file=sys.stderr)
        return 2
    from .scu import c_echo

    ctx = None
    if dest.tls:
        from .tlsutil import client_context
        scu = cfg.scu
        ctx = client_context(
            verify=bool(scu.get("tls_verify", True)),
            ca=cfg.resolve_path(scu.get("tls_ca", "")),
            certfile=cfg.resolve_path(scu.get("tls_cert", "")),
            keyfile=cfg.resolve_path(scu.get("tls_key", "")),
        )
    res = c_echo(dest, args.calling or cfg.scu.get("aet", "CARINOSCU"), tls_context=ctx)
    print(f"{dest.host}:{dest.port} [{dest.aet}]{' TLS' if dest.tls else ''} — {res.message}")
    return 0 if res.ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pacs", description=f"{APP_NAME} — simple DICOM store PACS")
    p.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    p.add_argument("-c", "--config", default=DEFAULT_CONFIG,
                   help=f"path to config JSON (default: {DEFAULT_CONFIG})")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="run the web dashboard")
    s.add_argument("--host", help="override web bind host")
    s.add_argument("--port", type=int, help="override web port")
    # These start a service for this run only — they never write the config's
    # enabled flags (that is the dashboard's setup chooser).
    s.add_argument("--receive", action="store_true", help="start the receiver for this run even if config has it off")
    s.add_argument("--watch", action="store_true", help="start the folder watcher for this run even if config has it off")
    s.add_argument("--print", action="store_true", dest="print",
                   help="start the virtual DICOM print receiver for this run even if config has it off")
    s.add_argument("--ris", action="store_true", dest="ris",
                   help="start the emergency-RIS HL7/MLLP listener for this run even if config has it off")
    s.add_argument("--mwl", action="store_true", dest="mwl",
                   help="start the Modality Worklist SCP for this run even if config has it off")
    s.add_argument("--qr", action="store_true", dest="qr",
                   help="start the Query/Retrieve SCP for this run even if config has it off")
    # Not one of the run-once service overrides above, and not a config key —
    # which is the whole argument for the feature. A key would be editable
    # through POST /api/config, so an admin token on a deployed appliance could
    # switch on "spawn a second archive"; a launch flag cannot be reached over
    # HTTP at all. The shipped container CMD and the desktop launcher never
    # pass it.
    s.add_argument("--dev-peer", action="store_true", dest="dev_peer",
                   help="allow the dashboard to create a disposable second archive for testing "
                        "(loopback only, deleted when it is discarded or when this process stops)")
    s.set_defaults(func=cmd_serve)

    r = sub.add_parser("receive", help="run the Storage SCP (receiver) headless")
    r.add_argument("--port", type=int, help="listen port")
    r.add_argument("--aet", help="local AE title")
    r.add_argument("--out", help="storage directory")
    r.set_defaults(func=cmd_receive)

    se = sub.add_parser("send", help="watch a folder and auto-forward headless")
    se.add_argument("--watch-dir", help="folder to watch")
    se.set_defaults(func=cmd_send)

    pr = sub.add_parser("print", help="run the virtual DICOM print receiver headless")
    pr.add_argument("--port", type=int, help="listen port")
    pr.add_argument("--aet", help="local (printer) AE title")
    pr.set_defaults(func=cmd_print)

    rs = sub.add_parser("ris", help="run the emergency-RIS HL7/MLLP order listener headless")
    rs.add_argument("--port", type=int, help="listen port (default 2575)")
    rs.set_defaults(func=cmd_ris)

    mw = sub.add_parser("mwl", help="run the Modality Worklist SCP (serve orders) headless")
    mw.add_argument("--port", type=int, help="listen port (default 11114)")
    mw.add_argument("--aet", help="local (worklist) AE title")
    mw.set_defaults(func=cmd_mwl)

    qp = sub.add_parser("qr", help="run the Query/Retrieve SCP (C-FIND/C-MOVE/C-GET) headless")
    qp.add_argument("--port", type=int, help="listen port (default 11115)")
    qp.add_argument("--aet", help="local (Q/R) AE title")
    qp.set_defaults(func=cmd_qr)

    e = sub.add_parser("echo", help="C-ECHO connectivity test")
    e.add_argument("--name", help="destination name from config")
    e.add_argument("--host")
    e.add_argument("--port", type=int)
    e.add_argument("--aet", help="remote AE title")
    e.add_argument("--calling", help="calling (local) AE title")
    e.add_argument("--tls", action="store_true", help="connect over TLS (uses scu TLS settings from config)")
    e.set_defaults(func=cmd_echo)

    i = sub.add_parser("init", help="scaffold config.json and its folders")
    # store_true, not a value: a token typed on a command line lands in shell
    # history, and one an operator invents is weaker than 256 bits of urandom.
    i.add_argument("--token", action="store_true",
                   help="generate web.auth_token (required to serve the dashboard off loopback)")
    i.set_defaults(func=cmd_init)
    return p


def _force_utf8_output() -> None:
    """Windows' default cp1252 stdout can't encode chars like → … — and crashes
    the engine with UnicodeEncodeError. Force UTF-8 (and never crash on an
    un-encodable char). No-op if the streams aren't reconfigurable."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _install_sigterm() -> None:
    """Make SIGTERM unwind the way Ctrl+C does.

    Without a disposition of its own, SIGTERM is the kernel's default: the
    process dies where it stands, in ~0.02s, without ever reaching
    PacsServer.shutdown(). The DICOM listeners are never stopped, associations
    in flight are cut mid-transfer, and the index writer's backlog is dropped —
    and SIGTERM is what `docker stop`, `systemctl stop` and every process
    supervisor send. Only Ctrl+C stopped this engine cleanly.

    Raising KeyboardInterrupt puts SIGTERM on the path the app already handles:
    Werkzeug catches it inside serve_forever, app.run() returns, and cmd_serve's
    `finally: server.shutdown()` runs. The headless commands install their own
    flag-setting handler over this one in _block_until_signal, which is cleaner
    still — this is the fallback for `serve` and for the startup window before
    either loop is reached.
    """
    if not hasattr(signal, "SIGTERM"):
        return

    def _term(signum, frame):
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGTERM, _term)
    except ValueError:
        pass        # not the main thread (embedded / test harness): nothing to install


def main(argv=None) -> int:
    _force_utf8_output()
    _install_sigterm()
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        # EVERY subcommand builds a Config as its first act, and a file that
        # will not load is an operator problem, not a bug: the message already
        # names the file, what is wrong with it and how to get back. Printed
        # alone because a six-frame traceback above it is what made operators
        # read this as a crash and go looking for the wrong thing — the last
        # line of a stack trace is where nobody looks. Only ConfigError is
        # caught, and only here: an unexpected exception still gets its
        # traceback, which is the one thing worse to hide than to show.
        print(str(exc), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        # A signal arriving outside Werkzeug's own handling (during startup, or
        # in a command with no signal loop) still means "stop now, cleanly" — a
        # traceback would make an ordinary `systemctl stop` look like a crash.
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
