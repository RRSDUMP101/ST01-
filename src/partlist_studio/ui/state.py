"""Shared application state and persisted settings."""

from __future__ import annotations

import json

from PySide6.QtCore import QObject, QSettings, Signal

from ..core.dwg_io import DEFAULT_DENSITIES, DrawingData, find_converter
from ..core.models import PartList
from ..core.stock import RequirementLine, StockList


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
    message = Signal(str)

    def __init__(self):
        super().__init__()
        self.settings = Settings()
        self.partlist = PartList()
        self.stock = StockList()
        self.requirements: list[RequirementLine] = []
        self.drawing_cache: dict[str, DrawingData] = {}
        self.path: str = ""
        self.dirty = False

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
