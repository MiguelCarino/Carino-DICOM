"""The dashboard scripts share one global scope, so a name may be declared once.

pacs/web/js/*.js are classic scripts: a top-level `function x` or `const x` in
two of them is a SyntaxError ("Identifier 'x' has already been declared") the
moment the second file loads — and the browser then skips that whole file, so
every panel it drives goes dead with nothing on screen to say why. Python and
node checks pass file by file; only the page as a whole has the clash.

Run directly (python3 tests/test_dashboard_globals.py) or under pytest.
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dashboard_js import WEB_DIR, dashboard_js_files  # noqa: E402

# Column-0 declarations only: the scripts keep their top level unindented, and
# anything indented is inside a function or block and scoped there.
_DECL = re.compile(r"^(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)", re.M)


def top_level_names() -> dict:
    seen: dict = {}
    for rel in dashboard_js_files():
        src = open(os.path.join(WEB_DIR, rel), encoding="utf-8").read()
        for name in _DECL.findall(src):
            seen.setdefault(name, []).append(rel)
    return seen


def test_no_top_level_name_is_declared_twice():
    clashes = {n: files for n, files in top_level_names().items() if len(files) > 1}
    assert not clashes, f"declared in more than one dashboard script: {clashes}"


def test_the_scan_sees_the_scripts():
    # A regex that matched nothing would pass the test above forever.
    names = top_level_names()
    assert "loadHistory" in names and "renderStatus" in names, sorted(names)[:20]


def test_people_labels_match_the_engine():
    # The People tab translates each capability and identifier by its English
    # text. If users.py rewords one, this map must follow, or that checkbox
    # silently falls back to untranslated English in four languages.
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from pacs import users
    src = open(os.path.join(WEB_DIR, "js", "12-people-audit.js"), encoding="utf-8").read()
    block = src[src.index("const PERSON_TEXT = {"):]
    block = block[:block.index("};")]
    mapped = dict(re.findall(r'"([\w.]+)":\s*"([^"]*)"', block))
    engine = {**users.CAPABILITIES, **users.PHI_FIELDS}
    assert mapped == engine, {k: (mapped.get(k), engine.get(k))
                              for k in set(mapped) | set(engine) if mapped.get(k) != engine.get(k)}


def test_held_texts_match_the_engine():
    # The Stuck panel renders the held reason and remedy itself so they can be
    # translated; a sentence edited in server.py alone would go stale there.
    import json
    from pacs.server import PacsServer
    src = open(os.path.join(WEB_DIR, "js", "09-studies.js"), encoding="utf-8").read()
    block = src[src.index("const HELD_TEXT = {"):]
    block = block[:block.index("};")]
    found = re.findall(r'^  "([\w-]*)": \[\s*("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\]', block, re.M)
    mapped = {c: (json.loads(r), json.loads(m)) for c, r, m in found}
    engine = {c: (PacsServer._HELD_REASON[c].replace("%(name)s", "{name}"),
                  PacsServer._HELD_REMEDY[c].replace("%(name)s", "{name}"))
              for c in PacsServer._HELD_REASON}
    assert mapped == engine, sorted(set(mapped) ^ set(engine)) or "a sentence differs"


if __name__ == "__main__":
    for t in (test_the_scan_sees_the_scripts, test_no_top_level_name_is_declared_twice,
              test_people_labels_match_the_engine, test_held_texts_match_the_engine):
        t()
        print(f"  ok   {t.__name__}")
