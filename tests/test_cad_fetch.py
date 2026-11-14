"""tools/cad_fetch.py: download from (a local stand-in for) Google Drive, unpack untrusted archives, inventory.

Nothing here leaves the machine: Drive is an http.server on 127.0.0.1, the refusing proxy a socket on 127.0.0.1.
A real RAR cannot be made in this environment (no rar program; 7z and unar only read the format), so the RAR5
archives below are built by hand from the published format with stored (uncompressed) entries: enough for 7z and
unar to take them as RAR5, with Thai names, links and a missing volume. A WinRAR-compressed or encrypted RAR is
not covered by a test.
"""

import importlib.util
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import pytest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "cad_fetch.py"
spec = importlib.util.spec_from_file_location("cad_fetch", TOOL)
cf = importlib.util.module_from_spec(spec)
sys.modules["cad_fetch"] = cf  # dataclasses look their module up by name
spec.loader.exec_module(cf)

needs_curl = pytest.mark.skipif(not shutil.which("curl"), reason="curl is not installed")
needs_7z = pytest.mark.skipif(not shutil.which("7z"), reason="7z is not installed")
needs_unar = pytest.mark.skipif(not (shutil.which("unar") and shutil.which("lsar")), reason="unar is not installed")

PAYLOAD = bytes(range(256)) * 1200  # 307,200 bytes that are different everywhere
THAI_NAME = "พื้นเรียบ ford.rar"
SMALL, LARGE, FORBIDDEN, QUOTA, SNEAKY, BUSY, PLAIN, GONE = (
    "small-file-0001", "large-file-0001", "forbidden-0001", "quota-page-0001", "sneaky-html-0001", "busy-file-0001",
    "plain-old-0001", "gone-file-0001")
HTML = b"<!DOCTYPE html><html><head><title>Google Drive - Quota exceeded</title></head><body>Too many users</body></html>"


# --------------------------------------------------------------------------- a stand-in for Google Drive
class _DriveHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def _send(self, status: int, body: bytes, ctype: str = "text/html; charset=utf-8", extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _file(self, data: bytes) -> None:
        """The file, with Range like Drive. `cut`: the first long answer stops after that many bytes."""
        st = self.server.state
        start, end, status = 0, len(data) - 1, 200
        found = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range") or "")
        if found:
            start, status = int(found.group(1)), 206
            end = min(int(found.group(2)), end) if found.group(2) else end
            if start >= len(data):
                return self._send(416, b"", extra={"Content-Range": f"bytes */{len(data)}"})
        body = data[start:end + 1]
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f"attachment; filename=\"x.rar\"; filename*=UTF-8''{quote(THAI_NAME)}")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        self.end_headers()
        if st["cut"] and len(body) > st["cut"]:
            self.wfile.write(body[:st["cut"]])
            self.wfile.flush()
            st["cut"] = 0
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)  # the line drops in the middle of the file
            return
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        st = self.server.state
        url = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        fid = q.get("id", "")
        st["hits"].append({"path": url.path, "id": fid, "range": self.headers.get("Range"), "uuid": q.get("uuid")})
        data = st["data"]
        if fid == SMALL and url.path == "/uc":
            self._file(data)
        elif fid == LARGE and url.path == "/uc":  # Drive sends the browser on to the usercontent host
            self._send(303, b"", extra={"Location": f"/download?id={fid}&export=download"})
        elif fid == LARGE and url.path == "/download" and (q.get("confirm"), q.get("uuid")) == ("t", "u-123"):
            self._file(data)
        elif fid == LARGE and url.path == "/download":
            page = f"""<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>
                <p class="uc-warning-caption">Google Drive can't scan this file for viruses.</p>
                <form id="download-form" action="{st['base']}/download" method="get">
                <input type="submit" id="uc-download-link" value="Download anyway"/>
                <input type="hidden" name="id" value="{fid}"><input type="hidden" name="export" value="download">
                <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-123">
                </form></body></html>"""
            self._send(200, page.encode())
        elif fid == FORBIDDEN:
            self._send(403, b"<html><body>Forbidden</body></html>")
        elif fid == QUOTA:
            self._send(200, HTML)
        elif fid == SNEAKY:  # says it is the file, sends a page
            self._file(HTML)
        elif fid == BUSY and st["busy"] > 0:
            st["busy"] -= 1
            self._send(503, b"busy")
        elif fid == BUSY:
            self._file(data)
        elif fid == PLAIN:  # an old server: no Range, no length, the body ends when the line closes
            self.protocol_version = "HTTP/1.0"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True
        else:
            self._send(404, b"<html><body>Not found</body></html>")


@pytest.fixture
def drive(monkeypatch):
    """(base URL, state) of a local Drive. No proxy is used for it, whatever the session has."""
    for name in ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    server = ThreadingHTTPServer(("127.0.0.1", 0), _DriveHandler)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    server.state = {"data": PAYLOAD, "hits": [], "cut": 0, "busy": 0, "base": base}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield base, server.state
    server.shutdown()
    server.server_close()


def _get(base, file_id, dest, size=None, **kw):
    log, waits = [], []
    kw.setdefault("backoff", 1.0)
    out = cf.download(file_id, dest, size, base=base, usercontent_base=base, progress_every=0.05, sleep=waits.append,
                      log=log.append, **kw)
    return out, log, waits


