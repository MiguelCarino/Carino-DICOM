"""Container healthcheck for Carino DICOM.

"The process is alive" is not health for a gateway whose whole job is to answer
on sockets, so this proves service, not liveness:

  1. HTTP GET the dashboard's own status endpoint and require a real answer.
  2. If the config enables the Storage SCP, open a TCP connection to its port —
     `pacs serve` starts listeners best-effort and keeps the dashboard up when
     one fails to bind, which is right for diagnosis but means a container with
     a dead DICOM port would otherwise report healthy.

Exit 0 = healthy, exit 1 = unhealthy. Reads the config for the ports and the
token, so it keeps working when the token changes and when /api/status stops
being readable without one.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import urllib.error
import urllib.request

CONFIG = os.environ.get("PACS_CONFIG", "").strip() or "/data/config.json"
TIMEOUT = 4.0


def load() -> dict:
    with open(CONFIG, "r", encoding="utf-8") as fh:
        return json.load(fh)


def check_dashboard(web: dict) -> None:
    port = int(web.get("port", 8042))
    token = str(web.get("auth_token", "")).strip()
    # Always talk to the container's own loopback: web.host may be 0.0.0.0, and
    # this check should never leave the container.
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/status")
    if token:
        # Sent both ways on purpose — the API's header name is settling, and a
        # healthcheck that fails on a rename would take the container down.
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("X-Auth-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read(65536)
            code = resp.status
    except urllib.error.HTTPError as exc:
        # 401/403 means Flask is up and answering, which is what health asks.
        # Anything 5xx is the app failing, not refusing.
        if 400 <= exc.code < 500:
            return
        raise SystemExit(f"unhealthy: dashboard returned HTTP {exc.code}")
    except Exception as exc:
        raise SystemExit(f"unhealthy: dashboard not answering on 127.0.0.1:{port} ({exc})")
    if code != 200:
        raise SystemExit(f"unhealthy: dashboard returned HTTP {code}")
    try:
        json.loads(body)
    except ValueError:
        raise SystemExit("unhealthy: /api/status did not return JSON")


def check_listener(section: dict, label: str) -> None:
    if not section.get("enabled"):
        return
    port = int(section.get("port", 0))
    if not port:
        return
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=TIMEOUT):
            pass
    except OSError as exc:
        raise SystemExit(f"unhealthy: {label} is enabled but nothing is listening on {port} ({exc})")


def main() -> int:
    try:
        data = load()
    except Exception as exc:
        print(f"unhealthy: cannot read {CONFIG} ({exc})", file=sys.stderr)
        return 1
    try:
        check_dashboard(data.get("web", {}))
        check_listener(data.get("scp", {}), "Storage SCP")
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
