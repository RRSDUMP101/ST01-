"""ใช้จากนอกโรงงาน (ออนไลน์): a public https link to the mobile app of this PC, from anywhere - through a tunnel the
PC opens itself (no port is opened on the router, the data stays on this PC).

    phone (4G / any Wi-Fi) ──https──▶ Cloudflare ◀──tunnel (out from the PC)── cloudflared ──▶ https://localhost:8443

Three ways:
    quick   a Cloudflare quick tunnel: no account, a new https://….trycloudflare.com link each time it starts
    token   a Cloudflare Tunnel of the company (Zero Trust → Networks → Tunnels): its token and its fixed link
            (the public hostname of the tunnel points to https://localhost:8443, "No TLS Verify" on)
    own     a link made another way (Tailscale Funnel, a reverse proxy …) - only the link is kept here
The program finds cloudflared (its own copy in the data folder, else the one installed), or downloads it once from
the releases of cloudflare/cloudflared on GitHub.
"""

from __future__ import annotations

import io
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
from collections import deque
from pathlib import Path

QUICK, TOKEN, OWN = "quick", "token", "own"
MODES = {QUICK: "ลิงก์ชั่วคราว (Cloudflare – ไม่ต้องสมัคร ลิงก์เปลี่ยนทุกครั้งที่เปิด)",
         TOKEN: "ลิงก์ถาวร (Cloudflare Tunnel ของบริษัท – ใส่โทเคน)",
         OWN: "ลิงก์ของฉันเอง (Tailscale Funnel / อื่น ๆ)"}
OFF, STARTING, ON, ERROR = "off", "starting", "on", "error"
STATE_TEXT = {OFF: "ปิดอยู่", STARTING: "กำลังเปิด…", ON: "ออนไลน์แล้ว", ERROR: "เปิดไม่ได้"}
RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
QUICK_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
CONNECTED = re.compile(r"Registered tunnel connection|Connection [0-9a-f-]+ registered", re.IGNORECASE)


def asset_name(system: str | None = None, machine: str | None = None) -> str | None:
    """The cloudflared file of the GitHub release for this computer."""
    system = system or sys.platform
    machine = (machine or platform.machine() or "").lower()
    arm = machine in ("arm64", "aarch64")
    if system.startswith("win"):
        return "cloudflared-windows-arm64.exe" if arm else "cloudflared-windows-amd64.exe"
    if system == "darwin":
        return "cloudflared-darwin-arm64.tgz" if arm else "cloudflared-darwin-amd64.tgz"
    if system.startswith("linux"):
        return "cloudflared-linux-arm64" if arm else "cloudflared-linux-amd64"
    return None


def _exe_name() -> str:
    return "cloudflared.exe" if sys.platform.startswith("win") else "cloudflared"


def find_cloudflared(folder: str | Path) -> Path | None:
    """The program's own copy (data folder/bin), else one installed on the PC."""
    own = Path(folder) / "bin" / _exe_name()
    if own.is_file():
        return own
    found = shutil.which("cloudflared")
    if found:
        return Path(found)
    for guess in (r"C:\Program Files (x86)\cloudflared\cloudflared.exe", r"C:\Program Files\cloudflared\cloudflared.exe",
                  "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"):
        if Path(guess).is_file():
            return Path(guess)
    return None


