"""Carino PACS command line.

    python -m pacs serve      # web dashboard + whatever services the config enables
    python -m pacs receive    # Storage SCP only, headless
    python -m pacs send       # folder watcher / auto-forward only, headless
    python -m pacs print      # virtual DICOM print receiver only, headless
    python -m pacs ris        # emergency-RIS HL7/MLLP order listener, headless
    python -m pacs mwl        # Modality Worklist SCP (serve orders), headless
    python -m pacs echo ...    # C-ECHO connectivity test
    python -m pacs init       # scaffold config.json + folders
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import sys
import time

from . import APP_NAME, __version__
from .config import Config, DEFAULT_CONFIG
from .scu import Destination
from .server import PacsServer


def _echo_recent_log(server: PacsServer, seen: int) -> int:
    for e in server.log.since(seen):
        print(f"  [{e['level'][0].upper()}] {e['message']}")
        seen = e["seq"]
    return seen


def _block_until_signal(server: PacsServer) -> None:
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
    cfg_path = os.path.abspath(os.path.expanduser(args.config))
    os.makedirs(os.path.dirname(cfg_path) or ".", exist_ok=True)
    if os.path.exists(cfg_path):
        print(f"{cfg_path} already exists — leaving it untouched.")
    else:
        example = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.example.json")
        if os.path.exists(example):
            shutil.copy(example, cfg_path)
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
    # A scaffolded config enables no service on purpose: the dashboard's setup
    # chooser is what enrolls them, so say so rather than let `serve` look dead.
    if not str(cfg.data.get("setup_completed", "")).strip():
        print("No services enabled yet — run `pacs serve` and pick them in the dashboard.")
    return 0


def cmd_serve(args) -> int:
    from .web import create_app  # imported lazily so `receive`/`send` don't need Flask

    cfg = Config(args.config)
    server = PacsServer(cfg)
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

    host = args.host or cfg.web.get("host", "127.0.0.1")
    port = args.port or int(cfg.web.get("port", 8042))
    app = create_app(server)
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}/"
    print(f"{APP_NAME} {__version__} dashboard → {url}")
    print(f"Config: {cfg.path}")
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


def cmd_echo(args) -> int:
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

    e = sub.add_parser("echo", help="C-ECHO connectivity test")
    e.add_argument("--name", help="destination name from config")
    e.add_argument("--host")
    e.add_argument("--port", type=int)
    e.add_argument("--aet", help="remote AE title")
    e.add_argument("--calling", help="calling (local) AE title")
    e.add_argument("--tls", action="store_true", help="connect over TLS (uses scu TLS settings from config)")
    e.set_defaults(func=cmd_echo)

    i = sub.add_parser("init", help="scaffold config.json and its folders")
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


def main(argv=None) -> int:
    _force_utf8_output()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
