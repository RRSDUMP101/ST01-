"""ใช้จากนอกโรงงาน: the tunnel to the mobile app (cloudflared run by the program) - with a stand-in cloudflared."""

import io
import sys
import tarfile
import time

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
