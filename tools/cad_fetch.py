"""Fetch, unpack and take stock of the CAD files a customer shares on Google Drive (งาน Ford Ranger Super Duty).

    python tools/cad_fetch.py download 1QJyzTlPcYo3eY48YU3DCWCUhs2BQ-6UN work/ford.rar --size 3539808068
    python tools/cad_fetch.py unpack work/ford.rar work/ford
    python tools/cad_fetch.py inventory work/ford --json work/ford.json --md work/ford.md

* `download` – a public Drive file of any size: follows the "can't scan this file for viruses" form, continues a
  partial file with a Range request, retries network errors, and stops at once when the session's proxy refuses
  the host (a policy, not a fault: the hosts must be allowed first).
* `unpack` – RAR / RAR5 / ZIP / 7z into a new or empty folder: listed with 7z (or lsar), extracted with unrar when
  it is a RAR and unrar is installed (7z 23 and unar answer "Unsupported Method" to what WinRAR 7 writes), else with
  7z, then unar. The archive is untrusted: it is refused whole when an entry could land outside the folder.
* `inventory` – what is in the folder and which of it can become the 3D assembly manual (สรุปเป็นภาษาไทย).

Standard library only; curl, 7z, unrar and unar/lsar are run with argument lists, never through a shell. Nothing from a
downloaded file is executed or imported. Exit codes: 0 done · 1 failed · 3 the proxy does not allow the host.
"""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlsplit

DRIVE_BASE = "https://drive.google.com"
USERCONTENT_BASE = "https://drive.usercontent.google.com"
# Drive answers a browser; with another agent it may send a different page than the one with the form
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
PROBE_LIMIT = 4 * 1024 * 1024  # the first answer is a page or one byte of the file: never more than this
CURL_RETRY = {5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 92}  # curl exits that another try can cure (cut, timeout, reset)
HTTP_RETRY = {408, 425, 429, 500, 502, 503, 504}
SPACE_MARGIN = 0.10  # free disk space asked on top of the unpacked size …
SPACE_LEAST = 256 * 1024 * 1024  # … and never less than this
MAX_LINKS = 200  # link entries whose target is read from the archive one by one; more than this is not a CAD folder


class FetchError(Exception):
    """A failure the user can act on. The text is Thai: it is shown as it is."""


class PolicyDenied(FetchError):
    """The session's proxy refuses the host. Trying again cannot help."""


class UnsafeArchive(FetchError):
    """An entry of the archive would land outside the destination. Nothing is extracted."""


class _Again(Exception):
    """A network fault: wait and try again."""


def human(n: float) -> str:
    for unit in ("ไบต์", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:,.0f} {unit}" if unit == "ไบต์" else f"{n:,.2f} {unit}" if unit == "GB" else f"{n:,.1f} {unit}"
        n /= 1024
    return ""


def _run(args: list[str], tick=None, every: float = 15.0, env: dict | None = None) -> tuple[int, str, str]:
    """A program with an argument list (no shell, no input). `tick` is called now and then while it runs."""
    try:
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    except FileNotFoundError:
        raise FetchError(f"ไม่พบโปรแกรม {args[0]} ในเครื่องนี้") from None
    try:
        while True:
            try:
                out, err = proc.communicate(timeout=every if tick else None)
                break
            except subprocess.TimeoutExpired:
                tick()
    finally:
        if proc.poll() is None:  # Ctrl+C: do not leave it running behind us
            proc.kill()
            proc.wait()
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


# --------------------------------------------------------------------------- download
def drive_id(text: str) -> str:
    """The file id from a share link ('…/file/d/<id>/view', '…?id=<id>') or the id itself."""
    text = text.strip()
    if re.fullmatch(r"[\w-]{10,}", text):
        return text
    url = urlsplit(text)
    found = re.search(r"/d/([\w-]{10,})", url.path)
    ids = [found.group(1)] if found else parse_qs(url.query).get("id", [])
    if not ids or not re.fullmatch(r"[\w-]{10,}", ids[0]):
        raise FetchError(f"ไม่พบรหัสไฟล์ Google Drive ใน “{text}” (ใส่ลิงก์แชร์ หรือรหัสไฟล์)")
    return ids[0]


class _Page(HTMLParser):
    """The forms of a page (their hidden inputs) and its words, to follow the form or to say what the page says."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: list[dict] = []
        self.title = ""
        self.words: list[str] = []
        self._in: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k: v or "" for k, v in attrs}
        if tag == "form":
            self.forms.append({"id": a.get("id", ""), "action": a.get("action", ""), "fields": {}})
        elif tag == "input" and self.forms and a.get("name"):
            self.forms[-1]["fields"][a["name"]] = a.get("value", "")
        if tag in ("title", "script", "style"):
            self._in.append(tag)

    def handle_endtag(self, tag):
        if self._in and self._in[-1] == tag:
            self._in.pop()

    def handle_data(self, data):
        text = " ".join(data.split())
        if not text or (self._in and self._in[-1] in ("script", "style")):
            return
        if self._in and self._in[-1] == "title":
            self.title += text
        else:
            self.words.append(text)


def _origin(url: str) -> tuple[str, str]:
    u = urlsplit(url)
    return u.scheme.lower(), u.netloc.lower()


def confirm_url(page: str, page_url: str, bases: tuple[str, ...]) -> str | None:
    """The address behind the 'download anyway' form of Drive's virus-scan page, or None when the page has none.
    The form may only lead to Drive itself (`bases`): a page is untrusted too."""
    parser = _Page()
    parser.feed(page)
    forms = [f for f in parser.forms if "id" in f["fields"]]
    form = next((f for f in forms if f["id"] == "download-form"), forms[0] if forms else None)
    if form is None:
        return None
    action = urljoin(page_url, form["action"])
    if _origin(action) not in {_origin(b) for b in bases}:
        raise FetchError(f"หน้ายืนยันของ Google Drive ชี้ไปที่อยู่ที่ไม่รู้จัก ({urlsplit(action).netloc}) "
                         "– ไม่ดาวน์โหลดต่อ")
    return action.split("?")[0] + "?" + urlencode(form["fields"])


def _page_says(page: str) -> str:
    parser = _Page()
    parser.feed(page)
    return " – ".join(t for t in (parser.title, " ".join(parser.words)[:300]) if t) or "(หน้าว่าง)"


def looks_like_html(path: str | Path) -> bool:
    """A web page saved under the file's name (a login, quota or error page) instead of the file."""
    with open(path, "rb") as fh:
        head = fh.read(1024).lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return head.startswith((b"<!doctype html", b"<html")) or (head.startswith(b"<") and b"<html" in head)


def _headers(path: Path) -> tuple[int, dict[str, str]]:
    """Status and headers of the last answer in curl's header dump (the proxy's and every redirect come before)."""
    status, found = 0, {}
    try:
        lines = path.read_text(encoding="latin-1").splitlines()
    except OSError:
        return 0, {}
    for line in lines:
        if line.startswith("HTTP/"):
            parts = line.split()
            status, found = (int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0), {}
        elif ":" in line:
            key, _, value = line.partition(":")
            found[key.strip().lower()] = value.strip()
    return status, found


def _file_name(disposition: str) -> str:
    star = re.search(r"filename\*=(?:UTF-8|utf-8)''([^;]+)", disposition)
    if star:
        return unquote(star.group(1))
    plain = re.search(r'filename="?([^";]+)"?', disposition)
    return plain.group(1).encode("latin-1", "replace").decode("utf-8", "replace") if plain else ""


@dataclass
class _Target:
    url: str
    total: int | None  # bytes, when the server says
    ranges: bool  # it answers Range requests, so a partial file can be continued
    name: str = ""