def test_drive_id():
    fid = "1QJyzTlPcYo3eY48YU3DCWCUhs2BQ-6UN"
    assert cf.drive_id(fid) == fid
    assert cf.drive_id(f"https://drive.google.com/file/d/{fid}/view?usp=sharing") == fid
    assert cf.drive_id(f"https://drive.google.com/uc?export=download&id={fid}") == fid
    assert cf.drive_id(f"https://drive.google.com/open?id={fid}") == fid
    assert cf.drive_id(f"https://drive.usercontent.google.com/download?id={fid}&confirm=t") == fid
    with pytest.raises(cf.FetchError):
        cf.drive_id("https://example.com/nothing")


def test_confirm_form_is_read_and_only_followed_to_drive():
    page = """<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
        <input type="hidden" name="id" value="ABC&amp;1"><input type="hidden" name="export" value="download">
        <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="9f-1"></form>"""
    bases = (cf.DRIVE_BASE, cf.USERCONTENT_BASE)
    url = cf.confirm_url(page, "https://drive.usercontent.google.com/download?id=x", bases)
    assert url == "https://drive.usercontent.google.com/download?id=ABC%261&export=download&confirm=t&uuid=9f-1"
    assert cf.confirm_url("<html><body>no form</body></html>", cf.DRIVE_BASE, bases) is None
    with pytest.raises(cf.FetchError):  # a page cannot send the download somewhere else
        cf.confirm_url(page.replace("drive.usercontent.google.com", "evil.example"), cf.DRIVE_BASE, bases)


@needs_curl
def test_small_file_is_served_directly(drive, tmp_path):
    base, st = drive
    dest = tmp_path / "งาน" / "small.bin"
    out, log, waits = _get(base, SMALL, dest, len(PAYLOAD))
    assert out == dest and dest.read_bytes() == PAYLOAD
    assert not dest.with_name("small.bin.part").exists() and waits == []
    assert st["hits"][0]["range"] == "bytes=0-0"  # the question first, then the file
    assert any(THAI_NAME in line for line in log)  # the name Drive gives, Thai intact


@needs_curl
def test_large_file_goes_through_the_virus_scan_form(drive, tmp_path):
    base, st = drive
    dest = tmp_path / "large.bin"
    _get(base, f"{base}/file/d/{LARGE}/view?usp=sharing", dest, len(PAYLOAD))
    assert dest.read_bytes() == PAYLOAD
    paths = [(h["path"], h["uuid"]) for h in st["hits"]]
    assert ("/uc", None) in paths and ("/download", None) in paths  # the redirect, then the page with the form
    assert paths[-1] == ("/download", "u-123")  # the file itself, with what the form's hidden inputs hold


@needs_curl
def test_cut_connection_is_resumed_with_range(drive, tmp_path):
    base, st = drive
    st["cut"] = 100_000
    dest = tmp_path / "cut.bin"
    _out, log, waits = _get(base, LARGE, dest, len(PAYLOAD))
    assert dest.read_bytes() == PAYLOAD
    assert "bytes=100000-" in [h["range"] for h in st["hits"]]  # continued, not started again
    assert waits == [1.0]  # one short wait: a cut after new bytes is not counted as a failure
    assert any("ทำต่อจาก" in line for line in log)


@needs_curl
def test_partial_file_of_an_earlier_run_is_continued(drive, tmp_path):
    base, st = drive
    dest = tmp_path / "later.bin"
    dest.with_name("later.bin.part").write_bytes(PAYLOAD[:123_456])
    _get(base, SMALL, dest, len(PAYLOAD))
    assert dest.read_bytes() == PAYLOAD
    assert "bytes=123456-" in [h["range"] for h in st["hits"]]
    # a partial file longer than the file is not a piece of it: thrown away
    dest.unlink()
    dest.with_name("later.bin.part").write_bytes(b"x" * (len(PAYLOAD) + 5))
    _get(base, SMALL, dest, len(PAYLOAD))
    assert dest.read_bytes() == PAYLOAD


@needs_curl
def test_http_403_and_404_stop_without_retry(drive, tmp_path):
    base, st = drive
    with pytest.raises(cf.FetchError) as e:
        _get(base, FORBIDDEN, tmp_path / "f.bin")
    assert "403" in str(e.value) and not isinstance(e.value, cf.PolicyDenied)
    assert len(st["hits"]) == 1 and not list(tmp_path.iterdir())
    with pytest.raises(cf.FetchError) as e:
        _get(base, GONE, tmp_path / "g.bin")
    assert "404" in str(e.value) and len(st["hits"]) == 2


@needs_curl
def test_busy_server_is_retried_with_backoff(drive, tmp_path):
    base, st = drive
    st["busy"] = 3
    dest = tmp_path / "busy.bin"
    _out, _log, waits = _get(base, BUSY, dest, len(PAYLOAD))
    assert dest.read_bytes() == PAYLOAD and waits == [1.0, 2.0, 4.0]
    st["busy"] = 99  # it never gets better: give up after `retries` tries, each wait longer than the last
    with pytest.raises(cf.FetchError) as e:
        _get(base, BUSY, tmp_path / "never.bin", retries=2)
    assert "2 ครั้ง" in str(e.value) and not (tmp_path / "never.bin").exists()


