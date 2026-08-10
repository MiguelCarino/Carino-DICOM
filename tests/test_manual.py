"""The bundled manual, served by the appliance rather than fetched from the web.

Runs under pytest, or standalone: python3 tests/test_manual.py

The point of bundling it is that a box on an isolated clinical VLAN still has
the page explaining what a held study is, so what these tests protect is
*offline completeness*: not that /manual/ answers 200, but that every stylesheet,
script and figure it asks for answers from this server too. A manual that loads
its navbar from the internet is a manual that is blank exactly when it is needed.

The same files are published by GitHub Pages out of docs/manual/, and neither
copy may be edited for the other — so the tests assert the markup is untouched
(no absolute /manual/ paths crept in) as much as they assert the routes work.
"""

from __future__ import annotations

import os
import re
import sys
from urllib.parse import urljoin

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs.web import MANUAL_DIR, create_app              # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_web_auth import FakeServer                     # noqa: E402

# The set the manual ships in. Named rather than discovered from the directory
# listing: a language that silently stopped being served would still make a
# discovered list agree with itself.
LANGS = ["", "es/", "pt-BR/", "ja/", "ru/"]


@pytest.fixture()
def client(tmp_path):
    return create_app(FakeServer(str(tmp_path))).test_client()


def test_the_manual_is_bundled_at_all():
    """If this fails, every other test here is vacuous rather than passing."""
    assert MANUAL_DIR, "pacs.web.MANUAL_DIR resolved to nothing"
    assert os.path.isfile(os.path.join(MANUAL_DIR, "index.html"))


@pytest.mark.parametrize("lang", LANGS)
def test_every_language_is_served(client, lang):
    resp = client.get("/manual/" + lang)
    assert resp.status_code == 200
    assert b"<html" in resp.data.lower()


def test_a_language_without_its_trailing_slash_is_redirected(client):
    """Not cosmetic. Every translated page reaches its stylesheet as
    ../manual.css and the fleet scripts as ../../, and a browser resolves those
    against the directory it believes it is in. Answered at /manual/es the page
    would look one level too high and arrive unstyled, with no navbar."""
    resp = client.get("/manual/es")
    assert resp.status_code == 301
    assert resp.headers["Location"].endswith("/manual/es/")


def test_the_bare_prefix_is_redirected(client):
    assert client.get("/manual").status_code == 301


@pytest.mark.parametrize("lang", LANGS)
def test_every_subresource_resolves_from_this_server(client, lang):
    """The offline guarantee, asserted rather than assumed.

    Anything the page needs in order to render — stylesheet, script, figure —
    must come from this appliance. Links a reader may CHOOSE to follow
    (carino.systems, github.com) are not subresources and are left alone; a
    reader clicking one on a disconnected box learns that immediately, which is
    not the same as a page that renders wrong without saying why.
    """
    page = "/manual/" + lang
    html = client.get(page).get_data(as_text=True)
    missing = []
    for ref in re.findall(r'(?:src|href)="([^"]+)"', html):
        if ref.startswith(("#", "mailto:", "http://", "https://")):
            continue
        target = urljoin(page, ref)
        if client.get(target).status_code not in (200, 301, 302):
            missing.append((ref, target))
    assert not missing, f"{page} needs resources this server will not serve: {missing}"


@pytest.mark.parametrize("lang", LANGS)
def test_nothing_is_loaded_from_another_host(lang):
    """A <script> or <link> pointing at the internet would defeat the bundling
    even though every local path still resolved — the page would render, minus
    whatever the network was supposed to supply."""
    path = os.path.join(MANUAL_DIR, lang, "index.html")
    html = open(path, encoding="utf-8").read()
    external = re.findall(r'<(?:script|link)[^>]*(?:src|href)="(https?://[^"]+)"', html)
    assert not external, f"{path} loads {external} from off this machine"


@pytest.mark.parametrize("lang", LANGS)
def test_the_published_copy_is_not_rewritten_for_this_server(lang):
    """docs/manual/ is one directory serving two hosts. An absolute /manual/...
    path would work here and 404 on GitHub Pages, and the failure would be
    invisible from this side."""
    path = os.path.join(MANUAL_DIR, lang, "index.html")
    html = open(path, encoding="utf-8").read()
    assert 'href="/manual/' not in html
    assert 'src="/manual/' not in html


@pytest.mark.parametrize("attempt", [
    "../../etc/passwd",
    "./../pacs/web.py",
    "..%2f..%2fetc%2fpasswd",
    "../config.json",
])
def test_the_manual_route_refuses_to_climb_out_of_its_directory(client, attempt):
    assert client.get("/manual/" + attempt).status_code == 404


def test_a_missing_page_is_a_404_not_a_500(client):
    assert client.get("/manual/nope/").status_code == 404
    assert client.get("/manual/nope.html").status_code == 404


def test_the_manual_needs_no_credential(tmp_path):
    """It is the document that explains the token rule. Gating it behind the
    token would be a locked door with the key inside — and it carries no patient
    data and no configuration, which is the same reason the dashboard shell
    itself is public."""
    srv = FakeServer(str(tmp_path))
    with srv.cfg.mutate():
        srv.cfg.web["auth_token"] = "a" * 43
        srv.cfg.save()
    anon = create_app(srv).test_client()
    assert anon.get("/api/status").status_code == 401       # the gate is really up
    assert anon.get("/manual/").status_code == 200          # and the manual is past it


def test_the_dashboard_offers_the_manual():
    """A bundled manual nothing links to is a bundled manual nobody reads. The
    link is hidden until app.js probes for it, so both halves have to exist."""
    web_dir = os.path.join(os.path.dirname(MANUAL_DIR), "..", "pacs", "web")
    web_dir = os.path.normpath(web_dir)
    index = open(os.path.join(web_dir, "index.html"), encoding="utf-8").read()
    assert 'id="manualLink"' in index
    app_js = open(os.path.join(web_dir, "app.js"), encoding="utf-8").read()
    assert "probeManual" in app_js


def test_the_assets_the_manual_borrows_from_the_dashboard_are_present(client):
    """The pages reach these as ../ from /manual/, which lands on the dashboard
    root. They live in docs/ for the published copy and had to be added to
    pacs/web/ for this one; nothing in the markup says so, so nothing would
    report their absence except a manual that renders wrong."""
    for asset in ("carino-clock.js", "carino-lang.js", "carino-navbar.js",
                  "favicon.webp"):
        assert client.get("/" + asset).status_code == 200, asset


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