class _Drive:
    """One download: curl with the session's proxy and CA (from the environment), a cookie jar, the two bases."""

    def __init__(self, base: str, usercontent_base: str, tmp: Path, log, every: float):
        self.bases = (base.rstrip("/"), usercontent_base.rstrip("/"))
        self.tmp, self.log, self.every = tmp, log, every
        self.jar, self.dump = tmp / "cookies.txt", tmp / "headers.txt"

    def curl(self, extra: list[str], url: str, tick=None) -> tuple[int, str, int, dict[str, str], str]:
        """→ curl's exit code and message, the HTTP status, the headers, the address after redirects."""
        self.dump.unlink(missing_ok=True)
        # -q: no ~/.curlrc, so nothing there can switch certificate checks off or add a header
        args = ["curl", "-q", "-sS", "-L", "--max-redirs", "10", "--proto", "=http,https", "--proto-redir",
                "=http,https", "--connect-timeout", "90", "-A", USER_AGENT, "-b", str(self.jar), "-c", str(self.jar),
                "-D", str(self.dump), "-w", "%{http_code} %{http_connect} %{url_effective}", *extra, "--", url]
        code, out, err = _run(args, tick, self.every)
        http, connect, last = (out.split(" ", 2) + ["", "", ""])[:3]
        denied = re.search(r"(?:CONNECT tunnel failed, response|Received HTTP code) (403|407)", err)
        if code and (denied or connect in ("403", "407")):
            self.denied(last or url, denied.group(1) if denied else connect)
        status, headers = _headers(self.dump)
        return code, err.strip(), int(http) if http.isdigit() and int(http) else status, headers, last or url

    def denied(self, url: str, status: str) -> None:
        hosts = [urlsplit(b).hostname or b for b in self.bases]
        host = urlsplit(url).hostname or url
        raise PolicyDenied(
            f"พร็อกซีของเซสชันนี้ไม่อนุญาตให้ออกไปที่ {host} (ตอบ HTTP {status} ตอนขอเปิดอุโมงค์ CONNECT)\n"
            "เป็นนโยบายเครือข่าย ไม่ใช่อาการชั่วคราว จึงหยุดทันทีโดยไม่ลองซ้ำ\n"
            f"ต้องเพิ่มโฮสต์ต่อไปนี้ในรายการที่ environment อนุญาตก่อน แล้วรันคำสั่งเดิมอีกครั้ง: "
            + ", ".join(dict.fromkeys(hosts + [host])))

    def check(self, code: int, err: str, status: int, what: str) -> None:
        """Network faults and busy servers are tried again; a refusal of the server is final."""
        if code in CURL_RETRY or status in HTTP_RETRY:
            raise _Again(err or f"HTTP {status}")
        if status in (401, 403):
            raise FetchError(f"Google Drive ปฏิเสธ{what} (HTTP {status}) – ไฟล์อาจไม่ได้แชร์แบบ “ทุกคนที่มีลิงก์” "
                             "หรือมีคนดาวน์โหลดเกินโควตาของวันนี้")
        if status in (404, 410):
            raise FetchError(f"ไม่พบไฟล์บน Google Drive (HTTP {status}) – ตรวจรหัสไฟล์ และว่าไฟล์ยังไม่ถูกลบ")
        if code and code not in (22, 63):
            raise FetchError(f"curl ทำงานไม่สำเร็จตอน{what} (รหัส {code}): {err}")
        if status >= 400:
            raise FetchError(f"เซิร์ฟเวอร์ตอบ HTTP {status} ตอน{what}")

    def resolve(self, file_id: str) -> _Target:
        """Ask for the first byte: a small file answers with it, a large one with the virus-scan page whose form
        holds the real address. Asked again before every try, because that address stops working after a while."""
        url = f"{self.bases[0]}/uc?" + urlencode({"export": "download", "id": file_id})
        body = self.tmp / "probe.bin"
        for _hop in range(4):
            body.unlink(missing_ok=True)
            first = ["-r", "0-0", "--max-filesize", str(PROBE_LIMIT), "-o", str(body)]
            code, err, status, headers, last = self.curl(first, url)
            if status != 416:
                self.check(code, err, status, "ถามหาไฟล์")
            name = _file_name(headers.get("content-disposition", ""))
            is_page = headers.get("content-type", "").lower().startswith("text/html") and not name
            if is_page and status == 206:  # the page itself, cut to its first byte: ask for all of it
                code, err, status, headers, last = self.curl(first[2:], url)
                self.check(code, err, status, "ถามหาไฟล์")
            if status == 206:
                total = headers.get("content-range", "").rpartition("/")[2]
                return _Target(url, int(total) if total.isdigit() else None, True, name)
            if not is_page:  # the whole file, or the refusal of a range for an empty one: no resume with this server
                length = headers.get("content-length", "")
                return _Target(url, 0 if status == 416 else int(length) if length.isdigit() else None, False, name)
            if code == 63:
                raise FetchError("Google Drive ตอบเป็นหน้าเว็บขนาดใหญ่ผิดปกติแทนไฟล์")
            page = body.read_text(encoding="utf-8", errors="replace")
            follow = confirm_url(page, last, self.bases)
            if follow is None:
                raise FetchError(
                    "Google Drive ตอบเป็นหน้าเว็บแทนไฟล์ และไม่มีปุ่มดาวน์โหลดในหน้านั้น: " + _page_says(page)
                    + "\n(ถ้าเป็นหน้าเข้าสู่ระบบ = ไฟล์ไม่ได้แชร์แบบ “ทุกคนที่มีลิงก์” · ถ้าเป็นเรื่องโควตา = รอ 24 ชม.)"
                )
            url = follow
        raise FetchError("Google Drive ส่งหน้ายืนยันซ้ำไปมา ไม่ยอมส่งไฟล์")

    def fetch(self, target: _Target, part: Path, offset: int) -> None:
        """The bytes from `offset` on, appended to the partial file."""
        started, last = time.monotonic(), [time.monotonic(), offset]

        def tick() -> None:
            done = part.stat().st_size if part.exists() else 0
            now = time.monotonic()
            rate = (done - last[1]) / max(now - last[0], 1e-6)
            last[:] = [now, done]
            of = f" / {human(target.total)} ({done * 100 / target.total:.1f}%)" if target.total else ""
            self.log(f"  ได้ {human(done)}{of} · {human(rate)}/วินาที · {now - started:,.0f} วินาที")

        # --fail: an error page never reaches the file · --speed-*: a stalled connection is cut and continued
        extra = ["--fail", "--speed-limit", "1", "--speed-time", "90", "-o", str(part)]
        extra += ["-C", str(offset)] if offset else []
        code, err, status, headers, _last = self.curl(extra, target.url, tick)
        if code == 22 and status == 416 and offset and target.total is None:
            return  # nothing after what we have, and the server never told the size: the file was complete
        if code == 33 or (code == 22 and status == 416):  # no range after all: the next try asks the address again
            raise _Again("เซิร์ฟเวอร์ไม่ยอมส่งต่อจากจุดที่ค้าง")
        self.check(code, err, status, "ดาวน์โหลด")
        if not offset and headers.get("content-type", "").lower().startswith("text/html") \
                and not headers.get("content-disposition") and part.exists() and looks_like_html(part):
            part.unlink()  # the address went stale between the two requests
            raise _Again("ได้หน้าเว็บแทนไฟล์")


