"""ใช้จากนอกโรงงาน: the tunnel to the mobile app (cloudflared run by the program) - with a stand-in cloudflared."""

import io
import sys
import tarfile
import tempfile
import time
from pathlib import Path

import pytest

from partlist_studio.core import tunnel as tunnels

FAKE = """
import os, sys, time
mode = sys.argv[1]
print("INF Starting tunnel", flush=True)
if mode == "fail":
    print("ERR Unauthorized: Invalid tunnel secret", flush=True)
    sys.exit(1)
if mode == "quick":
    print("INF +-------------------------------------------+", flush=True)
    print("INF |  https://brave-cats-run-fast.trycloudflare.com  |", flush=True)
if mode == "token":
    print("INF token " + ("yes" if os.environ.get("TUNNEL_TOKEN") == "tok-123" else "no"), flush=True)
print("INF Registered tunnel connection connIndex=0 location=bkk01", flush=True)
time.sleep(30)
"""


def _wait(t, state, seconds=10):
    end = time.monotonic() + seconds
    while t.state != state and time.monotonic() < end:
        time.sleep(0.02)
    return t.state == state


@pytest.fixture
def fake(tmp_path):
    path = tmp_path / "fake_cloudflared.py"
    path.write_text(FAKE)
    return lambda mode: [sys.executable, str(path), mode]


def test_quick_tunnel_reads_its_link(tmp_path, fake):
    seen = []
    t = tunnels.Tunnel(tmp_path, 8443, tunnels.QUICK, on_change=lambda: seen.append(t.state), command=fake("quick"))
    assert t.args("cloudflared")[-3:] == ["--url", "https://localhost:8443", "--no-tls-verify"]
    t.start()
    assert _wait(t, tunnels.ON) and t.public_url == "https://brave-cats-run-fast.trycloudflare.com"
    assert tunnels.STARTING in seen
    t.stop()
    assert t.state == tunnels.OFF and not t.public_url


def test_token_tunnel_gets_its_token_from_the_environment(tmp_path, fake):
    t = tunnels.Tunnel(tmp_path, 8443, tunnels.TOKEN, token="tok-123", url="rrs.example.com/", command=fake("token"))
    assert "tok-123" not in " ".join(t.args("cloudflared"))  # not on the command line
    t.start()
    assert _wait(t, tunnels.ON) and t.public_url == "https://rrs.example.com"
    assert any("token yes" in line for line in t.log)
    t.stop()
    missing = tunnels.Tunnel(tmp_path, 8443, tunnels.TOKEN, token="", url="")
    missing.start()
    assert missing.state == tunnels.ERROR and "โทเคน" in missing.error


def test_tunnel_that_stops_reports_why(tmp_path, fake):
    t = tunnels.Tunnel(tmp_path, 8443, tunnels.TOKEN, token="bad", url="https://rrs.example.com", command=fake("fail"))
    t.start()
    assert _wait(t, tunnels.ERROR) and "โทเคนไม่ถูกต้อง" in t.error and not t.public_url


def test_own_link_and_cloudflared_files(tmp_path, monkeypatch):
    own = tunnels.Tunnel(tmp_path, 8443, tunnels.OWN, url="pc-office.tailnet-abc.ts.net")
    own.start()
    assert own.state == tunnels.ON and own.public_url == "https://pc-office.tailnet-abc.ts.net"
    own.stop()
    assert own.state == tunnels.OFF
    assert tunnels.asset_name("win32", "AMD64") == "cloudflared-windows-amd64.exe"
    assert tunnels.asset_name("darwin", "x86_64") == "cloudflared-darwin-amd64.tgz"
    assert tunnels.asset_name("darwin", "arm64") == "cloudflared-darwin-arm64.tgz"
    assert tunnels.asset_name("linux", "aarch64") == "cloudflared-linux-arm64"

    program = b"\x7fELF" + b"x" * 2_000_000
    packed = io.BytesIO()
    with tarfile.open(fileobj=packed, mode="w:gz") as tar:
        info = tarfile.TarInfo("cloudflared")
        info.size = len(program)
        tar.addfile(info, io.BytesIO(program))

    class Resp(io.BytesIO):
        headers = {"Content-Length": str(len(packed.getvalue()))}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    urls, done = [], []
    monkeypatch.setattr(tunnels, "asset_name", lambda: "cloudflared-darwin-arm64.tgz")
    monkeypatch.setattr(tunnels, "_exe_name", lambda: "cloudflared")
    path = tunnels.download_cloudflared(tmp_path, lambda a, b: done.append((a, b)),
                                        lambda url, timeout: urls.append(url) or Resp(packed.getvalue()))
    assert path.read_bytes() == program and urls == [tunnels.RELEASES + "cloudflared-darwin-arm64.tgz"] and done
    assert tunnels.find_cloudflared(tmp_path) == path
    with pytest.raises(OSError):  # an error page instead of the program
        tunnels.download_cloudflared(tmp_path / "x", None, lambda url, timeout: Resp(b"<html>rate limited</html>"))


