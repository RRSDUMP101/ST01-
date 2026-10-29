"""The mobile app inside the program: MobileService on the data of the program, the HTTPS server for the phones,
and the Qt glue - the server threads run their calls on the main thread, changes made on the PC reach the phones."""

from __future__ import annotations

import threading

from PySide6.QtCore import QObject, QThread, Signal, Slot

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

    def __init__(self, state: AppState):
        super().__init__()
        self.state = state
        self.folder = state.data_dir() / "mobile"
        self.service = MobileService(state, self.folder, on_event=self._on_event)
        self.executor = MainThreadExecutor()
        self.server: MobileServer | None = None
        self.error = ""
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
        if self.server is not None:
            self.server.stop()
        self.server = None
        self.changed.emit()

    def restart(self) -> bool:
        self.stop()
        return self.start()

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