def download(source: str, dest: str | Path, size: int | None = None, *, base: str = DRIVE_BASE,
             usercontent_base: str = USERCONTENT_BASE, retries: int = 6, backoff: float = 2.0,
             progress_every: float = 15.0, sleep=time.sleep, log=print) -> Path:
    """A public Google Drive file → `dest`. A cut download is continued from `dest`.part, also by a later run.
    `size`: the bytes the file must have. `retries`: tries in a row that may fail without a single new byte."""
    file_id = drive_id(source)
    dest = Path(dest)
    part = dest.with_name(dest.name + ".part")
    if dest.exists():
        if size is not None and dest.is_file() and dest.stat().st_size == size:
            log(f"มีไฟล์ครบอยู่แล้ว: {dest} ({human(size)})")
            return dest
        known = size is not None and dest.is_file()
        other = f" แต่ขนาด {dest.stat().st_size:,} ไบต์ ไม่ใช่ {size:,} ไบต์" if known else ""
        raise FetchError(f"มีไฟล์ {dest} อยู่แล้ว{other} – ลบออกหรือเลือกชื่ออื่นก่อน")
    dest.parent.mkdir(parents=True, exist_ok=True)
    target, failures = None, 0
    with tempfile.TemporaryDirectory(prefix="cad_fetch_") as tmp:
        drive = _Drive(base, usercontent_base, Path(tmp), log, progress_every)
        while True:
            before = part.stat().st_size if part.exists() else 0
            try:
                target = drive.resolve(file_id)
                if size is not None and target.total is not None and target.total != size:
                    raise FetchError(f"ขนาดไม่ตรง: Google Drive บอกว่าไฟล์นี้มี {target.total:,} ไบต์ "
                                     f"แต่ที่ต้องการคือ {size:,} ไบต์ – รหัสไฟล์ผิด หรือไฟล์ถูกแก้ไขหลังแชร์ "
                                     "(ยังไม่ได้ดาวน์โหลด)")
                offset = before
                if offset and (not target.ranges or (target.total is not None and offset > target.total)):
                    part.unlink()  # cannot be continued, or it is not a piece of this file
                    offset = 0
                if not offset or target.total is None or offset < target.total:
                    log(f"ดาวน์โหลด {target.name or file_id}" + (f" {human(target.total)}" if target.total else "")
                        + (f" – ทำต่อจาก {human(offset)}" if offset else ""))
                    drive.fetch(target, part, offset)
                break
            except _Again as fault:
                got = part.stat().st_size if part.exists() else 0
                failures = 0 if got > before else failures + 1  # a cut after new bytes is progress, not a failure
                if failures > retries:
                    kept = f"\nส่วนที่ได้แล้ว {human(got)} เก็บไว้ที่ {part} – รันคำสั่งเดิมเพื่อทำต่อ" if got else ""
                    raise FetchError(f"ลองใหม่ {retries} ครั้งแล้วยังดาวน์โหลดไม่ได้: {fault}{kept}") from None
                wait = min(backoff * 2 ** max(failures - 1, 0), 60.0)
                log(f"การเชื่อมต่อมีปัญหา ({fault}) – ได้แล้ว {human(got)} · รอ {wait:.0f} วินาทีแล้วทำต่อ")
                sleep(wait)
    part.touch()  # an empty file: curl writes nothing
    got, want = part.stat().st_size, size if size is not None else target.total
    if looks_like_html(part):
        part.unlink()
        raise FetchError("สิ่งที่ได้มาเป็นหน้าเว็บ (HTML) ไม่ใช่ไฟล์ที่ต้องการ – ลบทิ้งแล้ว "
                         "ตรวจการแชร์ของไฟล์บน Google Drive")
    if want is not None and got != want:
        raise FetchError(f"ขนาดไม่ตรง: ได้ {got:,} ไบต์ แต่ต้องเป็น {want:,} ไบต์ "
                         f"– ไฟล์ยังอยู่ที่ {part} (ไม่เปลี่ยนชื่อเป็นไฟล์จริง)")
    os.replace(part, dest)
    log(f"เสร็จ: {dest} ({got:,} ไบต์)")
    return dest


# --------------------------------------------------------------------------- unpack
@dataclass
class Entry:
    path: str
    size: int = 0
    is_dir: bool = False
    link: str | None = None  # a link's target · '' = a link whose target the listing does not tell · None = no link
    hard: bool = False  # a hard link: its target counts from the top of the archive, not from its own folder
    encrypted: bool = False
    extra: bool = False  # an NTFS stream ('name:stream'): its name is checked, but not every program writes it


@dataclass
class Listing:
    tool: str
    kind: str  # 'Rar5', 'zip', '7z' … as the tool names it
    entries: list[Entry] = field(default_factory=list)


class _NotRead(Exception):
    """This tool cannot open the archive; another one may."""


def free_space(path: str | Path) -> int:
    """Free bytes on the disk of `path` (or of the nearest folder above it that exists)."""
    p = Path(path).resolve()
    while not p.exists():
        p = p.parent
    return shutil.disk_usage(p).free


def _archive_fault(text: str, archive: Path) -> None:
    """What 7z / lsar say about an archive that cannot be unpacked as it is, in the user's words."""
    missing = re.search(r"Missing volume\s*:\s*(.+)", text)
    if missing:
        raise FetchError(f"{archive.name} เป็นส่วนหนึ่งของไฟล์บีบอัดหลายส่วน และขาดไฟล์ส่วน “{missing.group(1).strip()}” "
                         "– ต้องมีทุกส่วน (part1, part2 …) อยู่ในโฟลเดอร์เดียวกันก่อนแตกไฟล์")
    missing = re.search(r"Cannot find volume (.+)", text)
    if missing:
        raise FetchError(f"{archive.name} ขาดไฟล์ส่วน “{missing.group(1).strip()}” ของไฟล์บีบอัดหลายส่วน")
    if re.search(r"Cannot open encrypted archive|Wrong password|requires a password|[Ii]ncorrect password", text):
        raise FetchError(f"{archive.name} ใส่รหัสผ่านไว้ (เข้ารหัส) – ต้องขอรหัสผ่านจากเจ้าของไฟล์ "
                         "แล้วรันใหม่ด้วย --password")
    if re.search(r"Unexpected end of (archive|data)|Unavailable data|Headers Error", text):
        raise FetchError(f"{archive.name} ไม่ครบ – ดาวน์โหลดไม่จบ หรือเป็นไฟล์หลายส่วนที่ขาดส่วนอื่น (.part2 / .002 …)")


def _list_7z(archive: Path, password: str) -> Listing:
    code, out, err = _run(["7z", "l", "-slt", "-sccUTF-8", f"-p{password}", "--", str(archive)])
    lines = [x.rstrip("\r") for x in out.split("\n")]  # not splitlines(): a name may hold U+2028 and the like
    cut = len(lines) - 1 - lines[::-1].index("----------") if "----------" in lines else len(lines)
    # what 7z says about the archive stands above the entries; the names below must not be read as its messages
    said = "\n".join(x for x in lines[:cut] if not x.startswith(("Path = ", "Listing archive: "))) + "\n" + err
    _archive_fault(said, archive)
    if code or cut == len(lines):
        raise _NotRead(" · ".join(x.strip() for x in said.splitlines() if "ERROR" in x)[-400:])
    kinds = [x.partition(" = ")[2] for x in lines[:cut] if x.startswith("Type = ")]
    listing = Listing("7z", kinds[-1] if kinds else "")
    block: dict[str, str] = {}
    for line in lines[cut + 1:] + [""]:
        key, sep, value = line.partition(" =")
        is_field = bool(sep) and bool(re.fullmatch(r"[A-Za-z][A-Za-z ]*", key))
        value = value.removeprefix(" ")
        if is_field and key not in block:
            block[key] = value
            continue
        if "Path" in block:
            attrs = block.get("Attributes", "")
            is_link = bool(re.search(r"(^|\s)l[rwxsStT-]{9}", attrs))
            target = block.get("Symbolic Link") or block.get("Hard Link") or block.get("Copy Link") or ""
            listing.entries.append(Entry(
                block["Path"], int(block.get("Size") or 0), block.get("Folder") == "+" or attrs.startswith("D"),
                target if (target or is_link) else None, bool(block.get("Hard Link") or block.get("Copy Link")),
                block.get("Encrypted") == "+", block.get("Alternate Stream") == "+"))
        block = {key: value} if is_field else {}
    # zip and 7z keep a link's target as the entry's data: read it (-spd: the name as it is, no wildcards)
    unknown = [e for e in listing.entries if e.link == "" and (password or not e.encrypted)]
    for e in unknown[:MAX_LINKS]:
        code, out, _err = _run(["7z", "e", "-so", "-spd", f"-p{password}", "--", str(archive), e.path])
        if code == 0 and 0 < len(out) <= 4096 and e.size == len(out.encode("utf-8")):
            e.link = out
    return listing


