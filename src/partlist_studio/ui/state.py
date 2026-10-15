"""Shared application state and persisted settings."""

from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import QObject, QSettings, QStandardPaths, Signal

from ..core import stock as stock_mod
from ..core.company_files import ModelBOM
from ..core.dwg_io import DEFAULT_DENSITIES, DrawingData, find_converter
from ..core.laser import CutQueue, FlatLibrary, LaserParams
from ..core.models import PartList
from ..core.movements import Ledger, StockDoc
from ..core.production import Job, RawUse
from ..core.replenish import ReplenishParams
from ..core.stock import RequirementLine, StockItem, StockList, _key
from ..core.xref import CodeXref

MANUAL_SOURCE = "เพิ่มเอง"
MOVED_SOURCE = "รับเข้าในโปรแกรม"  # items first received by a document (FR/RR) that no source had


class Settings:
    def __init__(self):
        self.q = QSettings()

    def get(self, key: str, default: str = "") -> str:
        value = self.q.value(key, default)
        return "" if value is None else str(value)

    def set(self, key: str, value) -> None:
        self.q.setValue(key, value)

    @property
    def densities(self) -> dict[str, float]:
        try:
            data = json.loads(self.get("dwg/densities", ""))
            return {str(k): float(v) for k, v in data.items()} or dict(DEFAULT_DENSITIES)
        except (ValueError, AttributeError):
            return dict(DEFAULT_DENSITIES)

    @densities.setter
    def densities(self, value: dict[str, float]) -> None:
        self.set("dwg/densities", json.dumps(value))

    def converter(self):
        return find_converter(self.get("dwg/converter_path"))

    @property
    def default_thickness(self) -> float:
        """mm for flat patterns whose drawing gives no thickness (0 = none)."""
        try:
            return max(0.0, float(self.get("dwg/default_thickness", "0") or 0))
        except ValueError:
            return 0.0

    @default_thickness.setter
    def default_thickness(self, value: float) -> None:
        self.set("dwg/default_thickness", f"{float(value):g}")

    @property
    def thickness_mode(self) -> str:
        """"drawing" = as written in the drawing, "fixed" = the default thickness for every plate part."""
        return "fixed" if self.get("dwg/thickness_mode") == "fixed" else "drawing"

    @thickness_mode.setter
    def thickness_mode(self, value: str) -> None:
        self.set("dwg/thickness_mode", value)

    @property
    def replenish(self) -> ReplenishParams:
        p = ReplenishParams()
        try:
            data = json.loads(self.get("stock/replenish", "") or "{}")
        except ValueError:
            data = {}
        for k, v in data.items():
            if hasattr(p, k):
                setattr(p, k, float(v) if k != "history_days" else int(v))
        return p

    @replenish.setter
    def replenish(self, p: ReplenishParams) -> None:
        self.set("stock/replenish", json.dumps(p.__dict__))

    @property
    def laser(self) -> LaserParams:
        try:
            return LaserParams.from_dict(json.loads(self.get("laser/params", "") or "{}"))
        except ValueError:
            return LaserParams()

    @laser.setter
    def laser(self, p: LaserParams) -> None:
        self.set("laser/params", json.dumps(p.to_dict(), ensure_ascii=False))


