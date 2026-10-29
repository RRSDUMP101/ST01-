"""The web server for the phones (มือถือ / แท็บเล็ต) - in the program on the office PC, on the factory Wi-Fi.

Two ports:
    https://<PC>:8443   the mobile app (static files of resources/mobile) and its API (/api/…) - HTTPS so the
                        phone may use its camera (AR scanning)
    http://<PC>:8080    the setup page only: install the certificate of this PC (ca.crt / .mobileconfig), then
                        open the app - the QR on the PC points here with the pairing code
A phone is paired once with the code shown on the PC and then sends its token (Authorization: Bearer …) with
every API call. All the API calls run through `executor` (the Qt main thread in the program) on MobileService;
/api/events waits for changes on the server thread.
"""

from __future__ import annotations

import gzip
import html
import json
import mimetypes
import socket
import ssl
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from . import certs
from .mobile import MobileError, MobileService, lan_addresses

STATIC = Path(__file__).resolve().parents[1] / "resources" / "mobile"
MAX_BODY = 2 * 1024 * 1024
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
         ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
         ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".mp3": "audio/mpeg", ".woff2": "font/woff2"}
ZIP_TYPES = (".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".wasm", ".svg", ".txt")
CSP = ("default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' blob: data:; media-src 'self' blob: mediastream:; connect-src 'self'; worker-src 'self' blob:; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


class Busy(Exception):
    """The program did not get to the call in time (a long job on its main thread): the phone tries again."""


def direct_executor():
    """Runs the calls on the thread of the request, one at a time (tests, tools)."""
    lock = threading.Lock()

    def run(fn, *args, **kw):
        with lock:
            return fn(*args, **kw)

    return run


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = sys.platform != "win32"  # on Windows it lets a second program take the same port
    request_queue_size = 64

    def __init__(self, address, handler, hub: MobileServer, context: ssl.SSLContext | None):
        self.hub = hub
        self.context = context
        self.open_connections: set = set()  # closed on stop (phones keep their connections open)
        self._lock = threading.Lock()
        super().__init__(address, handler)

    def server_bind(self):
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def finish_request(self, request, client_address):
        conn = request
        if self.context is not None:
            request.settimeout(20)  # the handshake must not hold the thread
            try:
                conn = self.context.wrap_socket(request, server_side=True)
            except (ssl.SSLError, OSError):
                return  # a browser that does not trust the certificate yet, or plain http on the https port
        with self._lock:
            self.open_connections.add(conn)
        try:
            self.RequestHandlerClass(conn, client_address, self)
        finally:
            with self._lock:
                self.open_connections.discard(conn)
            if conn is not request:
                try:
                    conn.close()
                except OSError:
                    pass

    def close_connections(self) -> None:
        with self._lock:
            conns = list(self.open_connections)
        for conn in conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def handle_error(self, request, client_address):  # noqa: ARG002 - quiet: phones drop connections often
        exc = sys.exc_info()[1]
        if not isinstance(exc, (ConnectionError, TimeoutError, ssl.SSLError)):
            traceback.print_exc()


class MobileServer:
    def __init__(self, service: MobileService, cert_dir: str | Path, executor=None, port: int = 8443,
                 http_port: int = 8080, host: str = "0.0.0.0", static_dir: str | Path | None = None):
        self.service = service
        self.cert_dir = Path(cert_dir)
        self.executor = executor or direct_executor()
        self.port = int(port)
        self.http_port = int(http_port)
        self.host = host
        self.static_dir = Path(static_dir or STATIC)
        self.addresses: list[str] = []
        self._servers: list[_Server] = []
        self._threads: list[threading.Thread] = []
        self._zip_cache: dict[tuple, bytes] = {}
        self._pair_tries: dict[str, list[float]] = {}
        self.error = ""

    # ---- start / stop --------------------------------------------------------------------------------
    @property
    def running(self) -> bool:
        return bool(self._servers)

    def start(self) -> None:
        if self.running:
            return
        self.addresses = lan_addresses()
        chain, key = certs.ensure_server_cert(self.cert_dir, self.addresses)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(str(chain), str(key))
        try:
            secure = _Server((self.host, self.port), _Handler, self, context)
        except OSError as e:
            raise OSError(f"เปิดพอร์ต {self.port} ไม่ได้ ({e.strerror or e}) – มีโปรแกรมอื่นใช้อยู่ เปลี่ยนพอร์ตในหน้านี้") from e
        try:
            plain = _Server((self.host, self.http_port), _SetupHandler, self, None)
        except OSError as e:
            secure.server_close()
            raise OSError(f"เปิดพอร์ต {self.http_port} ไม่ได้ ({e.strerror or e}) – เปลี่ยนพอร์ตในหน้านี้") from e
        self.port = secure.server_address[1]
        self.http_port = plain.server_address[1]
        self._servers = [secure, plain]
        for srv in self._servers:
            t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True,
                                 name=f"mobile-{srv.server_address[1]}")
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        servers, self._servers = self._servers, []
        self.service.bump("stop")  # long polls answer at once
        for srv in servers:
            srv.shutdown()
            srv.server_close()
            srv.close_connections()
        self._threads = []

    # ---- addresses ------------------------------------------------------------------------------------
    @property
    def address(self) -> str:
        return self.addresses[0] if self.addresses else "127.0.0.1"

    def app_url(self, ip: str | None = None) -> str:
        return f"https://{ip or self.address}:{self.port}/"

    def setup_url(self, ip: str | None = None, code: str = "") -> str:
        return f"http://{ip or self.address}:{self.http_port}/" + (f"?pair={quote(code)}" if code else "")

    # ---- helpers for the handlers --------------------------------------------------------------------------
    def call(self, fn, *args, **kw):
        return self.executor(fn, *args, **kw)

    def allow_pair_try(self, ip: str) -> bool:
        now = time.monotonic()
        tries = [t for t in self._pair_tries.get(ip, []) if now - t < 600]
        tries.append(now)
        self._pair_tries[ip] = tries
        return len(tries) <= 12

    def static_file(self, path: str) -> Path | None:
        rel = path.lstrip("/") or "index.html"
        target = (self.static_dir / rel).resolve()
        root = self.static_dir.resolve()
        if root != target and root not in target.parents:
            return None
        if target.is_dir():
            target = target / "index.html"
        return target if target.is_file() else None

    def build_id(self) -> str:
        """Changes when any file of the app changes: the phones' service worker then takes the new files."""
        now = time.monotonic()
        if now - getattr(self, "_build_at", -99) > 5:
            parts = []
            for file in sorted(self.static_dir.rglob("*")):
                if file.is_file():
                    st = file.stat()
                    parts.append(f"{file.relative_to(self.static_dir).as_posix()}:{st.st_size}:{st.st_mtime_ns}")
            import hashlib

            self._build = hashlib.sha1("|".join(parts).encode()).hexdigest()[:12]
            self._build_at = now
        return self._build

    def zipped(self, file: Path, data: bytes) -> bytes:
        key = (str(file), file.stat().st_mtime_ns, len(data))
        out = self._zip_cache.get(key)
        if out is None:
            out = self._zip_cache[key] = gzip.compress(data, 6)
        return out


class _Base(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "RRS-Mobile"
    sys_version = ""
    timeout = 40  # idle keep-alive connections close after this
    server: _Server

    def log_message(self, format, *args):  # noqa: A002 - quiet
        pass

    @property
    def hub(self) -> MobileServer:
        return self.server.hub

    @property
    def client_ip(self) -> str:
        return self.client_address[0] if self.client_address else ""

    def send_bytes(self, status: int, data: bytes, content_type: str, headers: dict | None = None,
                   zip_ok: bool = False) -> None:
        if zip_ok and len(data) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            data = gzip.compress(data, 5) if not isinstance(zip_ok, bytes) else zip_ok
            headers = {**(headers or {}), "Content-Encoding": "gzip", "Vary": "Accept-Encoding"}
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status: int, obj, headers: dict | None = None) -> None:
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_bytes(status, data, "application/json; charset=utf-8",
                        {"Cache-Control": "no-store", **(headers or {})}, zip_ok=True)

    def send_static(self, file: Path) -> None:
        etag = f'"{file.stat().st_mtime_ns:x}-{file.stat().st_size:x}"'
        headers = {"ETag": etag, "Cache-Control": "no-cache"}
        if file.suffix == ".html":
            headers["Content-Security-Policy"] = CSP
        if file.name == "sw.js":
            headers["Service-Worker-Allowed"] = "/"
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = file.read_bytes()
        ctype = TYPES.get(file.suffix.lower()) or mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        zipped = self.hub.zipped(file, data) if file.suffix.lower() in ZIP_TYPES else False
        self.send_bytes(200, data, ctype, headers, zip_ok=zipped)

    def read_body(self) -> bytes:
        """The whole body, read before anything is answered (bytes left unread would be taken for the next request
        of the connection, and the phone would see the connection reset)."""
        if hasattr(self, "_body"):
            return self._body
        try:
            length = max(0, int(self.headers.get("Content-Length") or 0))
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self.close_connection = True
            self._body = b""
            raise MobileError("ข้อมูลใหญ่เกินไป", 413)
        self._body = self.rfile.read(length) if length else b""
        return self._body

    def read_json(self) -> dict:
        raw = self.read_body()
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise MobileError("ข้อมูลไม่ถูกต้อง") from None
        if not isinstance(data, dict):
            raise MobileError("ข้อมูลไม่ถูกต้อง")
        return data


class _Handler(_Base):
    """HTTPS: the app and its API."""

    def do_GET(self):  # noqa: N802
        self._route("GET")

    def do_HEAD(self):  # noqa: N802
        self._route("GET")

    def do_POST(self):  # noqa: N802
        self._route("POST")

    def do_OPTIONS(self):  # noqa: N802 - the setup page checks /api/ping from http://
        self.send_bytes(204, b"", "text/plain", {"Access-Control-Allow-Origin": "*",
                                                 "Access-Control-Allow-Methods": "GET",
                                                 "Access-Control-Max-Age": "600"})

    def _route(self, method: str) -> None:
        url = urlsplit(self.path)
        path = url.path
        query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        if hasattr(self, "_body"):
            del self._body  # a new request on a kept connection
        try:
            if method == "POST":
                self.read_body()
            if path.startswith("/api/"):
                self._api(method, path[5:], query)
                return
            if method != "GET":
                raise MobileError("ไม่พบ", 404)
            if path == "/sw.js":
                file = self.hub.static_file("sw.js")
                if file is None:
                    raise MobileError("ไม่พบ", 404)
                data = file.read_bytes().replace(b"__BUILD__", self.hub.build_id().encode())
                self.send_bytes(200, data, TYPES[".js"], {"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})
                return
            file = self.hub.static_file(path)
            if file is None:  # the app routes (#/…) all start from index.html
                file = self.hub.static_file("index.html") if "." not in path.rsplit("/", 1)[-1] else None
            if file is None:
                raise MobileError("ไม่พบ", 404)
            self.send_static(file)
        except MobileError as e:
            self.send_json(e.status, {"error": str(e)})
        except Busy:
            self.send_json(503, {"error": "โปรแกรมบนคอมกำลังทำงานอื่นอยู่ ลองอีกครั้ง"})
        except (ConnectionError, ssl.SSLError, TimeoutError):
            self.close_connection = True
        except Exception:  # noqa: BLE001 - the phone gets a message, the PC the trace
            traceback.print_exc()
            try:
                self.send_json(500, {"error": "เกิดข้อผิดพลาดในโปรแกรมบนคอม"})
            except OSError:
                self.close_connection = True

    def _device(self):
        auth = self.headers.get("Authorization") or ""
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        device = self.hub.call(self.hub.service.authenticate, token, self.client_ip)
        if device is None:
            raise MobileError("ยังไม่ได้จับคู่เครื่องนี้ หรือถูกยกเลิกสิทธิ์ – สแกน QR จับคู่ที่หน้า มือถือ & AR บนคอม", 401)
        return device

    def _api(self, method: str, name: str, q: dict) -> None:
        s = self.hub.service
        call = self.hub.call
        if name == "ping":
            self.send_json(200, {"ok": True, "app": "RRS Part List Studio"}, {"Access-Control-Allow-Origin": "*"})
            return
        if name == "pair" and method == "POST":
            if not self.hub.allow_pair_try(self.client_ip):
                raise MobileError("ลองจับคู่หลายครั้งเกินไป รอ 10 นาที", 429)
            body = self.read_json()
            device, token = call(s.pair, body.get("code", ""), body.get("name", ""), body.get("role", "station"),
                                 body.get("station", ""), self.client_ip, self.headers.get("User-Agent", ""))
            self.send_json(200, {"token": token, "device": device.to_json(), "hello": call(s.hello, device)})
            return
        device = self._device()
        if name == "events":  # long poll on this thread
            try:
                since = int(q.get("since") or 0)
            except ValueError:
                since = 0
            self.send_json(200, s.wait_version(since, timeout=20.0))
            return
        if name == "image":
            path = call(s.image_path, q.get("code", ""))
            if not path:
                raise MobileError("ไม่มีรูป", 404)
            file = Path(path)
            ctype = TYPES.get(file.suffix.lower(), "application/octet-stream")
            self.send_bytes(200, file.read_bytes(), ctype, {"Cache-Control": "private, max-age=600"})
            return
        body = self.read_json() if method == "POST" else {}
        rid = self.headers.get("X-Request-Id", "")[:64]
        answer = self._call(method, name, q, body, device, rid)
        self.send_json(200, answer)

    def _call(self, method: str, name: str, q: dict, b: dict, device, rid: str):
        s = self.hub.service
        call = self.hub.call
        gets = {
            "hello": lambda: s.hello(device),
            "dashboard": lambda: s.dashboard(device),
            "jobs": lambda: s.jobs(q.get("all") == "1"),
            "job": lambda: s.job(q.get("no", "")),
            "stations": s.stations,
            "queue": lambda: s.queue(q.get("step", "")),
            "activity": lambda: s.activity(int(q.get("limit") or 30)),
            "items": lambda: s.search(q.get("q", ""), q.get("group", ""), q.get("only", ""), int(q.get("limit") or 60)),
            "item": lambda: s.item(q.get("code", "")),
            "outline": lambda: s.outline(q.get("code", "")),
            "picklists": s.picklists,
            "picklist": lambda: s.picklist(q.get("job", "")),
            "map": s.store_map,
            "navigate": lambda: s.navigate(q.get("from", ""), q.get("to", "")),
            "mine": lambda: s.my_submissions(device),
        }
        posts = {
            "resolve": lambda: s.resolve(b.get("texts") or []),
            "record": lambda: s.record(device, b.get("job_no", ""), b.get("index"), b.get("step", ""), b.get("qty"),
                                       b.get("note", "")),
            "scrap": lambda: s.scrap(device, b.get("job_no", ""), b.get("index"), b.get("step", ""), b.get("qty"),
                                     b.get("reason", "")),
            "problem": lambda: s.report_problem(device, b.get("text", ""), b.get("job_no", ""), b.get("index"),
                                                b.get("step", "")),
            "solve": lambda: s.solve_problem(b.get("id", ""), device.name, device),
            "count": lambda: s.submit_count(device, b.get("lines") or [], b.get("note", "")),
            "pick": lambda: s.submit_pick(device, b.get("job_no", ""), b.get("lines") or [], b.get("note", "")),
            "profile": lambda: s.update_profile(device, b.get("name", ""), b.get("station")),
        }
        if method == "GET" and name in gets:
            return call(gets[name])
        if method == "POST" and name in posts:
            if name == "resolve":
                return call(posts[name])
            return call(s.once, f"{device.id}:{rid}" if rid else "", posts[name])
        raise MobileError("ไม่พบคำสั่งนี้", 404)


class _SetupHandler(_Base):
    """http:// - the certificate and the first steps, nothing else."""

    def do_GET(self):  # noqa: N802
        url = urlsplit(self.path)
        folder = self.hub.cert_dir
        try:
            if url.path in ("/ca.crt", "/rrs-ca.crt", "/ca.cer"):
                self.send_bytes(200, certs.ca_der(folder), "application/x-x509-ca-cert",
                                {"Content-Disposition": 'attachment; filename="rrs-partlist-ca.crt"'})
            elif url.path == "/ca.pem":
                self.send_bytes(200, certs.ca_pem(folder), "application/x-pem-file",
                                {"Content-Disposition": 'attachment; filename="rrs-partlist-ca.pem"'})
            elif url.path in ("/rrs.mobileconfig", "/ios"):
                self.send_bytes(200, certs.mobileconfig(folder), "application/x-apple-aspen-config",
                                {"Content-Disposition": 'attachment; filename="rrs-partlist.mobileconfig"'})
            elif url.path in ("/", "/index.html", "/setup"):
                code = parse_qs(url.query).get("pair", [""])[-1]
                host = (self.headers.get("Host") or "").split(":")[0] or self.hub.address
                page = setup_page(host, self.hub.port, self.hub.http_port, code,
                                  certs.info(folder).get("ca_fingerprint", ""))
                self.send_bytes(200, page.encode("utf-8"), "text/html; charset=utf-8",
                                {"Cache-Control": "no-store"}, zip_ok=True)
            elif url.path == "/icon.png":
                file = self.hub.static_file("icons/icon-192.png")
                if file is None:
                    raise FileNotFoundError
                self.send_static(file)
            else:
                self.send_bytes(404, "ไม่พบ".encode(), "text/plain; charset=utf-8")
        except (ConnectionError, ssl.SSLError, TimeoutError):
            self.close_connection = True
        except OSError:
            self.send_bytes(404, "ไม่พบ".encode(), "text/plain; charset=utf-8")

    do_HEAD = do_GET


def setup_page(host: str, port: int, http_port: int, code: str, fp: str) -> str:
    app = f"https://{host}:{port}/" + (f"#pair={quote(code)}" if code else "")
    ping = f"https://{host}:{port}/api/ping"
    esc = html.escape
    return f"""<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ติดตั้งแอปมือถือ – RRS</title>
<style>
:root{{color-scheme:light dark;--bg:#f3f6fb;--card:#fff;--ink:#0f1c2e;--sub:#5b6b80;--line:#dbe3ee;--acc:#1f6feb;--ok:#15803d}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0b1220;--card:#111a2b;--ink:#e6edf7;--sub:#93a4bb;--line:#22314a;--acc:#5b9dff;--ok:#4ade80}}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}}
main{{max-width:560px;margin:0 auto;padding:20px 16px 48px}}h1{{font-size:22px;margin:8px 0 2px}}p{{margin:6px 0}}
.sub{{color:var(--sub);font-size:14px}}.card{{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin:14px 0}}
.n{{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--acc);color:#fff;font-weight:700;margin-right:8px}}
a.btn{{display:block;text-align:center;text-decoration:none;background:var(--acc);color:#fff;font-weight:700;border-radius:12px;padding:14px;margin:10px 0}}
a.btn.alt{{background:transparent;color:var(--acc);border:1.5px solid var(--acc)}}
ol{{padding-left:20px;margin:8px 0}}li{{margin:4px 0}}.ok{{color:var(--ok);font-weight:700}}code{{font-size:12px;word-break:break-all}}
.tabs{{display:flex;gap:8px;margin:8px 0}}.tabs button{{flex:1;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit}}
.tabs button.on{{border-color:var(--acc);color:var(--acc);font-weight:700}}.hide{{display:none}}
</style></head><body><main>
<img src="/icon.png" width="56" height="56" alt="" style="border-radius:14px">
<h1>แอปมือถือ RRS Part List Studio</h1>
<p class="sub">ติดตามการผลิต · สแกน AR นับสต็อก · หยิบของด้วย AR – เชื่อมกับโปรแกรมบนคอม {esc(host)}</p>
<div class="card" id="state"><b>กำลังตรวจการเชื่อมต่อ…</b></div>
<div class="card"><p><span class="n">1</span><b>ติดตั้งใบรับรองของเครื่องนี้ (ครั้งเดียว)</b></p>
<p class="sub">ทำให้แอปเปิดกล้องได้และไม่ขึ้นหน้าเตือนความปลอดภัย</p>
<div class="tabs"><button id="t-ios" onclick="tab('ios')">iPhone / iPad</button><button id="t-and" onclick="tab('and')">Android</button></div>
<div id="ios"><a class="btn" href="/rrs.mobileconfig">ดาวน์โหลดใบรับรอง (iPhone / iPad)</a><ol>
<li>เปิดหน้านี้ใน <b>Safari</b> แล้วกดปุ่มด้านบน → <b>อนุญาต</b></li>
<li><b>ตั้งค่า</b> → <b>ดาวน์โหลดโปรไฟล์แล้ว</b> → <b>ติดตั้ง</b> (ใส่รหัสเครื่อง)</li>
<li><b>ตั้งค่า → ทั่วไป → เกี่ยวกับ → การตั้งค่าความเชื่อถือใบรับรอง</b> → เปิดสวิตช์ <i>RRS Part List Studio Local CA</i></li></ol></div>
<div id="and" class="hide"><a class="btn" href="/ca.crt">ดาวน์โหลดใบรับรอง (Android)</a><ol>
<li>กดปุ่มด้านบน แล้วเก็บไฟล์ไว้</li>
<li><b>การตั้งค่า → ความปลอดภัย → การเข้ารหัสและข้อมูลเข้าสู่ระบบ → ติดตั้งใบรับรอง → ใบรับรอง CA</b> → ติดตั้งต่อ → เลือกไฟล์ <i>rrs-partlist-ca.crt</i>
<br><span class="sub">(แต่ละยี่ห้อชื่อเมนูต่างกันเล็กน้อย – ค้นหาคำว่า “ใบรับรอง” ในการตั้งค่า)</span></li></ol></div>
<p class="sub">ลายนิ้วมือใบรับรอง (SHA-256): <code>{esc(fp)}</code></p></div>
<div class="card"><p><span class="n">2</span><b>เปิดแอป</b></p>
<a class="btn" id="open" href="{esc(app)}">เปิดแอปมือถือ</a>
<p class="sub">แล้วเพิ่มลงหน้าจอหลัก: iPhone ปุ่มแชร์ → <b>เพิ่มไปยังหน้าจอโฮม</b> · Android เมนู ⋮ → <b>ติดตั้งแอป</b></p>
<p class="sub">ยังไม่ติดตั้งใบรับรองก็เปิดได้: กด <i>ขั้นสูง → ไปต่อ</i> ที่หน้าเตือน (บางเครื่องใช้กล้องได้ แต่ติดตั้งลงหน้าจอหลักไม่ได้)</p>
<a class="btn alt" href="http://{esc(host)}:{http_port}/{('?pair=' + quote(code)) if code else ''}">โหลดหน้านี้ใหม่</a></div>
<script>
function tab(t){{for(const k of ['ios','and']){{document.getElementById(k).classList.toggle('hide',k!==t);document.getElementById('t-'+k).classList.toggle('on',k===t)}}}}
tab(/android/i.test(navigator.userAgent)?'and':'ios');
fetch({json.dumps(ping)},{{mode:'cors'}}).then(r=>r.json()).then(()=>{{
 document.getElementById('state').innerHTML='<span class="ok">✓ เครื่องนี้เชื่อถือใบรับรองแล้ว</span> – กด <b>เปิดแอปมือถือ</b> ได้เลย';
}}).catch(()=>{{
 document.getElementById('state').innerHTML='<b>ยังไม่ได้ติดตั้งใบรับรอง</b> – ทำขั้นที่ 1 ก่อน แล้วกด <i>โหลดหน้านี้ใหม่</i>';
}});
</script></main></body></html>"""