def _list_unar(archive: Path, password: str) -> Listing:
    _code, out, err = _run(["lsar", "-j", *(["-p", password] if password else []), str(archive)])
    _archive_fault(err, archive)  # not the listing: a file may be called 'Wrong password.txt'
    try:
        data = json.loads(out)
        items = data["lsarContents"]
    except (ValueError, KeyError, TypeError):
        raise _NotRead(err.strip()[-400:]) from None
    if not items and (data.get("lsarProperties") or {}).get("XADVolumeScanningFailed"):
        # alone the flag says nothing (lsar sets it for whole archives too); with no entry at all it is a lost volume
        _archive_fault("Unexpected end of archive", archive)
    listing = Listing("unar", str(data.get("lsarFormatName", "")))
    for it in items:
        is_link = bool(it.get("XADIsLink") or it.get("XADIsHardLink"))
        listing.entries.append(Entry(
            str(it.get("XADFileName", "")), int(it.get("XADFileSize") or 0), bool(it.get("XADIsDirectory")),
            str(it.get("XADLinkDestination") or "") if is_link else None, bool(it.get("XADIsHardLink")),
            bool(it.get("XADIsEncrypted"))))
    return listing


TOOLS = ("7z", "unrar", "unar")
_LIST = {"7z": (_list_7z, "7z"), "unar": (_list_unar, "lsar")}  # unrar only extracts: its listing is made for reading


def list_archive(archive: str | Path, tools: tuple[str, ...] = TOOLS, password: str = "") -> Listing:
    """The entries of the archive, by the first of `tools` that is installed and can open it."""
    archive = Path(archive)
    said = []
    for tool in tools:
        if tool not in _LIST:
            continue
        if not shutil.which(_LIST[tool][1]):
            said.append(f"{tool}: ไม่ได้ติดตั้ง")
            continue
        try:
            return _LIST[tool][0](archive, password)
        except _NotRead as e:
            said.append(f"{tool}: {str(e) or 'เปิดไม่ได้'}")
    if not said:
        raise FetchError("ไม่มีโปรแกรมสำหรับตรวจรายการในไฟล์บีบอัด (ต้องมี 7z หรือ lsar) – ไม่แตกไฟล์โดยไม่ตรวจก่อน")
    raise FetchError(f"เปิด {archive.name} เป็นไฟล์บีบอัดไม่ได้ (ไฟล์เสีย ดาวน์โหลดไม่ครบ หรือไม่ใช่ RAR/ZIP/7z)\n"
                     + "\n".join(said))


def _outside(path: str) -> bool:
    p = path.replace("\\", "/")
    return p.startswith("/") or bool(re.match(r"[A-Za-z]:", p))


def unsafe_entries(entries: list[Entry]) -> list[str]:
    """Why the archive must not be extracted: one Thai line per entry that could land, or point, outside."""
    bad, links = [], set()
    for e in entries:
        name = e.path.replace("\\", "/")  # a RAR or ZIP made on Windows may keep '\' – on Windows that is a folder
        if not name.strip("/") or any(c < " " or c in "\x7f\x85\u2028\u2029" for c in name):
            bad.append(f"ชื่อว่างหรือมีอักขระควบคุม: {e.path!r}")
        elif _outside(name):
            bad.append(f"พาธแบบเต็ม (absolute) – จะเขียนออกนอกโฟลเดอร์ปลายทาง: {e.path}")
        elif ".." in name.split("/"):
            bad.append(f"มี “..” ในพาธ – จะเขียนออกนอกโฟลเดอร์ปลายทาง: {e.path}")
        if e.link is None:
            continue
        links.add(name.strip("/"))
        target = e.link.replace("\\", "/")
        if not target:
            bad.append(f"ลิงก์ที่ตรวจปลายทางไม่ได้: {e.path}")
            continue
        resolved = posixpath.normpath(posixpath.join("" if e.hard else posixpath.dirname(name.strip("/")), target))
        if _outside(target) or resolved == ".." or resolved.startswith("../"):
            bad.append(f"ลิงก์ชี้ออกนอกโฟลเดอร์ปลายทาง: {e.path} → {e.link}")
    for e in entries:  # written through a link, a file lands where the link points, whatever its own path says
        parts = e.path.replace("\\", "/").strip("/").split("/")
        if any("/".join(parts[:i]) in links for i in range(1, len(parts))):
            bad.append(f"ไฟล์ที่ต้องเขียนผ่านลิงก์: {e.path}")
    return bad


def _utf8_env() -> dict | None:
    """unrar writes names in the character set of the locale: under 'C' / 'POSIX' Thai names become '???'."""
    now = os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE") or os.environ.get("LANG") or ""
    return None if "utf" in now.lower() else dict(os.environ, LC_ALL="C.UTF-8")


def _extract(tool: str, archive: Path, dest: Path, password: str, tick, every: float) -> tuple[int, str]:
    env = None
    if tool == "7z":  # -o and the archive are absolute paths, so neither can be taken for a switch
        args = ["7z", "x", "-y", "-bd", "-sccUTF-8", f"-p{password}", f"-o{dest}", "--", str(archive)]
    elif tool == "unrar":  # -p-: never ask for a password · -idq: only errors · -op: the folder, as an absolute path
        args = ["unrar", "x", "-y", "-o+", "-c-", "-idq", f"-p{password}" if password else "-p-", f"-op{dest}",
                "--", str(archive)]
        env = _utf8_env()
    else:  # -D: straight into the folder, no folder of its own · -f: never ask
        args = ["unar", "-q", "-f", "-D", "-o", str(dest), *(["-p", password] if password else []), str(archive)]
    code, out, err = _run(args, tick, every, env)
    return code, (out + err).strip()


def _links_left_out(tool: str, code: int, said: str) -> list[str]:
    """The links the program refused to make, when that is all it complains about: 7z and unrar leave out every
    link with '..' in its target, also one that stays inside the folder, and end with an error code for it."""
    if tool == "7z" and code == 2:
        found = re.findall(r"Dangerous (?:symbolic )?link path was ignored : (.+)", said)
        errors = re.search(r"Sub items Errors: (\d+)", said)
        return found if errors and int(errors.group(1)) == len(found) else []
    if tool == "unrar" and code == 1:
        lines = [x.strip() for x in said.splitlines() if x.strip()]
        found = [m.group(1) for m in (re.match(r"Skipping the potentially unsafe (.+) link", x) for x in lines) if m]
        return found if len(found) == len(lines) else []
    return []


