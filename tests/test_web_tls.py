"""HTTPS for the dashboard and DICOMweb: pacs/tlsutil.py's web half, the
`tls-cert` command and the TLS path through `pacs serve`.

The servers here are real: a Werkzeug server wrapped with the context the engine
builds, and — for the end-to-end checks — `python -m pacs serve` in a child
process on a random loopback port, talked to with the standard library's ssl.

Runs under pytest, or standalone: python3 tests/test_web_tls.py
"""

from __future__ import annotations

import json
import os
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pytest                                            # noqa: E402

pytest.importorskip("cryptography")

from pacs import tlsutil                                 # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _pair(tmp, names=("pacs.example",)):
    cert = os.path.join(tmp, "c.pem")
    key = os.path.join(tmp, "k.pem")
    fp = tlsutil.generate_self_signed(cert, key, list(names), days=30)
    return cert, key, fp


def _client(cafile: str) -> ssl.SSLContext:
    ctx = ssl.create_default_context(cafile=cafile)
    return ctx


class _Server:
    """A Werkzeug server on a random port with the engine's own HTTPS context."""

    def __init__(self, cert, key):
        from flask import Flask
        from werkzeug.serving import make_server

        app = Flask("tls-test")

        @app.get("/ping")
        def ping():
            from flask import request
            return {"ok": True, "secure": request.is_secure}

        self.port = _free_port()
        self.srv = make_server("127.0.0.1", self.port, app, threaded=True,
                               ssl_context=tlsutil.web_server_context(cert, key))
        self.t = threading.Thread(target=self.srv.serve_forever, daemon=True)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *exc):
        self.srv.shutdown()
        self.srv.server_close()


# ---- the certificate -------------------------------------------------------

def test_generate_writes_0600_key_and_matching_fingerprint(tmp_path):
    cert, key, fp = _pair(str(tmp_path), names=("pacs.example", "10.1.2.3"))
    if os.name == "posix":
        assert stat.S_IMODE(os.stat(key).st_mode) == 0o600
    assert fp == tlsutil.cert_fingerprint(cert)
    assert len(fp.split(":")) == 32
    from cryptography import x509
    c = x509.load_pem_x509_certificate(open(cert, "rb").read())
    san = c.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    dns = set(san.get_values_for_type(x509.DNSName))
    ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
    assert {"pacs.example", "localhost"} <= dns
    assert {"10.1.2.3", "127.0.0.1", "::1"} <= ips


def test_regenerating_over_a_loose_key_tightens_it(tmp_path):
    if os.name != "posix":
        pytest.skip("mode bits")
    key = tmp_path / "k.pem"
    key.write_text("old")
    os.chmod(key, 0o644)
    tlsutil.generate_self_signed(str(tmp_path / "c.pem"), str(key), [], days=1)
    assert stat.S_IMODE(os.stat(key).st_mode) == 0o600


# ---- the server context ----------------------------------------------------

def test_https_request_succeeds_and_is_secure(tmp_path):
    cert, key, _ = _pair(str(tmp_path))
    with _Server(cert, key) as s:
        with urllib.request.urlopen(f"https://localhost:{s.port}/ping", context=_client(cert), timeout=5) as r:
            body = json.loads(r.read())
    assert body == {"ok": True, "secure": True}


def test_tls_1_1_is_refused(tmp_path):
    cert, key, _ = _pair(str(tmp_path))
    ctx = tlsutil.web_server_context(cert, key)
    assert ctx.minimum_version == ssl.TLSVersion.TLSv1_2
    with _Server(cert, key) as s:
        old = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        old.check_hostname = False
        old.verify_mode = ssl.CERT_NONE
        try:
            old.minimum_version = ssl.TLSVersion.TLSv1
            old.maximum_version = ssl.TLSVersion.TLSv1_1
            old.set_ciphers("ALL:@SECLEVEL=0")
        except (ValueError, ssl.SSLError):
            pytest.skip("this OpenSSL cannot even offer TLS 1.1")
        with socket.create_connection(("127.0.0.1", s.port), timeout=5) as raw:
            with pytest.raises((ssl.SSLError, ConnectionError)):
                with old.wrap_socket(raw, server_hostname="localhost") as tls:
                    tls.sendall(b"GET /ping HTTP/1.0\r\n\r\n")
                    tls.recv(10)
        # TLS 1.2 exactly still works — the floor is 1.2, not 1.3.
        v12 = _client(cert)
        v12.maximum_version = ssl.TLSVersion.TLSv1_2
        with urllib.request.urlopen(f"https://localhost:{s.port}/ping", context=v12, timeout=5) as r:
            assert r.status == 200