@needs_curl
def test_html_page_instead_of_the_file_is_refused(drive, tmp_path):
    base, _st = drive
    with pytest.raises(cf.FetchError) as e:  # a page without the form: quota, login …
        _get(base, QUOTA, tmp_path / "q.bin")
    assert "Quota exceeded" in str(e.value)
    with pytest.raises(cf.FetchError) as e:  # a page sent as if it were the file
        _get(base, SNEAKY, tmp_path / "s.bin")
    assert "HTML" in str(e.value)
    assert not list(tmp_path.iterdir())  # neither the file nor its .part stays


@needs_curl
def test_wrong_size_is_refused(drive, tmp_path):
    base, st = drive
    with pytest.raises(cf.FetchError) as e:  # the server tells the size: refused before the transfer
        _get(base, SMALL, tmp_path / "w.bin", len(PAYLOAD) + 1)
    assert f"{len(PAYLOAD):,}" in str(e.value) and f"{len(PAYLOAD) + 1:,}" in str(e.value)
    assert len(st["hits"]) == 1 and not list(tmp_path.iterdir())
    dest = tmp_path / "p.bin"
    with pytest.raises(cf.FetchError) as e:  # it does not: the finished file is measured
        _get(base, PLAIN, dest, len(PAYLOAD) - 7)
    assert "ขนาดไม่ตรง" in str(e.value) and not dest.exists() and dest.with_name("p.bin.part").exists()
    dest.with_name("p.bin.part").unlink()
    _get(base, PLAIN, dest, len(PAYLOAD))  # the same old server, the right size
    assert dest.read_bytes() == PAYLOAD


def test_existing_file_is_kept(tmp_path):
    dest = tmp_path / "have.bin"
    dest.write_bytes(b"12345")
    nowhere = "http://127.0.0.1:9"  # not asked at all
    assert cf.download(SMALL, dest, 5, base=nowhere, usercontent_base=nowhere, log=lambda _t: None) == dest
    with pytest.raises(cf.FetchError):
        cf.download(SMALL, dest, 6, base=nowhere, usercontent_base=nowhere, log=lambda _t: None)
    with pytest.raises(cf.FetchError):
        cf.download(SMALL, dest, base=nowhere, usercontent_base=nowhere, log=lambda _t: None)
    assert dest.read_bytes() == b"12345"