def _tree_size(root: Path) -> tuple[int, int]:
    files = total = 0
    for folder, _dirs, names in os.walk(root):
        for name in names:
            try:
                if not os.path.islink(p := os.path.join(folder, name)):
                    files, total = files + 1, total + os.path.getsize(p)
            except OSError:  # counted while the program is still writing: a file may be gone again
                continue
    return files, total


def verify_tree(dest: Path, entries: list[Entry]) -> None:
    """After extraction: no link in the folder may lead out of it (such a link is removed), and every file of the
    listing must be inside with its size – one that is not went somewhere else, or was not written to its end."""
    root = os.path.realpath(dest)
    escaped = []
    for folder, dirs, names in os.walk(dest):
        for name in dirs + names:
            p = os.path.join(folder, name)
            if os.path.islink(p) and os.path.commonpath([root, os.path.realpath(p)]) != root:
                escaped.append(f"{os.path.relpath(p, dest)} → {os.readlink(p)}")
                os.unlink(p)
    if escaped:
        raise UnsafeArchive("หลังแตกไฟล์พบลิงก์ที่ชี้ออกนอกโฟลเดอร์ปลายทาง (ลบลิงก์ออกแล้ว):\n  "
                            + "\n  ".join(escaped[:20]))
    missing, short = [], []
    for e in entries:
        if e.link is not None or e.extra:  # a link the program left out is no loss
            continue
        p = os.path.join(dest, *e.path.replace("\\", "/").strip("/").split("/"))
        if not os.path.lexists(p):
            missing.append(e.path)
        elif not e.is_dir and e.size and os.path.getsize(p) != e.size:
            short.append(f"{e.path} ({os.path.getsize(p):,} จาก {e.size:,} ไบต์)")
    if missing:
        raise FetchError(f"แตกไฟล์แล้ว แต่ {len(missing)} รายการในไฟล์บีบอัดไม่อยู่ในโฟลเดอร์ปลายทาง "
                         "(แตกไม่ครบ หรือถูกเขียนไว้ที่อื่น):\n  " + "\n  ".join(missing[:20]))
    if short:
        raise FetchError(f"แตกไฟล์แล้ว แต่ {len(short)} ไฟล์ขนาดไม่ตรงกับรายการในไฟล์บีบอัด (แตกไม่ครบ):\n  "
                         + "\n  ".join(short[:20]))


def unpack(archive: str | Path, dest: str | Path, *, tools: tuple[str, ...] = TOOLS, password: str = "",
           progress_every: float = 30.0, log=print) -> dict:
    """RAR / RAR5 / ZIP / 7z → a new or empty folder. The archive is listed and checked before a single file is
    written. `tools`: the programs that may be used, in the order to try them (a RAR goes to unrar first).
    `password` reaches the program as an argument: other users of the machine can see it while it runs."""
    archive, dest = Path(archive).resolve(), Path(os.path.abspath(dest))
    if not archive.is_file():
        raise FetchError(f"ไม่พบไฟล์บีบอัด {archive}")
    if dest.is_symlink() or (dest.exists() and not dest.is_dir()):
        raise FetchError(f"ปลายทาง {dest} ไม่ใช่โฟลเดอร์")
    if dest.is_dir() and any(dest.iterdir()):
        raise FetchError(f"โฟลเดอร์ปลายทาง {dest} ไม่ว่าง – ต้องเป็นโฟลเดอร์ใหม่หรือโฟลเดอร์เปล่า "
                         "(กันไฟล์เดิมถูกเขียนทับ)")
    listing = list_archive(archive, tools, password)
    bad = unsafe_entries(listing.entries)
    if bad:
        raise UnsafeArchive(f"ไม่แตกไฟล์ {archive.name}: มี {len(bad)} รายการที่ไม่ปลอดภัย (ยังไม่ได้เขียนไฟล์ใดเลย)"
                            + "".join("\n  " + b for b in bad[:20]) + ("\n  …" if len(bad) > 20 else ""))
    locked = [e for e in listing.entries if e.encrypted]
    if locked and not password:
        raise FetchError(f"{archive.name} ใส่รหัสผ่านไว้ (เข้ารหัส {len(locked)} ไฟล์) – ต้องขอรหัสผ่านจากเจ้าของไฟล์ "
                         "แล้วรันใหม่ด้วย --password")
    files = [e for e in listing.entries if not e.is_dir]
    size = sum(e.size for e in files)
    need, free = size + max(int(size * SPACE_MARGIN), SPACE_LEAST), free_space(dest)
    if need > free:
        raise FetchError(f"เนื้อที่ดิสก์ไม่พอ: แตกแล้วได้ {human(size)} ต้องมีที่ว่าง {human(need)} (เผื่อไว้แล้ว) "
                         f"แต่ดิสก์ของ {dest} เหลือ {human(free)}")
    log(f"แตกไฟล์ {archive.name} ({listing.kind}) – {len(files):,} ไฟล์ {human(size)} → {dest}")
    is_rar = listing.kind.lower().startswith("rar")
    have = [t for t in tools if shutil.which(t) and (is_rar or t != "unrar")]
    # a RAR goes to the program of the format's author: what WinRAR 7 packs, 7z 23 and unar cannot unpack
    first = "unrar" if is_rar and "unrar" in have else listing.tool
    order = [first] + [t for t in have if t != first]
    said = ""
    for n, tool in enumerate(order):
        if n:  # the program before gave up on the format: start again, empty (only our own files are in the folder)
            log(f"{order[n - 1]} แตกไฟล์รูปแบบนี้ไม่ได้ – ลองด้วย {tool}")
            shutil.rmtree(dest)
        dest.mkdir(parents=True, exist_ok=True)

        def tick() -> None:
            done_files, done = _tree_size(dest)
            log(f"  แตกแล้ว {done_files:,} ไฟล์ {human(done)}" + (f" ({done * 100 / size:.0f}%)" if size else ""))

        code, said = _extract(tool, archive, dest, password, tick, progress_every)
        unknown = re.search(r"(?i)unsupported|unknown method|not supported|cannot open the file as|is not rar", said)
        if code == 0 or not unknown:
            break
    left_out = _links_left_out(tool, code, said)
    if left_out:
        code = 0
        log(f"ข้ามลิงก์ {len(left_out)} รายการที่ {tool} ไม่ยอมสร้าง (ไฟล์จริงแตกครบ): " + " · ".join(left_out[:5]))
    if code != 0:
        _archive_fault(said, archive)
        hint = ""
        if is_rar and unknown and not shutil.which("unrar"):
            hint = ("\nไฟล์ RAR นี้บีบอัดด้วยวิธีของ WinRAR รุ่นใหม่ ซึ่ง 7z รุ่นในเครื่องนี้และ unar ยังแตกไม่ได้ "
                    "– ต้องติดตั้งโปรแกรม unrar แล้วรันใหม่")
        raise FetchError(f"แตกไฟล์ไม่สำเร็จ ({tool} รหัส {code}) – ไฟล์ที่แตกได้บางส่วนยังอยู่ใน {dest}{hint}\n"
                         + said[-1200:])
    verify_tree(dest, listing.entries)
    done_files, done = _tree_size(dest)
    log(f"เสร็จ: {done_files:,} ไฟล์ {human(done)} ใน {dest}")
    return {"archive": str(archive), "dest": str(dest), "tool": tool, "kind": listing.kind, "files": done_files,
            "bytes": done}