def test_plain_http_to_the_https_port_gets_no_answer(tmp_path):
    cert, key, _ = _pair(str(tmp_path))
    with _Server(cert, key) as s:
        with pytest.raises((urllib.error.URLError, ConnectionError, OSError)):
            urllib.request.urlopen(f"http://127.0.0.1:{s.port}/ping", timeout=5).read()


def test_a_stalled_client_does_not_block_other_requests(tmp_path):
    """The handshake runs in the worker thread, not in accept(). With the stock
    SSLContext, one TCP connection that never speaks holds the whole server."""
    cert, key, _ = _pair(str(tmp_path))
    with _Server(cert, key) as s:
        stalled = socket.create_connection(("127.0.0.1", s.port), timeout=5)
        try:
            time.sleep(0.2)
            t0 = time.monotonic()
            with urllib.request.urlopen(f"https://localhost:{s.port}/ping", context=_client(cert), timeout=5) as r:
                assert r.status == 200
            assert time.monotonic() - t0 < 3
        finally:
            stalled.close()


@pytest.mark.parametrize("case", ["missing-cert", "missing-key", "empty-key-path", "mismatch", "not-pem"])
def test_bad_cert_or_key_is_a_clear_error(tmp_path, case):
    cert, key, _ = _pair(str(tmp_path))
    os.makedirs(tmp_path / "other")
    _, other_key, _ = _pair(str(tmp_path / "other"))
    junk = tmp_path / "junk.pem"
    junk.write_text("not a certificate\n")
    args, expect = {
        "missing-cert": ((str(tmp_path / "nope.pem"), key), "does not exist"),
        "missing-key": ((cert, str(tmp_path / "nope-key.pem")), "does not exist"),
        "empty-key-path": ((cert, ""), "tls_key is not set"),
        "mismatch": ((cert, other_key), "do not belong together"),
        "not-pem": ((str(junk), key), "not a PEM"),
    }[case]
    with pytest.raises(ValueError) as ei:
        tlsutil.web_server_context(*args)
    assert expect in str(ei.value)


def test_unreadable_key_is_a_clear_error(tmp_path):
    if os.name != "posix" or os.geteuid() == 0:
        pytest.skip("needs POSIX permissions and a non-root user")
    cert, key, _ = _pair(str(tmp_path))
    os.chmod(key, 0)
    try:
        with pytest.raises(ValueError) as ei:
            tlsutil.web_server_context(cert, key)
        assert "cannot be read" in str(ei.value)
    finally:
        os.chmod(key, 0o600)


# ---- config ----------------------------------------------------------------

def test_config_refuses_tls_without_paths(tmp_path):
    from pacs.config import Config
    cfg = Config(str(tmp_path / "config.json"))
    data = json.loads(json.dumps(cfg.data))
    data["web"]["tls"] = True
    with pytest.raises(ValueError) as ei:
        cfg.replace(data)
    assert "web.tls_cert" in str(ei.value)
    data["web"]["tls"] = "yes"
    with pytest.raises(ValueError):
        cfg.replace(data)


# ---- the CLI ----------------------------------------------------------------

def _pacs(*args, timeout=60, **kw):
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    return subprocess.run([sys.executable, "-m", "pacs", *args], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=timeout, **kw)


def test_tls_cert_command_enable_and_no_overwrite(tmp_path):
    cfgp = str(tmp_path / "config.json")
    r = _pacs("-c", cfgp, "tls-cert", "--name", "pacs.example", "--enable")
    assert r.returncode == 0, r.stderr
    doc = json.load(open(cfgp))
    assert doc["web"]["tls"] is True
    assert os.path.isfile(doc["web"]["tls_cert"]) and os.path.isfile(doc["web"]["tls_key"])
    fp = tlsutil.cert_fingerprint(doc["web"]["tls_cert"])
    assert fp in r.stdout
    again = _pacs("-c", cfgp, "tls-cert")
    assert again.returncode == 2 and "--force" in again.stderr
    assert tlsutil.cert_fingerprint(doc["web"]["tls_cert"]) == fp


# How long a spawned `serve` may take to answer. http.server's server_bind()
# calls socket.getfqdn() on the bind address, and on GitHub's macOS runners
# that reverse lookup of 127.0.0.1 alone has taken over 30 s.
SERVE_START_S = 120


def _serve(cfgp, port, extra=()):
    # Output goes to files, not pipes: nobody reads a pipe while the test runs,
    # and once the engine has logged a pipe buffer's worth (16 KB on macOS) it
    # blocks on write and stops answering.
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONFAULTHANDLER="1")
    base = os.path.join(os.path.dirname(cfgp), f"serve-{port}")
    out, err = open(base + ".out", "w"), open(base + ".err", "w")
    p = subprocess.Popen([sys.executable, "-m", "pacs", "-c", cfgp, "serve", "--port", str(port), *extra],
                         cwd=ROOT, env=env, stdout=out, stderr=err, text=True)
    out.close(); err.close()
    p.logs = (base + ".out", base + ".err")
    return p