class AppState(QObject):
    partlist_changed = Signal()  # rows or job info changed
    partlist_replaced = Signal()  # a different document was opened
    stock_changed = Signal()
    requirements_changed = Signal()
    models_changed = Signal()
    xref_changed = Signal()
    jobs_changed = Signal()
    ledger_changed = Signal()
    laser_changed = Signal()  # flat pattern library or cut programs changed
    message = Signal(str)

    def __init__(self, data_dir: str | Path | None = None):
        super().__init__()
        self.settings = Settings()
        self.partlist = PartList()
        self.stock = StockList()  # merged view of the active stock sources
        self.stock_sources: dict[str, StockList] = {}
        self.active_sources: list[str] = []
        self.models: list[ModelBOM] = []
        self.xref = CodeXref()
        self.ledger = Ledger()
        self.jobs: list[Job] = []
        self.raw_uses: list[RawUse] = []
        self.flats = FlatLibrary()  # คลังรูปคลี่: flat pattern of every part code from the drawings
        self.cut_queue = CutQueue()  # laser cut programs
        self.requirements: list[RequirementLine] = []
        self.drawing_cache: dict[str, DrawingData] = {}
        self.path: str = ""
        self.dirty = False
        self._data_dir = Path(data_dir) if data_dir else None
        stock_mod.XREF_LOOKUP = self.xref_lookup
        self.load_library()

    # ---- company data kept between sessions (stock sources, model BOMs, code table) ------------
    def data_dir(self) -> Path:
        if self._data_dir is None:
            self._data_dir = Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
        self._data_dir.mkdir(parents=True, exist_ok=True)
        return self._data_dir

    def image_dir(self) -> Path:
        path = self.data_dir() / "images"
        path.mkdir(exist_ok=True)
        return path

    def xref_lookup(self, code: str) -> list[str]:
        return self.xref.lookup(code)

    def load_library(self) -> None:
        file = self.data_dir() / "library.json"
        if not file.is_file():
            return
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except ValueError:
            return
        self.stock_sources = {k: StockList.from_dict(v) for k, v in data.get("stock_sources", {}).items()}
        self.active_sources = [n for n in data.get("active_sources", []) if n in self.stock_sources]
        self.models = [ModelBOM.from_dict(m) for m in data.get("models", [])]
        self.xref = CodeXref.from_dict(data.get("xref", {}))
        self.ledger = Ledger.from_dict(data.get("ledger", {}))
        self.jobs = [Job.from_dict(j) for j in data.get("jobs", [])]
        self.raw_uses = [RawUse(**{k: v for k, v in r.items() if k in RawUse.__dataclass_fields__})
                         for r in data.get("raw_uses", [])]
        self.flats = FlatLibrary.from_dict(data.get("flats", {}))
        self.cut_queue = CutQueue.from_dict(data.get("cut_queue", {}))
        self._merge_stock()

    def save_library(self) -> None:
        data = {
            "stock_sources": {k: v.to_dict() for k, v in self.stock_sources.items()},
            "active_sources": self.active_sources,
            "models": [m.to_dict() for m in self.models],
            "xref": self.xref.to_dict(),
            "ledger": self.ledger.to_dict(),
            "jobs": [j.to_dict() for j in self.jobs],
            "raw_uses": [r.__dict__ for r in self.raw_uses],
            "flats": self.flats.to_dict(),
            "cut_queue": self.cut_queue.to_dict(),
        }
        (self.data_dir() / "library.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def _merge_stock(self) -> None:
        items: list[StockItem] = []
        seen: set[str] = set()
        for name in self.active_sources:
            for item in self.stock_sources[name].items:
                key = _key(item.code) or "#" + _key(item.name)
                if key in seen:
                    continue
                seen.add(key)
                items.append(item)
        self.stock = StockList(items=items, source=" + ".join(self.active_sources),
                               has_quantities=all(self.stock_sources[n].has_quantities for n in self.active_sources))

    def rebuild_stock(self) -> None:
        self._merge_stock()
        self.save_library()
        self.stock_changed.emit()

    def add_stock_source(self, name: str, stock: StockList, activate: bool = True) -> None:
        self.stock_sources[name] = stock
        if activate and name not in self.active_sources:
            self.active_sources.append(name)
        self.rebuild_stock()

    def remove_stock_source(self, name: str) -> None:
        self.stock_sources.pop(name, None)
        self.active_sources = [n for n in self.active_sources if n != name]
        self.rebuild_stock()

    def set_source_active(self, name: str, active: bool) -> None:
        if active and name not in self.active_sources:
            self.active_sources.append(name)
        elif not active:
            self.active_sources = [n for n in self.active_sources if n != name]
        self.rebuild_stock()

    def add_manual_item(self) -> StockItem:
        source = self.stock_sources.setdefault(MANUAL_SOURCE, StockList(source=MANUAL_SOURCE))
        item = StockItem()
        source.items.append(item)
        if MANUAL_SOURCE not in self.active_sources:
            self.active_sources.append(MANUAL_SOURCE)
        self.rebuild_stock()
        return item

    def remove_items(self, items: list[StockItem]) -> None:
        ids = {id(i) for i in items}
        for source in self.stock_sources.values():
            source.items = [i for i in source.items if id(i) not in ids]
        self.rebuild_stock()

    def set_models(self, models: list[ModelBOM], replace_same_name: bool = True) -> None:
        names = {m.name for m in models}
        self.models = [m for m in self.models if not (replace_same_name and m.name in names)] + models
        self.save_library()
        self.models_changed.emit()

    def set_xref(self, xref: CodeXref) -> None:
        self.xref = xref
        self.save_library()
        self.xref_changed.emit()
        self.stock_changed.emit()

    # ---- Express item list, documents, jobs ------------------------------------------------------
    def express_stock(self) -> StockList | None:
        """The Express item list (STMASR0200 / 4.สินค้า export) with the most RRS codes."""
        express = [s for n, s in self.stock_sources.items() if n.startswith("Express")]
        if not express:
            return None
        return max(express, key=lambda s: sum(1 for i in s.items if i.code.upper().startswith("RRS")))

    def post_doc(self, doc: StockDoc) -> list[str]:
        """Save a stock document: balances change and the movements are recorded."""
        new_items = self.stock_sources.setdefault(MOVED_SOURCE, StockList(source=MOVED_SOURCE))
        if doc not in self.ledger.docs:
            if not doc.doc_no:
                doc.doc_no = self.ledger.next_no(doc.doc_type, doc.date)
            self.ledger.docs.append(doc)
        warnings = self.ledger.post(doc, self.stock, new_items)
        if new_items.items and MOVED_SOURCE not in self.active_sources:
            self.active_sources.append(MOVED_SOURCE)
        if not new_items.items:
            self.stock_sources.pop(MOVED_SOURCE, None)
        self.rebuild_stock()
        self.ledger_changed.emit()
        return warnings

    def cancel_doc(self, doc: StockDoc) -> None:
        self.ledger.cancel(doc, self.stock)
        self.rebuild_stock()
        self.ledger_changed.emit()

    def save_jobs(self) -> None:
        self.save_library()
        self.jobs_changed.emit()

    def save_laser(self) -> None:
        self.save_library()
        self.laser_changed.emit()

    def mark_dirty(self) -> None:
        self.dirty = True
        self.partlist_changed.emit()

    def replace(self, partlist: PartList, path: str = "") -> None:
        self.partlist = partlist
        self.path = path
        self.dirty = False
        self.requirements = []
        self.drawing_cache.clear()
        self.partlist_replaced.emit()
        self.partlist_changed.emit()
        self.requirements_changed.emit()

    def notify(self, text: str) -> None:
        self.message.emit(text)