# --------------------------------------------------------------------------- inventory
CLASSES = {  # key (JSON) → Thai name, in the order of the report
    "mesh": "โมเดล mesh (ผิวสามเหลี่ยม)",
    "cad_neutral": "CAD 3 มิติรูปแบบกลาง – อ่านได้ด้วย OpenCascade",
    "cad_neutral_unreadable": "CAD 3 มิติรูปแบบกลาง – ที่นี่อ่านไม่ได้",
    "cad_native": "ไฟล์ต้นฉบับของโปรแกรม CAD",
    "drawing_2d": "แบบ 2 มิติ (DWG / DXF)",
    "document": "เอกสาร",
    "picture": "รูปภาพ",
    "video": "วิดีโอ",
    "archive": "ไฟล์บีบอัดซ้อนอยู่ข้างใน",
    "other": "อื่น ๆ",
}
_FORMATS = {
    "mesh": {"OBJ": "obj", "STL": "stl", "PLY": "ply", "3MF": "3mf", "glTF": "glb gltf", "FBX": "fbx", "COLLADA": "dae",
             "VRML": "wrl vrml", "3DS": "3ds", "AMF": "amf", "OFF": "off"},
    "cad_neutral": {"STEP": "step stp", "IGES": "iges igs", "BREP": "brep brp"},
    "cad_neutral_unreadable": {"Parasolid": "x_t x_b xmt_txt xmt_bin", "ACIS": "sat sab", "JT": "jt", "3DXML": "3dxml",
                               "VDA-FS": "vda", "STEP (บีบอัด)": "stpz", "IFC": "ifc", "3D PDF (PRC/U3D)": "prc u3d"},
    "cad_native": {"ZW3D": "z3 z3prt z3asm z3drw z3sht vx", "ZW3D – ไฟล์สำรอง / ไฟล์เสริม": "z3bak zwlyr",
                   "SolidWorks": "sldprt sldasm slddrw",
                   "SolidWorks eDrawings": "eprt easm edrw", "Inventor": "ipt iam idw ipn",
                   "CATIA": "catpart catproduct catdrawing cgr model", "NX": "prt", "Creo": "asm drw",
                   "Solid Edge": "par psm dft", "Fusion 360": "f3d f3z", "FreeCAD": "fcstd", "Rhino": "3dm",
                   "SketchUp": "skp", "IronCAD": "ics", "SpaceClaim": "scdoc", "Alibre": "ad_prt ad_asm",
                   "TopSolid": "top", "Blender": "blend"},
    "drawing_2d": {"DWG": "dwg", "DXF": "dxf"},
    "document": {"PDF": "pdf", "Excel": "xlsx xls xlsm csv", "Word": "docx doc rtf", "PowerPoint": "pptx ppt",
                 "ข้อความ": "txt md"},
    "picture": {"รูปภาพ": "jpg jpeg png bmp gif tif tiff webp heic svg psd"},
    "video": {"วิดีโอ": "mp4 mov avi mkv wmv webm m4v mpg mpeg"},
    "archive": {"ไฟล์บีบอัด": "rar zip 7z tar gz tgz bz2 xz cab iso"},
}
EXT_CLASS = {ext: (cls, fmt) for cls, fmts in _FORMATS.items() for fmt, exts in fmts.items() for ext in exts.split()}
ASSEMBLY_EXT = {"z3asm", "sldasm", "iam", "catproduct", "asm", "ad_asm", "easm"}  # one of these = one STEP to export
OPENS_NOW = {"obj", "stl"}  # what the program's 3D tab imports as it is
_SNIFF_EXT = {"prt", "asm", "drw"}  # one extension, several programs: the first bytes tell
_SERIES = re.compile(r"[\s_.:#-]*\d+$")  # the running number at the end of a name (as core.assembly3d._group_of)
_3D = ("mesh", "cad_neutral", "cad_neutral_unreadable", "cad_native", "drawing_2d")
NATIVE_NOTE = ("ไฟล์ต้นฉบับของโปรแกรม CAD อ่านที่นี่ไม่ได้ (รูปแบบปิดของแต่ละโปรแกรม) – ต้องเปิดในโปรแกรม CAD นั้น "
               "แล้วส่งออก (Export) เป็น STEP (.stp) 1 ไฟล์ต่อ 1 ชุดประกอบ ซึ่งได้ชื่อและโครงสร้างชิ้นส่วนครบ "
               "หรือส่งออกเป็น OBJ / STL")
NESTED_NOTE = ("ไฟล์บีบอัดที่ซ้อนอยู่ข้างใน ยังไม่ได้แตก – ถ้าต้องการดูข้างใน ให้แตกต่อด้วยคำสั่ง unpack "
               "ลงโฟลเดอร์ใหม่ไฟล์ละโฟลเดอร์ แล้วสรุปอีกครั้ง")
DRAWING_NOTE = "แบบ 2 มิติ DWG / DXF ไม่ใช่โมเดล 3 มิติ – โปรแกรมนำเข้าเพื่อทำ Part List ได้อยู่แล้ว"
USE_HOW = {
    1: "เปิดในแท็บ “คู่มือประกอบ 3 มิติ” ได้เลย (นำเข้าโมเดล OBJ / STL)",
    2: "เป็น mesh แต่โปรแกรมยังไม่เปิดรูปแบบนี้ตรง ๆ – ต้องแปลงเป็น OBJ / STL ก่อน",
    3: "STEP – แปลงเป็น mesh ด้วย OpenCascade ได้ที่นี่ (ได้ชิ้นส่วนแยกชิ้นตามโครงสร้างชุดประกอบ)",
    4: "IGES – แปลงเป็น mesh ด้วย OpenCascade ได้ที่นี่ (มักเป็นผิวล้วน ไม่มีโครงสร้างชุดประกอบ ไฟล์ใหญ่ใช้เวลานาน)",
    5: "BREP ของ OpenCascade – แปลงเป็น mesh ได้ที่นี่",
}


def _sniff(path: str) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read(512)
    except OSError:
        return b""


def _by_header(head: bytes) -> tuple[str, str] | None:
    """The format by the first bytes, for a file without a known extension."""
    magic = [(b"ISO-10303-21", ("cad_neutral", "STEP")), (b"%PDF", ("document", "PDF")),
             (b"Rar!\x1a\x07", ("archive", "ไฟล์บีบอัด")), (b"7z\xbc\xaf\x27\x1c", ("archive", "ไฟล์บีบอัด")),
             (b"PK\x03\x04", ("archive", "ไฟล์บีบอัด")),
             (b"glTF", ("mesh", "glTF")), (b"\x89PNG", ("picture", "รูปภาพ")), (b"\xff\xd8\xff", ("picture", "รูปภาพ")),
             (b"#UGC:", ("cad_native", "Creo"))]
    for start, found in magic:
        if head.startswith(start):
            return found
    if re.match(rb"AC1\.?\d", head):
        return "drawing_2d", "DWG"
    if len(head) >= 80 and head[72:73] == b"S" and head[73:80].strip() == b"1":  # IGES: the section letter in column 73
        return "cad_neutral", "IGES"
    return None