def _logs(p):
    def read(path):
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    return read(p.logs[0]), read(p.logs[1])


def _stop(p):
    p.terminate()
    try:
        p.wait(timeout=20)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    return _logs(p)


def test_serve_over_https_end_to_end(tmp_path):
    cfgp = str(tmp_path / "config.json")
    assert _pacs("-c", cfgp, "tls-cert", "--enable").returncode == 0
    cert = json.load(open(cfgp))["web"]["tls_cert"]
    port = _free_port()
    p = _serve(cfgp, port)
    try:
        deadline = time.monotonic() + SERVE_START_S
        last = None
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"https://127.0.0.1:{port}/api/auth",
                                            context=_client(cert), timeout=2) as r:
                    assert r.status == 200
                    break
            except Exception as exc:          # not up yet
                last = exc
                if p.poll() is not None:
                    break
                time.sleep(0.3)
        else:
            if hasattr(signal, "SIGABRT") and os.name == "posix" and p.poll() is None:
                p.send_signal(signal.SIGABRT)      # faulthandler: every thread's stack to stderr
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
            o, e = _logs(p)
            pytest.fail(f"engine never answered over HTTPS: {last!r}\n--- engine stdout ---\n{o[-2000:]}\n--- engine stderr ---\n{e[-6000:]}")
        assert p.poll() is None, "engine exited"
        # DICOMweb rides the same socket.
        req = urllib.request.Request(f"https://127.0.0.1:{port}/dicom-web/studies",
                                     headers={"Accept": "application/dicom+json"})
        try:
            with urllib.request.urlopen(req, context=_client(cert), timeout=5) as r:
                assert r.status in (200, 204)
        except urllib.error.HTTPError as exc:
            assert exc.code in (204, 404, 503), exc.code   # answered over TLS; disabled is fine
    finally:
        out, err = _stop(p)
    assert f"https://127.0.0.1:{port}/" in out


def test_serve_refuses_a_mismatched_pair(tmp_path):
    cfgp = str(tmp_path / "config.json")
    assert _pacs("-c", cfgp, "tls-cert", "--enable").returncode == 0
    _, other_key, _ = _pair(str(tmp_path))
    doc = json.load(open(cfgp))
    doc["web"]["tls_key"] = other_key
    json.dump(doc, open(cfgp, "w"))
    r = _pacs("-c", cfgp, "serve", "--port", str(_free_port()), timeout=60)
    assert r.returncode == 2
    assert "do not belong together" in r.stderr


def test_plain_http_off_loopback_with_a_token_warns():
    """Checked as the function `serve` calls, so nothing is ever bound to a
    reachable address by the test suite."""
    from pacs.__main__ import web_transport_warnings as w
    tok = {"auth_token": "x" * 32}
    assert any("plain HTTP" in m for m in w("0.0.0.0", tok, tls=False))
    assert any("plain HTTP" in m for m in w("192.168.1.20", tok, tls=False))
    assert w("0.0.0.0", tok, tls=True) == []
    assert w("127.0.0.1", tok, tls=False) == []
    assert w("localhost", {**tok, "behind_proxy": True}, tls=False) == []
    assert any("behind_proxy" in m for m in w("0.0.0.0", {**tok, "behind_proxy": True}, tls=True))


def _login_cookie(port: int, token: str) -> str:
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/login", method="POST",
                                 data=json.dumps({"token": token}).encode(),
                                 headers={"Content-Type": "application/json", "X-Carino": "1",
                                          "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.headers.get("Set-Cookie", "")


@pytest.mark.parametrize("behind", [False, True])
def test_forwarded_headers_are_trusted_only_behind_proxy(tmp_path, behind):
    """X-Forwarded-Proto: https makes the session cookie Secure only when
    web.behind_proxy says a proxy is there to set it; by default it is a header
    any client can send, and ignored."""
    cfgp = str(tmp_path / "config.json")
    r = _pacs("-c", cfgp, "init", "--token")
    token = next(l.split(":", 1)[1].strip() for l in r.stdout.splitlines() if "API token:" in l)
    doc = json.load(open(cfgp))
    doc["web"]["behind_proxy"] = behind
    json.dump(doc, open(cfgp, "w"))
    port = _free_port()
    p = _serve(cfgp, port)
    try:
        deadline = time.monotonic() + SERVE_START_S
        while True:
            try:
                cookie = _login_cookie(port, token)
                break
            except (urllib.error.URLError, ConnectionError):
                if p.poll() is not None or time.monotonic() > deadline:
                    raise
                time.sleep(0.3)
    finally:
        _stop(p)
    assert "carino_session=" in cookie
    assert ("Secure" in cookie) is behind, cookie


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
