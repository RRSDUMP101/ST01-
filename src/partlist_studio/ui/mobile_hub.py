"""The mobile app inside the program: MobileService on the data of the program, the HTTPS server for the phones,
and the Qt glue - the server threads run their calls on the main thread, changes made on the PC reach the phones."""

from __future__ import annotations

import threading

from PySide6.QtCore import QObject, QThread, Signal, Slot

from ..core import tunnel as tunnels
from ..core.mobile import MobileService
from ..core.mobile_server import Busy, MobileServer
from .state import AppState


class MainThreadExecutor(QObject):
    """executor(fn, *args) from any thread: fn runs on the thread of this object (the Qt main thread)."""

    _run = Signal(object)

    def __init__(self, timeout: float = 15.0):
        super().__init__()
        self.timeout = timeout
        self._run.connect(self._exec)

    @Slot(object)
    def _exec(self, job) -> None:
        job()

    def __call__(self, fn, *args, **kw):
        if QThread.currentThread() is self.thread():
            return fn(*args, **kw)
        done = threading.Event()
        box: dict = {}

        def job():
            try:
                box["value"] = fn(*args, **kw)
            except BaseException as e:  # noqa: BLE001 - raised again on the server thread
                box["error"] = e
            finally:
                done.set()

        self._run.emit(job)
        if not done.wait(self.timeout):
            raise Busy("the program is busy")
        if "error" in box:
            raise box["error"]
        return box.get("value")


