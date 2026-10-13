"""Shared application state and persisted settings."""

from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import QObject, QSettings, QStandardPaths, Signal

from ..core import stock as stock_mod
from ..core.company_files import ModelBOM
from ..core.dwg_io import DEFAULT_DENSITIES, DrawingData, find_converter
from ..core.models import PartList
from ..core.stock import RequirementLine, StockItem, StockList, _key
from ..core.xref import CodeXref

MANUAL_SOURCE = "เพิ่มเอง"


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


class AppState(QObject):
    partlist_changed = Signal()  # rows or job info changed
    partlist_replaced = Signal()  # a different document was opened
    stock_changed = Signal()
    requirements_changed = Signal()
    models_changed = Signal()
    xref_changed = Signal()
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
        self._merge_stock()

    def save_library(self) -> None:
        data = {
            "stock_sources": {k: v.to_dict() for k, v in self.stock_sources.items()},
            "active_sources": self.active_sources,
            "models": [m.to_dict() for m in self.models],
            "xref": self.xref.to_dict(),
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