def test_short_link_from_is_gd_else_tinyurl():
    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    asked = []

    def opener(url, timeout):
        asked.append(url)
        if "is.gd" in url:
            raise OSError("down")
        return Resp(b"https://tinyurl.com/2abc9xyz\n")

    long = "https://encouraging-referring-grass-arabic.trycloudflare.com/"
    assert tunnels.shorten(long, opener) == "https://tinyurl.com/2abc9xyz"
    assert "is.gd" in asked[0] and "encouraging-referring-grass-arabic.trycloudflare.com" in asked[0]
    assert tunnels.shorten(long, lambda url, timeout: Resp(b"Error: rate limit")) == ""  # not a short link
    assert tunnels.shorten("", opener) == ""


def test_download_errors_in_words_not_html():
    import ssl
    import urllib.error

    bad_cert = urllib.error.URLError(ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"))
    assert "CERTIFICATE_VERIFY_FAILED" in tunnels.describe_error(bad_cert) and "<" not in tunnels.describe_error(bad_cert)
    assert "หมดเวลา" in tunnels.describe_error(urllib.error.URLError(TimeoutError("timed out")))
    assert tunnels.describe_error(OSError()) == "OSError"

    def refuse(url, timeout):
        raise bad_cert

    with pytest.raises(OSError, match="CERTIFICATE_VERIFY_FAILED"):  # tests: no curl
        tunnels.download_cloudflared(Path(tempfile.mkdtemp()), None, refuse)
    assert tunnels.ssl_context().verify_mode == ssl.CERT_REQUIRED
    assert tunnels.install_hint()


def test_download_falls_back_to_curl(tmp_path, monkeypatch):
    import ssl
    import urllib.error

    program = b"\x7fELF" + b"x" * 1_200_000
    (tmp_path / "src.bin").write_bytes(program)
    curl = tmp_path / "fakecurl.py"
    curl.write_text("import shutil, sys\nshutil.copy(sys.argv[-1].replace('URL', ''), sys.argv[sys.argv.index('-o') + 1])\n")
    monkeypatch.setattr(tunnels, "_exe_name", lambda: "cloudflared")
    monkeypatch.setattr(tunnels, "RELEASES", str(tmp_path) + "/")
    monkeypatch.setattr(tunnels, "asset_name", lambda: "src.bin")
    calls = []
    real_popen = tunnels.subprocess.Popen

    def popen(cmd, **kw):
        calls.append(cmd)
        return real_popen([sys.executable, str(curl), *cmd[1:]], **kw)

    monkeypatch.setattr(tunnels.subprocess, "Popen", popen)

    def refuse(url, timeout):
        raise urllib.error.URLError(ssl.SSLCertVerificationError(1, "CERTIFICATE_VERIFY_FAILED"))

    path = tunnels.download_cloudflared(tmp_path / "data", None, refuse, curl="curl")
    assert path.read_bytes() == program and calls and calls[0][0] == "curl"
    assert not list((tmp_path / "data" / "bin").glob("*.download"))


def test_install_cloudflared_by_hand(tmp_path, monkeypatch):
    monkeypatch.setattr(tunnels, "_exe_name", lambda: "cloudflared")
    program = b"\xcf\xfa\xed\xfe" + b"m" * 1_100_000
    packed = tmp_path / "cloudflared-darwin-amd64.tgz"
    with tarfile.open(packed, "w:gz") as tar:
        info = tarfile.TarInfo("cloudflared")
        info.size = len(program)
        tar.addfile(info, io.BytesIO(program))
    path = tunnels.install_cloudflared(tmp_path / "data", packed)
    assert path.read_bytes() == program and tunnels.find_cloudflared(tmp_path / "data") == path
    (tmp_path / "note.txt").write_text("hello")
    with pytest.raises(OSError):
        tunnels.install_cloudflared(tmp_path / "data2", tmp_path / "note.txt")