def classify(name: str, path: str | None = None) -> tuple[str, str, str]:
    """→ (class, format, extension) of a file by its name; its first bytes are read (when `path` is given) only
    where the name does not settle it."""
    low = name.lower()
    if low.startswith("~$") or low in ("thumbs.db", "desktop.ini", ".ds_store"):  # lock and system files, not data
        return "other", "", low.rpartition(".")[2] if "." in low else ""
    versioned = re.search(r"\.(prt|asm|drw|frm|lay|sec)\.\d+$", low)  # Creo keeps a version number after the extension
    if versioned:
        return "cad_native", "Creo", versioned.group(1)
    volume = re.search(r"\.(rar|zip|7z)\.\d{3}$|\.part\d+\.rar$|\.[rz]\d{2}$", low)  # a piece of a multi-part archive
    if volume:
        return "archive", "ไฟล์บีบอัด (หลายส่วน)", low.rpartition(".")[2]
    ext = low.rpartition(".")[2] if "." in low.lstrip(".") else ""
    ext = ext if re.fullmatch(r"[a-z0-9_+~-]{1,12}", ext) else ""  # 'drawing v1. final' has no extension
    cls, fmt = EXT_CLASS.get(ext, ("other", ""))
    if path and (ext in _SNIFF_EXT or cls == "other"):
        head = _sniff(path)
        if ext in _SNIFF_EXT:
            if head.startswith(b"#UGC:"):
                cls, fmt = "cad_native", "Creo"
            elif ext == "asm" and head.startswith(b"\xd0\xcf\x11\xe0"):
                cls, fmt = "cad_native", "Solid Edge"
            elif ext == "prt":
                cls, fmt = "cad_native", "NX หรือโปรแกรมอื่นที่ใช้ .prt"
        elif not ext or ext not in EXT_CLASS:
            cls, fmt = _by_header(head) or (cls, fmt)
    return cls, fmt, ext


def _stl_faces(path: str, size: int) -> int | None:
    """Triangles of a binary STL, from its 84-byte header (the same test as core.assembly3d.load_stl)."""
    head = _sniff(path)[:84]
    count = int.from_bytes(head[80:84], "little") if len(head) == 84 else 0
    return count if count and size == 84 + 50 * count else None


def _natural(text: str) -> list:
    """'part 10' after 'part 9'. Numbers and words alternate, so two keys never compare a number with a word."""
    return [int(t) if i % 2 else t.lower() for i, t in enumerate(re.split(r"(\d+)", text))]


def _tree_key(path: str) -> list:
    return [] if path == "." else [_natural(p) for p in path.split("/")]


def inventory(root: str | Path) -> dict:
    """Everything under `root` (links are not followed, files are not opened beyond a small header): totals, per
    extension, the folder tree to depth 3, the largest files, a class per file, what to use for the 3D manual."""
    root = Path(root)
    if not root.is_dir():
        raise FetchError(f"ไม่พบโฟลเดอร์ {root}")
    files, skipped = [], 0
    tree: dict[str, list[int]] = {".": [0, 0]}
    for folder, dirs, names in os.walk(root):
        dirs.sort(key=_natural)
        rel_dir = os.path.relpath(folder, root).replace(os.sep, "/")
        for d in list(dirs):
            if os.path.islink(os.path.join(folder, d)):
                skipped += 1
            elif rel_dir == "." or rel_dir.count("/") < 2:
                tree.setdefault(d if rel_dir == "." else f"{rel_dir}/{d}", [0, 0])
        for name in sorted(names, key=_natural):
            full = os.path.join(folder, name)
            if os.path.islink(full) or not os.path.isfile(full):
                skipped += 1
                continue
            size = os.path.getsize(full)
            cls, fmt, ext = classify(name, full)
            item = {"path": name if rel_dir == "." else f"{rel_dir}/{name}", "bytes": size, "ext": ext, "class": cls,
                    "format": fmt}
            if ext == "stl":
                faces = _stl_faces(full, size)
                if faces:
                    item["faces"] = faces
            files.append(item)
            parts = [] if rel_dir == "." else rel_dir.split("/")
            for depth in range(min(len(parts), 3) + 1):  # the file counts in its folder and in every folder above
                node = tree.setdefault("/".join(parts[:depth]) or ".", [0, 0])
                node[0], node[1] = node[0] + 1, node[1] + size

    def tally(key: str) -> dict[str, list[int]]:
        out: dict[str, list[int]] = {}
        for f in files:
            row = out.setdefault(f[key], [0, 0])
            row[0], row[1] = row[0] + 1, row[1] + f["bytes"]
        return out

    by_class = tally("class")
    use = []
    for f in files:
        rank = {"mesh": 1 if f["ext"] in OPENS_NOW else 2,
                "cad_neutral": {"STEP": 3, "IGES": 4}.get(f["format"], 5)}.get(f["class"])
        if rank:
            use.append({"rank": rank, "path": f["path"], "bytes": f["bytes"], "format": f["format"],
                        "how": USE_HOW[rank], **({"faces": f["faces"]} if "faces" in f else {})})
    use.sort(key=lambda u: (u["rank"], -u["bytes"], u["path"]))

    native: dict[str, dict] = {}
    for f in files:
        if f["class"] == "cad_native":
            row = native.setdefault(f["format"], {"format": f["format"], "count": 0, "bytes": 0, "extensions": [],
                                                  "assemblies": []})
            row["count"], row["bytes"] = row["count"] + 1, row["bytes"] + f["bytes"]
            if f["ext"] not in row["extensions"]:
                row["extensions"].append(f["ext"])
            if f["ext"] in ASSEMBLY_EXT:
                row["assemblies"].append(f["path"])

    # parts of one assembly: the same folder, the same extension, names that differ only in a running number …
    series: dict[tuple, list[dict]] = {}
    folders: dict[tuple, list[dict]] = {}
    for f in files:
        if f["class"] not in _3D:
            continue
        folder, _, name = f["path"].rpartition("/")
        stem = name[:-len(f["ext"]) - 1] if f["ext"] and name.lower().endswith("." + f["ext"]) else name
        base = _SERIES.sub("", stem).strip()
        if base and base != stem:
            series.setdefault((folder, base, f["ext"], f["class"]), []).append(f)
        if f["class"] in ("mesh", "cad_neutral"):  # … or simply the part files that share a folder
            folders.setdefault((folder, "", f["ext"], f["class"]), []).append(f)
    groups = []
    for kind, found in (("series", series), ("folder", folders)):
        for (folder, base, ext, cls), members in found.items():
            paths = [m["path"] for m in members]
            if len(members) >= 2 and not any(g["files"] == paths for g in groups):  # not the same set twice
                groups.append({"kind": kind, "folder": folder or ".", "name": base, "ext": ext, "class": cls,
                               "count": len(members), "bytes": sum(m["bytes"] for m in members),
                               "files": paths})
    groups.sort(key=lambda g: (g["kind"] != "series", _3D.index(g["class"]), -g["bytes"], g["folder"], g["name"]))

    return {
        "root": str(root),
        "total_files": len(files),
        "total_bytes": sum(f["bytes"] for f in files),
        "links_skipped": skipped,
        "classes": {key: {"label": label, "count": by_class.get(key, [0, 0])[0], "bytes": by_class.get(key, [0, 0])[1]}
                    for key, label in CLASSES.items()},
        "extensions": [{"ext": ext, "count": n, "bytes": b}
                       for ext, (n, b) in sorted(tally("ext").items(), key=lambda kv: (-kv[1][1], -kv[1][0], kv[0]))],
        "tree": [{"path": path, "depth": 0 if path == "." else path.count("/") + 1, "files": n, "bytes": b}
                 for path, (n, b) in sorted(tree.items(), key=lambda kv: _tree_key(kv[0]))],
        "largest": [{"path": f["path"], "bytes": f["bytes"], "class": f["class"]}
                    for f in sorted(files, key=lambda f: (-f["bytes"], f["path"]))[:30]],
        "use_for_3d": use,
        "native_cad": {"count": by_class.get("cad_native", [0, 0])[0], "bytes": by_class.get("cad_native", [0, 0])[1],
                       "note": NATIVE_NOTE, "formats": sorted(native.values(), key=lambda r: -r["bytes"])},
        "drawings_2d": {"count": by_class.get("drawing_2d", [0, 0])[0], "bytes": by_class.get("drawing_2d", [0, 0])[1],
                        "note": DRAWING_NOTE},
        "nested_archives": {"note": NESTED_NOTE, "files": [{"path": f["path"], "bytes": f["bytes"]} for f in files
                                                           if f["class"] == "archive"]},
        "groups": groups,
        "files": files,
    }


