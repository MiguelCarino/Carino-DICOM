"""The dashboard front end's source text, as the browser loads it.

pacs/web/index.html loads the dashboard as a run of classic scripts
(<script src="js/...">). The tests that read the front end's source read all of
them, concatenated in the order index.html lists them — parsed from the markup,
so the list cannot drift from what the browser actually runs.
"""

from __future__ import annotations

import os
import re

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pacs", "web")

_SCRIPT_RE = re.compile(r'<script src="(js/[^"]+)"></script>')


def dashboard_js_files(web_dir: str = WEB_DIR) -> list:
    """The dashboard's script paths (relative to web_dir), in load order."""
    html = open(os.path.join(web_dir, "index.html"), encoding="utf-8").read()
    files = _SCRIPT_RE.findall(html)
    assert files, "index.html loads no js/ scripts"
    return files


def read_dashboard_js(web_dir: str = WEB_DIR) -> str:
    """Every dashboard script's source, concatenated in load order."""
    return "".join(open(os.path.join(web_dir, f), encoding="utf-8").read()
                   for f in dashboard_js_files(web_dir))