@pytest.fixture
def refusing_proxy(monkeypatch):
    """A proxy on 127.0.0.1 that answers every CONNECT with 403, like the session's proxy for a host that is not
    allowed. curl talks to it alone, so nothing reaches the host named in the request."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    seen: list[str] = []

    def serve():
        while True:
            try:
                conn, _addr = sock.accept()
            except OSError:
                return
            with conn:
                seen.append(conn.recv(4096).decode("latin-1").splitlines()[0])
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied")

    threading.Thread(target=serve, daemon=True).start()
    proxy = f"http://127.0.0.1:{sock.getsockname()[1]}"
    for name in ("HTTPS_PROXY", "https_proxy"):
        monkeypatch.setenv(name, proxy)
    for name in ("NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    yield seen
    sock.close()


@needs_curl
def test_proxy_policy_denial_stops_at_once_and_names_the_hosts(refusing_proxy, tmp_path, capsys):
    waits = []
    with pytest.raises(cf.PolicyDenied) as e:
        cf.download("1QJyzTlPcYo3eY48YU3DCWCUhs2BQ-6UN", tmp_path / "ford.rar", 3539808068, sleep=waits.append,
                    log=lambda _t: None)
    assert "drive.google.com" in str(e.value) and "drive.usercontent.google.com" in str(e.value)
    assert "403" in str(e.value)
    assert refusing_proxy == ["CONNECT drive.google.com:443 HTTP/1.1"] and waits == []  # asked once, no retry
    assert not list(tmp_path.iterdir())
    assert cf.main(["download", "1QJyzTlPcYo3eY48YU3DCWCUhs2BQ-6UN", str(tmp_path / "ford.rar")]) == 3
    assert "drive.usercontent.google.com" in capsys.readouterr().err


# --------------------------------------------------------------------------- archives
def _vint(n: int) -> bytes:
    out = bytearray()
    while True:
        out.append((n & 0x7F) | (0x80 if n >> 7 else 0))
        n >>= 7
        if not n:
            return bytes(out)


def _rar_block(kind: int, flags: int, body: bytes, extra: bytes = b"", data: bytes | None = None) -> bytes:
    flags |= (1 if extra else 0) | (2 if data is not None else 0)
    head = (_vint(kind) + _vint(flags) + (_vint(len(extra)) if extra else b"")
            + (_vint(len(data)) if data is not None else b"") + body + extra)
    sized = _vint(len(head)) + head
    return struct.pack("<I", zlib.crc32(sized)) + sized + (data or b"")


def rar5(entries: list[dict], volume: bool = False) -> bytes:
    """A RAR5 archive by hand: entries stored without compression. {'name', 'data'} a file · {'name', 'dir': True}
    · {'name', 'link': target} a Unix symbolic link · 'split': the data goes on in a next volume."""
    out = b"Rar!\x1a\x07\x01\x00" + _rar_block(1, 0, _vint(1 if volume else 0))
    for e in entries:
        name, data, link = e["name"].encode("utf-8"), e.get("data", b""), e.get("link")
        plain = not (e.get("dir") or link)
        body = _vint((1 if e.get("dir") else 0) | (4 if plain else 0)) + _vint(len(data) if plain else 0)
        body += _vint(0o40755 if e.get("dir") else 0o120777 if link else 0o100644)
        body += (struct.pack("<I", zlib.crc32(data)) if plain else b"") + _vint(0) + _vint(1) + _vint(len(name)) + name
        extra = b""
        if link:  # the 'redirection' record: type 5, a Unix symlink (1), no flags, the target
            record = _vint(5) + _vint(1) + _vint(0) + _vint(len(link.encode("utf-8"))) + link.encode("utf-8")
            extra = _vint(len(record)) + record
        out += _rar_block(2, 0x10 if e.get("split") else 0, body, extra, data if plain else None)
    return out + _rar_block(5, 0, _vint(1 if volume else 0))


def _seven(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(["7z", *args], cwd=cwd, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)


THAI_TREE = {"แบบ/คานขวาง 01.stp": b"ISO-10303-21;\n", "แบบ/ชิ้นส่วน/แผ่นพื้น (2).stl": b"solid x\nendsolid x\n",
             "readme.txt": "สวัสดี\n".encode()}


def _write_tree(root: Path, tree: dict[str, bytes]) -> None:
    for rel, data in tree.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(data)


def _read_tree(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file() and not p.is_symlink()}


def _zip(path: Path, entries: dict[str, bytes], links: dict[str, str] | None = None) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            info = zipfile.ZipInfo("x")
            info.filename = name  # as it is: zipfile would tidy a name given to the constructor
            info.flag_bits |= 0x800  # the name is UTF-8
            info.external_attr = 0o100644 << 16
            z.writestr(info, data)
        for name, target in (links or {}).items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = 0o120777 << 16  # a Unix symbolic link: its data is the target
            z.writestr(info, target)
    return path


def _unpack(archive, dest, **kw):
    return cf.unpack(archive, dest, log=lambda _t: None, **kw)


@needs_7z
def test_unpack_zip_7z_and_rar5_keep_thai_names(tmp_path):
    src = tmp_path / "src"
    _write_tree(src, THAI_TREE)
    made = {"zip": _zip(tmp_path / "งาน ford.zip", THAI_TREE), "7z": tmp_path / "งาน ford.7z", "Rar5": tmp_path / "งาน ford.rar"}
    _seven("a", str(made["7z"]), ".", cwd=src)
    made["Rar5"].write_bytes(rar5([{"name": "แบบ", "dir": True}, {"name": "แบบ/ชิ้นส่วน", "dir": True}]
                                  + [{"name": k, "data": v} for k, v in THAI_TREE.items()]))
    for kind, archive in made.items():
        dest = tmp_path / "out" / f"แตก {kind}"
        got = _unpack(archive, dest)
        assert _read_tree(dest) == THAI_TREE
        assert (got["tool"], got["kind"], got["files"]) == ("7z", kind, 3)
        assert got["bytes"] == sum(map(len, THAI_TREE.values()))
    (tmp_path / "empty").mkdir()  # an empty folder that is already there is as good as a new one
    _unpack(made["zip"], tmp_path / "empty")
    assert _read_tree(tmp_path / "empty") == THAI_TREE


@needs_unar
def test_unpack_with_unar_as_the_other_tool(tmp_path):
    archive = _zip(tmp_path / "a.zip", THAI_TREE)
    got = _unpack(archive, tmp_path / "z", tools=("unar",))
    assert got["tool"] == "unar" and _read_tree(tmp_path / "z") == THAI_TREE
    (tmp_path / "a.rar").write_bytes(rar5([{"name": k, "data": v} for k, v in THAI_TREE.items()]))
    _unpack(tmp_path / "a.rar", tmp_path / "r", tools=("unar",))
    assert _read_tree(tmp_path / "r") == THAI_TREE
    with pytest.raises(cf.UnsafeArchive):
        _unpack(_zip(tmp_path / "slip.zip", {"ok.txt": b"ok", "../evil.txt": b"evil"}), tmp_path / "s", tools=("unar",))
    assert not (tmp_path / "s").exists() and not (tmp_path / "evil.txt").exists()


@needs_7z
def test_zip_slip_and_absolute_paths_are_refused_before_anything_is_written(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    target = tmp_path / "abs_evil.txt"
    cases = {"slip": {"ok.txt": b"ok", "../evil.txt": b"evil"}, "deep": {"a/b/../../../evil.txt": b"evil"},
             "abs": {"ok.txt": b"ok", str(target): b"evil"}, "backslash": {"..\\evil.txt": b"evil"},
             "drive": {"C:\\Windows\\evil.txt": b"evil"}}
    for name, entries in cases.items():
        dest = work / f"out_{name}"
        with pytest.raises(cf.UnsafeArchive) as e:
            _unpack(_zip(work / f"{name}.zip", entries), dest)
        assert "ยังไม่ได้เขียนไฟล์ใดเลย" in str(e.value)
        assert not dest.exists()  # not even the folder
    assert not target.exists() and not (work / "evil.txt").exists() and not (tmp_path / "evil.txt").exists()
    assert cf.main(["unpack", str(work / "slip.zip"), str(work / "cli")]) == 1 and not (work / "cli").exists()


@needs_7z
def test_links_out_are_refused_links_inside_are_kept(tmp_path):
    out_zip = _zip(tmp_path / "out.zip", {"แบบ/a.txt": b"a"}, {"แบบ/ทางออก": "../../outside"})
    abs_zip = _zip(tmp_path / "abs.zip", {"a.txt": b"a"}, {"etc": "/etc"})
    through = _zip(tmp_path / "through.zip", {"sub/a.txt": b"a", "l/b.txt": b"b"}, {"l": "sub"})
    src = tmp_path / "src"
    _write_tree(src, {"d/a.txt": b"a"})
    os.symlink("../../outside", src / "d" / "out")
    _seven("a", "-snl", str(tmp_path / "out.7z"), ".", cwd=src)
    (tmp_path / "out.rar").write_bytes(rar5([{"name": "ok.txt", "data": b"ok"}, {"name": "sub/out", "link": "../../x"}]))
    for archive in (out_zip, abs_zip, through, tmp_path / "out.7z", tmp_path / "out.rar"):
        dest = tmp_path / f"d_{archive.name}"
        with pytest.raises(cf.UnsafeArchive):
            _unpack(archive, dest)
        assert not dest.exists()
    inside = _zip(tmp_path / "in.zip", {"แบบ/a.txt": b"a"}, {"แบบ/ทางลัด": "a.txt", "top": "แบบ/a.txt"})
    _unpack(inside, tmp_path / "in")
    assert os.readlink(tmp_path / "in" / "แบบ" / "ทางลัด") == "a.txt" and (tmp_path / "in" / "top").read_bytes() == b"a"
    (tmp_path / "in.rar").write_bytes(rar5([{"name": "a.txt", "data": b"a"}, {"name": "sub/back", "link": "../a.txt"}]))
    _unpack(tmp_path / "in.rar", tmp_path / "in_rar")
    assert (tmp_path / "in_rar" / "sub" / "back").read_bytes() == b"a"


def test_unsafe_entries_rules():
    E = cf.Entry
    assert cf.unsafe_entries([E("a/b.txt", 1), E("a", is_dir=True), E("a/l", link="b.txt"), E("a/up", link="../a/b.txt")]) == []
    assert len(cf.unsafe_entries([E("a/../../b")])) == 1
    assert len(cf.unsafe_entries([E("/etc/passwd")])) == 1
    assert len(cf.unsafe_entries([E("")])) == 1 and len(cf.unsafe_entries([E("a\nb")])) == 1
    assert len(cf.unsafe_entries([E("l", link="")])) == 1  # a link nobody can check
    assert len(cf.unsafe_entries([E("d/l", link="../..")])) == 1
    assert len(cf.unsafe_entries([E("d/h", link="../x", hard=True)])) == 1  # a hard link counts from the top
    assert cf.unsafe_entries([E("d/h", link="x", hard=True)]) == []
    # each link stays inside by its own text, but the second is written through the first: one folder further up
    assert cf.unsafe_entries([E("d/l1", link=".."), E("d/l1/l2", link="..")])


def test_verify_tree_removes_a_link_that_leads_out(tmp_path):
    dest = tmp_path / "dest"
    _write_tree(dest, {"a/b.txt": b"b"})
    os.symlink(tmp_path, dest / "a" / "up")
    with pytest.raises(cf.UnsafeArchive):
        cf.verify_tree(dest, [cf.Entry("a/b.txt", 1)])
    assert not os.path.lexists(dest / "a" / "up") and (dest / "a" / "b.txt").exists()
    cf.verify_tree(dest, [cf.Entry("a/b.txt", 1)])
    with pytest.raises(cf.FetchError) as e:  # listed, but not in the folder: it went somewhere else
        cf.verify_tree(dest, [cf.Entry("a/b.txt", 1), cf.Entry("a/missing.txt", 1)])
    assert "a/missing.txt" in str(e.value)


@needs_7z
def test_encrypted_archive_is_named_as_such(tmp_path):
    src = tmp_path / "src"
    _write_tree(src, THAI_TREE)
    _seven("a", "-psecret", str(tmp_path / "data.7z"), ".", cwd=src)  # the files are encrypted, the names are not
    _seven("a", "-psecret", "-mhe=on", str(tmp_path / "names.7z"), ".", cwd=src)  # the names too
    for name in ("data.7z", "names.7z"):
        dest = tmp_path / f"out_{name}"
        with pytest.raises(cf.FetchError) as e:
            _unpack(tmp_path / name, dest)
        assert "รหัสผ่าน" in str(e.value) and not dest.exists()
        with pytest.raises(cf.FetchError):
            _unpack(tmp_path / name, dest, password="wrong")
        _unpack(tmp_path / name, tmp_path / f"ok_{name}", password="secret")
        assert _read_tree(tmp_path / f"ok_{name}") == THAI_TREE


@needs_7z
def test_destination_must_be_new_or_empty(tmp_path):
    archive = _zip(tmp_path / "a.zip", THAI_TREE)
    dest = tmp_path / "used"
    _write_tree(dest, {"mine.txt": b"keep"})
    with pytest.raises(cf.FetchError) as e:
        _unpack(archive, dest)
    assert "ไม่ว่าง" in str(e.value) and _read_tree(dest) == {"mine.txt": b"keep"}
    with pytest.raises(cf.FetchError):  # a file where the folder should be
        _unpack(archive, dest / "mine.txt")
    with pytest.raises(cf.FetchError):
        _unpack(tmp_path / "missing.zip", tmp_path / "x")


@needs_7z
def test_not_enough_disk_space(tmp_path, monkeypatch):
    archive = _zip(tmp_path / "big.zip", {"big.bin": bytes(3_000_000)})  # 3 MB unpacked, a few KB packed
    asked = []
    monkeypatch.setattr(cf, "free_space", lambda path: asked.append(Path(path)) or 3_000_000 + cf.SPACE_LEAST - 1)
    with pytest.raises(cf.FetchError) as e:
        _unpack(archive, tmp_path / "out")
    assert "เนื้อที่ดิสก์ไม่พอ" in str(e.value) and not (tmp_path / "out").exists()
    assert asked == [tmp_path / "out"]
    monkeypatch.setattr(cf, "free_space", lambda path: 3_000_000 + cf.SPACE_LEAST)  # just enough, margin included
    _unpack(archive, tmp_path / "out")
    assert (tmp_path / "out" / "big.bin").stat().st_size == 3_000_000
    monkeypatch.undo()
    assert cf.free_space(tmp_path / "not" / "there" / "yet") == shutil.disk_usage(tmp_path).free


@needs_7z
def test_missing_volume_truncated_and_not_an_archive(tmp_path):
    src = tmp_path / "src"
    _write_tree(src, {"big.bin": os.urandom(300_000)})
    _seven("a", "-v100k", "-mx0", str(tmp_path / "set.7z"), ".", cwd=src)
    assert (tmp_path / "set.7z.003").exists()
    _unpack(tmp_path / "set.7z.001", tmp_path / "whole")  # all volumes there: the first one opens the set
    assert _read_tree(tmp_path / "whole") == _read_tree(src)
    (tmp_path / "set.7z.002").unlink()
    with pytest.raises(cf.FetchError) as e:
        _unpack(tmp_path / "set.7z.001", tmp_path / "part")
    assert "ไม่ครบ" in str(e.value) and not (tmp_path / "part").exists()
    (tmp_path / "งาน.part1.rar").write_bytes(rar5([{"name": "big.bin", "data": b"y" * 500, "split": True}], volume=True))
    with pytest.raises(cf.FetchError) as e:
        _unpack(tmp_path / "งาน.part1.rar", tmp_path / "vol")
    assert "งาน.part2.rar" in str(e.value) and "หลายส่วน" in str(e.value) and not (tmp_path / "vol").exists()
    whole = _zip(tmp_path / "whole.zip", {"big.bin": os.urandom(200_000)}).read_bytes()
    (tmp_path / "cut.zip").write_bytes(whole[:len(whole) // 2])  # a download that stopped half way
    with pytest.raises(cf.FetchError):
        _unpack(tmp_path / "cut.zip", tmp_path / "cut")
    (tmp_path / "page.rar").write_bytes(HTML)
    with pytest.raises(cf.FetchError) as e:
        _unpack(tmp_path / "page.rar", tmp_path / "page")
    assert "เปิด page.rar เป็นไฟล์บีบอัดไม่ได้" in str(e.value)
    assert not (tmp_path / "cut").exists() and not (tmp_path / "page").exists()


# --------------------------------------------------------------------------- inventory
def _binary_stl(triangles: int) -> bytes:
    return bytes(80) + struct.pack("<I", triangles) + bytes(50 * triangles)


IGES_LINE = b"RRS flat tray".ljust(72) + b"S      1\n"
INVENTORY_TREE = {
    # class → files (the content only matters where the header is read)
    "mesh": {"3D/mesh/CROSS_MEMBER_01.stl": _binary_stl(12), "3D/mesh/CROSS_MEMBER_02.stl": _binary_stl(12),
             "3D/mesh/CROSS_MEMBER_10.stl": _binary_stl(40), "3D/mesh/พื้น.obj": b"v 0 0 0\n" * 50, "3D/scan.ply": b"ply\n",
             "3D/print.3mf": b"PK\x03\x04", "3D/view.glb": b"glTF", "3D/view.gltf": b"{}"},
    "cad_neutral": {"3D/ford tray.step": b"ISO-10303-21;" + bytes(900), "3D/sub/bracket.STP": b"ISO-10303-21;",
                    "พื้นเรียบ ford.igs": IGES_LINE * 40, "3D/old.iges": IGES_LINE, "3D/shape.brep": b"DBRep_DrawableShape",
                    "3D/noext_step": b"ISO-10303-21;\nHEADER;"},
    "cad_neutral_unreadable": {"3D/para/body.x_t": b"x", "3D/para/body.x_b": b"x", "3D/para/a.sat": b"x", "3D/para/a.jt": b"x",
                               "3D/para/a.3dxml": b"x"},
    "cad_native": {"ZW3D/ford -260-190.Z3": bytes(5000), "ZW3D/tray.Z3ASM": bytes(700), "ZW3D/rail.Z3PRT": bytes(300),
                   "ZW3D/tray.Z3DRW": bytes(10), "SW/tray.SLDASM": bytes(40), "SW/rail.sldprt": bytes(30), "SW/rail.slddrw": b"x",
                   "INV/a.ipt": b"x", "INV/a.iam": b"x", "INV/a.idw": b"x", "CATIA/a.CATPart": b"x", "CATIA/a.CATProduct": b"x",
                   "NX/model1.prt": b"\x00\x01binary", "CREO/bracket.prt": b"#UGC:2 PART 1234", "CREO/bracket.prt.3": b"#UGC:2",
                   "CREO/tray.asm.12": b"#UGC:2", "SE/top.asm": b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "F/a.f3d": b"x",
                   "F/a.FCStd": b"PK\x03\x04"},
    "drawing_2d": {"2D/แบบ-01.dwg": b"AC1027" + bytes(60), "2D/แบบ-02.dwg": b"AC1027", "2D/plan.dxf": b"0\nSECTION\n"},
    "document": {"doc/spec.pdf": b"%PDF-1.7", "doc/bom.xlsx": b"PK", "doc/old.xls": b"x", "doc/list.csv": b"a,b\n",
                 "doc/note.docx": b"PK", "doc/show.pptx": b"PK", "doc/unnamed_pdf": b"%PDF-1.4 ..."},
    "picture": {"pic/IMG_0001.JPG": b"\xff\xd8\xff", "pic/render.png": b"\x89PNG"},
    "video": {"vid/assembly.mp4": bytes(64), "vid/walk.MOV": b"x"},
    "archive": {"old/backup.rar": b"Rar!\x1a\x07\x01\x00", "old/more.zip": b"PK\x03\x04", "old/x.7z": b"7z",
                "old/set.part2.rar": b"x", "old/set.7z.002": b"x"},
    "other": {"misc/data.bin": bytes(20), "misc/README": b"hello", "SW/~$rail.sldprt": b"lock", "a/b/c/d/e/deep.xyz": b"deep"},
}
ALL_FILES = {path: data for group in INVENTORY_TREE.values() for path, data in group.items()}


@pytest.fixture(scope="module")
def inv(tmp_path_factory):
    root = tmp_path_factory.mktemp("งาน ford")
    _write_tree(root, ALL_FILES)
    os.symlink(root / "3D", root / "ทางลัด 3D")  # not followed, not counted
    return cf.inventory(root)


def test_inventory_totals_and_a_class_for_every_file(inv):
    assert inv["total_files"] == len(ALL_FILES) and inv["total_bytes"] == sum(map(len, ALL_FILES.values()))
    assert inv["links_skipped"] == 1
    found = {f["path"]: f["class"] for f in inv["files"]}
    assert found == {path: cls for cls, group in INVENTORY_TREE.items() for path in group}
    assert list(inv["classes"]) == list(cf.CLASSES)
    for cls, group in INVENTORY_TREE.items():
        assert inv["classes"][cls]["count"] == len(group), cls
        assert inv["classes"][cls]["bytes"] == sum(map(len, group.values())), cls
    formats = {f["path"]: f["format"] for f in inv["files"]}
    assert formats["ZW3D/ford -260-190.Z3"] == "ZW3D" and formats["SW/tray.SLDASM"] == "SolidWorks"
    assert formats["CREO/bracket.prt"] == formats["CREO/bracket.prt.3"] == formats["CREO/tray.asm.12"] == "Creo"
    assert formats["NX/model1.prt"].startswith("NX") and formats["SE/top.asm"] == "Solid Edge"
    assert formats["3D/noext_step"] == "STEP" and formats["doc/unnamed_pdf"] == "PDF"  # told by the first bytes


def test_inventory_extensions_tree_and_largest(inv):
    exts = {e["ext"]: e for e in inv["extensions"]}
    assert exts["stl"]["count"] == 3 and exts["stl"]["bytes"] == sum(len(_binary_stl(n)) for n in (12, 12, 40))
    assert exts["dwg"]["count"] == 2 and exts[""]["count"] == 3  # README and the two files told by their header
    assert [e["bytes"] for e in inv["extensions"]] == sorted((e["bytes"] for e in inv["extensions"]), reverse=True)
    tree = {t["path"]: t for t in inv["tree"]}
    assert tree["."]["files"] == inv["total_files"] and tree["."]["bytes"] == inv["total_bytes"] and tree["."]["depth"] == 0
    assert tree["3D"]["files"] == sum(1 for p in ALL_FILES if p.startswith("3D/")) and tree["3D/mesh"]["depth"] == 2
    assert tree["a/b/c"] == {"path": "a/b/c", "depth": 3, "files": 1, "bytes": 4}  # what lies deeper counts in it
    assert max(t["depth"] for t in inv["tree"]) == 3 and "a/b/c/d" not in tree
    assert "ทางลัด 3D" not in tree
    largest = inv["largest"]
    assert len(largest) == 30 and largest[0]["path"] == "ZW3D/ford -260-190.Z3" and largest[0]["class"] == "cad_native"
    assert [f["bytes"] for f in largest] == sorted((len(d) for d in ALL_FILES.values()), reverse=True)[:30]


def test_inventory_ranks_what_the_3d_manual_can_use(inv):
    use = inv["use_for_3d"]
    assert [u["rank"] for u in use] == sorted(u["rank"] for u in use)
    by_rank = {r: [u["path"] for u in use if u["rank"] == r] for r in range(1, 6)}
    assert set(by_rank[1]) == {"3D/mesh/CROSS_MEMBER_01.stl", "3D/mesh/CROSS_MEMBER_02.stl", "3D/mesh/CROSS_MEMBER_10.stl",
                               "3D/mesh/พื้น.obj"}  # meshes the program opens first …
    assert by_rank[1][0] == "3D/mesh/CROSS_MEMBER_10.stl"  # … the largest on top
    assert set(by_rank[2]) == {"3D/scan.ply", "3D/print.3mf", "3D/view.glb", "3D/view.gltf"}
    assert by_rank[3] == ["3D/ford tray.step", "3D/noext_step", "3D/sub/bracket.STP"]  # then STEP …
    assert by_rank[4] == ["พื้นเรียบ ford.igs", "3D/old.iges"] and by_rank[5] == ["3D/shape.brep"]  # … then IGES
    assert all(u["bytes"] == len(ALL_FILES[u["path"]]) and u["how"] for u in use)
    assert {u["path"]: u.get("faces") for u in use}["3D/mesh/CROSS_MEMBER_10.stl"] == 40  # from the STL header
    native = inv["native_cad"]
    assert native["count"] == len(INVENTORY_TREE["cad_native"]) and "STEP" in native["note"] and "อ่านที่นี่ไม่ได้" in native["note"]
    rows = {r["format"]: r for r in native["formats"]}
    assert rows["ZW3D"]["count"] == 4 and rows["ZW3D"]["assemblies"] == ["ZW3D/tray.Z3ASM"]
    assert rows["SolidWorks"]["assemblies"] == ["SW/tray.SLDASM"] and rows["Creo"]["assemblies"] == ["CREO/tray.asm.12"]
    assert not any(u["path"].startswith(("ZW3D/", "SW/", "2D/")) for u in use)
    assert inv["drawings_2d"]["count"] == 3


def test_inventory_groups_the_parts_of_one_assembly(inv):
    series = {(g["folder"], g["name"], g["ext"]): g for g in inv["groups"] if g["kind"] == "series"}
    cross = series[("3D/mesh", "CROSS_MEMBER", "stl")]
    assert cross["count"] == 3 and cross["class"] == "mesh"
    assert cross["files"] == ["3D/mesh/CROSS_MEMBER_01.stl", "3D/mesh/CROSS_MEMBER_02.stl", "3D/mesh/CROSS_MEMBER_10.stl"]
    assert series[("2D", "แบบ", "dwg")]["count"] == 2
    assert ("pic", "IMG", "jpg") not in series  # photos are numbered too, but are no parts
    folders = {(g["folder"], g["ext"]): g["count"] for g in inv["groups"] if g["kind"] == "folder"}
    assert folders[("3D/mesh", "stl")] == 3 and ("ZW3D", "z3") not in folders


def test_inventory_markdown_is_thai_and_json_keys_are_english(inv, tmp_path, capsys):
    text = cf.render_markdown(inv)
    for part in ("# สรุปไฟล์ใน", "## ใช้อะไรทำคู่มือประกอบ 3 มิติ", "## ไฟล์ต้นฉบับของโปรแกรม CAD", "## แยกตามประเภท",
                 "## แยกตามนามสกุล", "## โครงสร้างโฟลเดอร์ (ลึก 3 ชั้น)", "## ไฟล์ใหญ่ที่สุด 30 ไฟล์", "พื้นเรียบ ford.igs",
                 "ZW3D/tray.Z3ASM", "CROSS_MEMBER", f"{inv['total_files']:,} ไฟล์"):
        assert part in text, part
    assert text.index("CROSS_MEMBER_10.stl") < text.index("ford tray.step") < text.index("พื้นเรียบ ford.igs")

    def keys(node):
        if isinstance(node, dict):
            return set(node) | {k for v in node.values() for k in keys(v)}
        return {k for v in node for k in keys(v)} if isinstance(node, list) else set()

    assert all(k.isascii() for k in keys(inv))
    out_json, out_md = tmp_path / "รายงาน" / "inv.json", tmp_path / "inv.md"
    out_json.parent.mkdir()
    assert cf.main(["inventory", inv["root"], "--json", str(out_json), "--md", str(out_md)]) == 0
    assert json.loads(out_json.read_text(encoding="utf-8")) == json.loads(json.dumps(inv))
    assert out_md.read_text(encoding="utf-8") == text and "ไฟล์" in capsys.readouterr().out
    assert cf.main(["inventory", str(tmp_path / "nothing here")]) == 1
    assert "ไม่พบโฟลเดอร์" in capsys.readouterr().err


def test_classify_by_name_alone():
    assert cf.classify("TRAY.Z3ASM") == ("cad_native", "ZW3D", "z3asm")
    assert cf.classify("a.tar.gz")[0] == "archive" and cf.classify("set.part03.rar")[0] == "archive"
    assert cf.classify("set.r00")[0] == "archive" and cf.classify("a.STEP")[:2] == ("cad_neutral", "STEP")
    assert cf.classify("noext") == ("other", "", "") and cf.classify(".hidden") == ("other", "", "")
    assert cf.classify("Thumbs.db")[0] == "other" and cf.classify("~$tray.sldasm")[0] == "other"
    assert cf.human(0) == "0 ไบต์" and cf.human(1536) == "1.5 KB" and cf.human(3539808068) == "3.30 GB"


# --------------------------------------------------------------------------- the three together
@needs_curl
@needs_7z
def test_download_unpack_inventory_end_to_end(drive, tmp_path, capsys):
    base, st = drive
    st["data"] = _zip(tmp_path / "upload.zip", THAI_TREE).read_bytes()
    archive, folder = tmp_path / "got" / "ford.zip", tmp_path / "got" / "ford"
    assert cf.main(["download", LARGE, str(archive), "--size", str(len(st["data"])), "--base", base,
                    "--usercontent-base", base]) == 0
    assert cf.main(["unpack", str(archive), str(folder)]) == 0
    assert cf.main(["inventory", str(folder)]) == 0
    said = capsys.readouterr().out
    assert _read_tree(folder) == THAI_TREE
    assert "แบบ/คานขวาง 01.stp" in said and "แผ่นพื้น (2).stl" in said
    assert said.index("แผ่นพื้น (2).stl") < said.index("แบบ/คานขวาง 01.stp")  # the mesh before the STEP file