def render_markdown(inv: dict, limit: int = 40) -> str:
    """The inventory as a Thai summary for the user (long lists are cut at `limit` lines; the JSON has them whole)."""
    def more(rows: list, shown: int, what: str) -> list[str]:
        return [f"- … และอีก {len(rows) - shown:,} {what} (ดูครบในไฟล์ JSON)"] if len(rows) > shown else []

    out = [f"# สรุปไฟล์ใน `{Path(inv['root']).name or inv['root']}`", "",
           f"ทั้งหมด **{inv['total_files']:,} ไฟล์** รวม **{human(inv['total_bytes'])}** ({inv['total_bytes']:,} ไบต์)"
           + (f" · ข้ามลิงก์/ไฟล์พิเศษ {inv['links_skipped']:,} รายการ" if inv["links_skipped"] else ""), "",
           "## ใช้อะไรทำคู่มือประกอบ 3 มิติ", ""]
    use = inv["use_for_3d"]
    if not use:
        out.append("ไม่พบไฟล์ที่ใช้ได้ทันที (ไม่มี OBJ / STL / STEP / IGES)")
    for n, u in enumerate(use[:limit], 1):
        faces = f" · {u['faces']:,} หน้า" if "faces" in u else ""
        out.append(f"{n}. `{u['path']}` – {human(u['bytes'])}{faces} · {u['how']}")
    out += more(use, limit, "ไฟล์")
    native = inv["native_cad"]
    if native["count"]:
        out += ["", "## ไฟล์ต้นฉบับของโปรแกรม CAD (ต้องส่งออกก่อน)", "",
                f"มี {native['count']:,} ไฟล์ {human(native['bytes'])} – {native['note']}", ""]
        for row in native["formats"]:
            exts = ", ".join("." + e for e in row["extensions"])
            out.append(f"- **{row['format']}** ({exts}): {row['count']:,} ไฟล์ {human(row['bytes'])}")
            for path in row["assemblies"][:limit]:
                out.append(f"  - ไฟล์ชุดประกอบ → ส่งออก STEP: `{path}`")
        if any(row["format"] == "ZW3D" for row in native["formats"]):
            out.append("- หมายเหตุ ZW3D: ไฟล์ `.Z3` ไฟล์เดียวเก็บได้ทั้งชิ้นส่วน ชุดประกอบ และแบบ "
                       "– ต้องเปิดดูใน ZW3D ว่าชุดประกอบอยู่ไฟล์ไหน")
    if inv["nested_archives"]["files"]:
        out += ["", "## ไฟล์บีบอัดที่ซ้อนอยู่ข้างใน", "", inv["nested_archives"]["note"], ""]
        out += [f"- `{f['path']}` – {human(f['bytes'])}" for f in inv["nested_archives"]["files"][:limit]]
        out += more(inv["nested_archives"]["files"], limit, "ไฟล์")
    if inv["drawings_2d"]["count"]:
        out += ["", f"{DRAWING_NOTE}: {inv['drawings_2d']['count']:,} ไฟล์ {human(inv['drawings_2d']['bytes'])}"]
    if inv["groups"]:
        out += ["", "## กลุ่มไฟล์ที่น่าจะเป็นชิ้นส่วนของชุดประกอบเดียวกัน", ""]
        for g in inv["groups"][:limit]:
            what = f"ชื่อ “{g['name']}” + เลขลำดับ" if g["kind"] == "series" else "ไฟล์ชิ้นส่วนในโฟลเดอร์เดียวกัน"
            out.append(f"- `{g['folder']}/` – {what} (.{g['ext']}): {g['count']:,} ไฟล์ {human(g['bytes'])}")
        out += more(inv["groups"], limit, "กลุ่ม")
    out += ["", "## แยกตามประเภท", "", "| ประเภท | ไฟล์ | ขนาด |", "|---|---:|---:|"]
    out += [f"| {c['label']} | {c['count']:,} | {human(c['bytes'])} |" for c in inv["classes"].values()]
    out += ["", "## แยกตามนามสกุล", "", "| นามสกุล | ไฟล์ | ขนาด |", "|---|---:|---:|"]
    out += [f"| {'.' + e['ext'] if e['ext'] else '(ไม่มีนามสกุล)'} | {e['count']:,} | {human(e['bytes'])} |"
            for e in inv["extensions"][:limit]]
    out += more(inv["extensions"], limit, "นามสกุล")
    out += ["", "## โครงสร้างโฟลเดอร์ (ลึก 3 ชั้น)", ""]
    shown = inv["tree"][:limit * 3]
    out += [f"{'  ' * t['depth']}- `{t['path'].rpartition('/')[2] if t['depth'] else '.'}/` – {t['files']:,} ไฟล์ "
            f"{human(t['bytes'])}" for t in shown]
    out += more(inv["tree"], len(shown), "โฟลเดอร์")
    out += ["", "## ไฟล์ใหญ่ที่สุด 30 ไฟล์", ""]
    out += [f"{n}. `{f['path']}` – {human(f['bytes'])} · {inv['classes'][f['class']]['label']}"
            for n, f in enumerate(inv["largest"], 1)]
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- command line
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    dl = sub.add_parser("download", help="a public Google Drive file, with resume")
    dl.add_argument("source", help="Drive file id or share link")
    dl.add_argument("dest", help="the file to write")
    dl.add_argument("--size", type=int, help="the bytes the file must have")
    dl.add_argument("--retries", type=int, default=6, help="failed tries in a row without new bytes (default 6)")
    dl.add_argument("--base", default=DRIVE_BASE, help=argparse.SUPPRESS)
    dl.add_argument("--usercontent-base", default=USERCONTENT_BASE, help=argparse.SUPPRESS)
    un = sub.add_parser("unpack", help="RAR / ZIP / 7z into a new or empty folder, checked first")
    un.add_argument("archive")
    un.add_argument("dest")
    un.add_argument("--password", default="", help="for an encrypted archive (visible to other users while it runs)")
    iv = sub.add_parser("inventory", help="what is in a folder, and what the 3D manual can use")
    iv.add_argument("dir")
    iv.add_argument("--json", help="write the whole inventory here")
    iv.add_argument("--md", help="write the Thai summary here")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # Thai text, whatever the terminal's locale is
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        if args.cmd == "download":
            download(args.source, args.dest, args.size, base=args.base, usercontent_base=args.usercontent_base,
                     retries=args.retries, log=lambda text: print(text, flush=True))
        elif args.cmd == "unpack":
            unpack(args.archive, args.dest, password=args.password, log=lambda text: print(text, flush=True))
        else:
            inv = inventory(args.dir)
            text = render_markdown(inv)
            if args.json:
                Path(args.json).write_text(json.dumps(inv, ensure_ascii=False, indent=1), encoding="utf-8")
            if args.md:
                Path(args.md).write_text(text, encoding="utf-8")
            short = (f"{inv['total_files']:,} ไฟล์ {human(inv['total_bytes'])} · ใช้ทำคู่มือ 3 มิติได้ "
                     f"{len(inv['use_for_3d']):,} ไฟล์ · ไฟล์ต้นฉบับ CAD {inv['native_cad']['count']:,} ไฟล์ → ")
            print(short + " , ".join(p for p in (args.json, args.md) if p) if args.json or args.md else text)
    except PolicyDenied as e:
        print(f"ถูกบล็อกโดยนโยบายเครือข่าย: {e}", file=sys.stderr)
        return 3
    except FetchError as e:
        print(f"ไม่สำเร็จ: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