class MobileHub(QObject):
    changed = Signal()  # devices, inbox or the server changed: the page shows it again
    event = Signal(str, object)  # something a phone did: kind ('problem', 'count', 'pick', 'device', 'record' …), payload
    online_changed = Signal()  # the link from outside the factory (its state comes from the tunnel's thread)
    download_progress = Signal(int, int)  # cloudflared being downloaded: bytes, total
    _downloaded = Signal()  # from the download thread: open the tunnel on the main thread
    _shortened = Signal(str, str)  # (long link, short link) from the thread that asked is.gd
    invite_shortened = Signal(str, str)  # (invitation link, its short link - "" when none) for the invitation dialog

    def __init__(self, state: AppState):
        super().__init__()
        self.state = state
        self.folder = state.data_dir() / "mobile"
        self.service = MobileService(state, self.folder, on_event=self._on_event)
        self.executor = MainThreadExecutor()
        self.server: MobileServer | None = None
        self.error = ""
        self.tunnel: tunnels.Tunnel | None = None
        self.online_error = ""
        self.downloading = False
        self.online_changed.connect(self._online_now)
        self._downloaded.connect(self.start_online)
        self._shortened.connect(self._short_now)
        self.short_url = ""
        self._short_for = ""
        for signal in (state.jobs_changed, state.stock_changed, state.ledger_changed, state.catalog_changed,
                       state.laser_changed, state.models_changed):
            signal.connect(self._pc_changed)

    @Slot()
    def _pc_changed(self) -> None:
        self.service.bump("pc")

    def _on_event(self, kind: str, payload) -> None:
        self.event.emit(kind, payload)
        if kind not in ("record", "scrap"):
            self.changed.emit()

    # ---- the server ----------------------------------------------------------------------------------
    @property
    def running(self) -> bool:
        return self.server is not None and self.server.running

    def option(self, key: str):
        return self.service.data.option(key)

    def set_options(self, **values) -> None:
        self.service.data.options.update(values)
        self.service.save()

    def start(self) -> bool:
        if self.running:
            return True
        self.error = ""
        server = MobileServer(self.service, self.folder / "certs", self.executor,
                              port=int(self.option("port")), http_port=int(self.option("http_port")))
        try:
            server.start()
        except OSError as e:
            self.error = str(e)
            self.changed.emit()
            return False
        self.server = server
        if not self.service.pairing_open:
            self.service.new_pair_code()
        self.changed.emit()
        return True

    def stop(self) -> None:
        self.stop_online()
        if self.server is not None:
            self.server.stop()
        self.server = None
        self.changed.emit()

    # ---- ใช้จากนอกโรงงาน (ออนไลน์) --------------------------------------------------------------------------
    @property
    def online(self) -> bool:
        return self.tunnel is not None and self.tunnel.state == tunnels.ON and bool(self.tunnel.public_url)

    @property
    def online_state(self) -> str:
        if self.downloading:
            return tunnels.STARTING
        return self.tunnel.state if self.tunnel is not None else (tunnels.ERROR if self.online_error else tunnels.OFF)

    def online_url(self) -> str:
        return self.tunnel.public_url if self.online else ""

    def needs_download(self) -> bool:
        return self.option("online_mode") != tunnels.OWN and tunnels.find_cloudflared(self.folder) is None

    def start_online(self) -> bool:
        """Open the link from outside (the server must be on). cloudflared missing: download it first (a thread)."""
        self.online_error = ""
        if not self.running and not self.start():
            self.online_error = self.error
            self.online_changed.emit()
            return False
        if self.tunnel is not None and self.tunnel.running:
            return True
        if self.needs_download():
            if not self.downloading:
                self.downloading = True
                threading.Thread(target=self._download, daemon=True, name="cloudflared-download").start()
            self.online_changed.emit()
            return True
        self.tunnel = tunnels.Tunnel(self.folder, self.server.port, self.option("online_mode"),
                                     self.option("online_token"), self.option("online_url"),
                                     on_change=self.online_changed.emit)
        self.tunnel.start()
        self.online_changed.emit()
        return self.tunnel.state != tunnels.ERROR

    def _download(self) -> None:
        try:
            tunnels.download_cloudflared(self.folder, lambda done, total: self.download_progress.emit(done, total))
        except Exception as e:  # noqa: BLE001 - shown on the page
            self.online_error = f"ดาวน์โหลด cloudflared ไม่ได้: {e or type(e).__name__} · {tunnels.install_hint()}"
            self.downloading = False
            self.online_changed.emit()
            return
        self.downloading = False
        self._downloaded.emit()

    def stop_online(self) -> None:
        if self.tunnel is not None:
            self.tunnel.on_change = None
            self.tunnel.stop()
        self.tunnel = None
        self.online_error = ""
        self._online_now()

    @Slot()
    def _online_now(self) -> None:
        """The tunnel's state on the main thread: the phones learn the link (hello / settings), the page shows it."""
        url = self.online_url()
        if self.tunnel is not None and self.tunnel.state == tunnels.ERROR:
            self.online_error = self.tunnel.error
        if url != self._short_for:  # a new link: shorten it (the long one of a quick tunnel only)
            self._short_for, self.short_url = url, ""
            if url and self.option("online_short") and self.option("online_mode") == tunnels.QUICK:
                threading.Thread(target=self._shorten, args=(url,), daemon=True, name="shorten").start()
        if self.service.online_url != url or self.service.online_short != self.short_url:
            self.service.online_url, self.service.online_short = url, self.short_url
            self.service.bump("online")
        self.changed.emit()

    def _shorten(self, url: str) -> None:
        self._shortened.emit(url, tunnels.shorten(url + "/"))

    @Slot(str, str)
    def _short_now(self, url: str, short: str) -> None:
        if url == self._short_for and url == self.online_url():
            self.short_url = short
            self._online_now()

    def reshorten(self) -> None:
        """The short-link option changed: shorten the link again (or drop the short one)."""
        self._short_for = ""
        self._online_now()

    def invite_link(self, code: str) -> str:
        """The link of an invitation (one phone, from anywhere): the app online with the code."""
        return f"{self.online_url()}/?pair={code}" if self.online and code else ""

    def shorten_invite(self, code: str) -> bool:
        """Ask for a short link of an invitation (a thread; invite_shortened gives it). False: not shortened (the
        option is off, or the link is the company's own and short already)."""
        link = self.invite_link(code)
        if not link or not self.option("online_short") or self.option("online_mode") != tunnels.QUICK:
            return False
        threading.Thread(target=lambda: self.invite_shortened.emit(link, tunnels.shorten(link)), daemon=True,
                         name="shorten-invite").start()
        return True

    def share_url(self) -> str:
        """The link to send: the short one when there is one."""
        return self.short_url or (self.online_url() + "/" if self.online else "")

    def restart(self) -> bool:
        was_online = self.tunnel is not None and self.tunnel.running
        self.stop()
        ok = self.start()
        if ok and was_online:
            self.start_online()
        return ok

    def addresses(self) -> list[str]:
        return self.server.addresses if self.server is not None else []

    def setup_url(self, ip: str | None = None) -> str:
        if self.server is None:
            return ""
        return self.server.setup_url(ip, self.service.pair_code if self.service.pairing_open else "")

    def app_url(self, ip: str | None = None) -> str:
        return self.server.app_url(ip) if self.server is not None else ""

    def pending(self) -> int:
        return sum(1 for s in self.service.data.inbox if s.is_open)