def download_cloudflared(folder: str | Path, progress=None, opener=None) -> Path:
    """Download cloudflared once into the data folder (bin/); progress(done_bytes, total_bytes)."""
    name = asset_name()
    if not name:
        raise OSError("ดาวน์โหลด cloudflared ให้เครื่องแบบนี้ไม่ได้ – ติดตั้งเองจาก developers.cloudflare.com")
    if opener is None:
        import urllib.request

        opener = urllib.request.urlopen
    target = Path(folder) / "bin" / _exe_name()
    target.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with opener(RELEASES + name, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length") or 0) if getattr(resp, "headers", None) else 0
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            buf.write(chunk)
            if progress:
                progress(buf.tell(), total)
    data = buf.getvalue()
    if name.endswith(".tgz"):
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                member = next((m for m in tar.getmembers() if m.isfile() and Path(m.name).name == "cloudflared"), None)
                data = tar.extractfile(member).read() if member is not None else b""
        except tarfile.TarError:
            data = b""
    if len(data) < 1_000_000:  # the real program is tens of MB: an error page, not cloudflared
        raise OSError("ดาวน์โหลด cloudflared ไม่ครบ – ลองอีกครั้ง")
    part = target.with_suffix(target.suffix + ".part")
    part.write_bytes(data)
    part.chmod(0o755)
    os.replace(part, target)
    return target


class Tunnel:
    """One tunnel to https://localhost:<port>. on_change() is called (from the reader thread) when its state or link
    changes; command overrides the cloudflared command line (tests)."""

    def __init__(self, folder: str | Path, port: int, mode: str = QUICK, token: str = "", url: str = "",
                 on_change=None, command: list[str] | None = None):
        self.folder = Path(folder)
        self.port = int(port)
        self.mode = mode if mode in MODES else QUICK
        self.token = (token or "").strip()
        self.fixed_url = clean_url(url)
        self.on_change = on_change
        self.command = command
        self.state = OFF
        self.public_url = ""
        self.error = ""
        self.log: deque[str] = deque(maxlen=60)
        self._proc: subprocess.Popen | None = None
        self._stopping = False

    @property
    def running(self) -> bool:
        return self.state in (STARTING, ON)

    def _set(self, state: str | None = None, url: str | None = None, error: str | None = None) -> None:
        if state is not None:
            self.state = state
        if url is not None:
            self.public_url = url
        if error is not None:
            self.error = error
        if self.on_change:
            self.on_change()

    def args(self, exe: Path | str) -> list[str]:
        if self.mode == TOKEN:  # the link and its origin are set in the Cloudflare dashboard
            return [str(exe), "tunnel", "--no-autoupdate", "run"]
        return [str(exe), "tunnel", "--no-autoupdate", "--url", f"https://localhost:{self.port}", "--no-tls-verify"]

    def start(self, exe: Path | str | None = None) -> None:
        if self.running:
            return
        self.error = ""
        self._stopping = False
        if self.mode == OWN:
            if not self.fixed_url:
                self._set(ERROR, "", "ใส่ลิงก์ออนไลน์ก่อน (เช่น https://pc-office.tailnet-xxxx.ts.net)")
                return
            self._set(ON, self.fixed_url)
            return
        if self.mode == TOKEN and not (self.token and self.fixed_url):
            self._set(ERROR, "", "ใส่โทเคนของ Cloudflare Tunnel และลิงก์ (public hostname) ก่อน")
            return
        cmd = self.command or self.args(exe or find_cloudflared(self.folder) or "cloudflared")
        env = dict(os.environ)
        if self.mode == TOKEN:
            env["TUNNEL_TOKEN"] = self.token  # not on the command line (other programs could read it there)
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                          env=env, creationflags=flags, text=True, encoding="utf-8", errors="replace")
        except OSError as e:
            self._set(ERROR, "", f"เปิด cloudflared ไม่ได้: {e}")
            return
        self._set(STARTING, self.fixed_url if self.mode == TOKEN else "")
        threading.Thread(target=self._read, args=(self._proc,), daemon=True, name="tunnel").start()

    def _read(self, proc: subprocess.Popen) -> None:
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            self.log.append(line)
            if self.mode == QUICK and not self.public_url:
                found = QUICK_URL.search(line)
                if found:
                    self._set(url=found.group(0))
            if self.state == STARTING and CONNECTED.search(line) and (self.public_url or self.mode == TOKEN):
                self._set(ON)
            elif "Unauthorized" in line or "Invalid tunnel secret" in line:
                self.error = "โทเคนไม่ถูกต้อง – คัดลอกโทเคนของ tunnel จาก Cloudflare อีกครั้ง"
        code = proc.wait()
        if proc is not self._proc:
            return
        self._proc = None
        if self._stopping:
            self._set(OFF, "")
            return
        last = next((x for x in reversed(self.log) if "ERR" in x or "error" in x.lower()), self.log[-1] if self.log else "")
        self._set(ERROR, "", self.error or f"cloudflared หยุดทำงาน (รหัส {code}) {last[-160:]}".strip())

    def stop(self, wait: float = 5.0) -> None:
        self._stopping = True
        proc, state = self._proc, self.state
        if proc is None:
            if state != OFF:
                self._set(OFF, "")
            return
        proc.terminate()
        try:
            proc.wait(wait)
        except subprocess.TimeoutExpired:
            proc.kill()
        deadline = time.monotonic() + 2
        while self._proc is proc and time.monotonic() < deadline:  # the reader thread reports OFF
            time.sleep(0.02)
        if self.state != OFF:
            self._proc = None
            self._set(OFF, "")


def clean_url(url: str) -> str:
    """'pc.example.com/' -> 'https://pc.example.com' (the link of a tunnel, without a path)."""
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = "https://" + url
    return url
