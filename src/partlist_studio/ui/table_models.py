"""Qt table models for parts, stock items and the material check result."""

from __future__ import annotations

from collections import Counter

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QSortFilterProxyModel, Qt
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import QComboBox, QStyledItemDelegate

from ..core.models import COLUMN_KEYS, COLUMN_LABELS, NUMERIC_COLUMNS, PROCESSES, STATUSES, UNITS, Part, PartList
from ..core.stock import STOCK_KEYS, STOCK_LABELS, STOCK_NUMERIC, REQUIREMENT_HEADERS, RequirementLine, StockItem, \
    StockList, requirement_row
from . import theme


def _display(value) -> str:
    if isinstance(value, float):
        return f"{value:,.3f}".rstrip("0").rstrip(".")
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def validate_part(part: Part, duplicates: set[str]) -> tuple[str, str]:
    """(level, message) - level is "error", "warn" or ""."""
    if not part.part_no and not part.name:
        return "error", "ไม่มีรหัสหรือชื่อชิ้นส่วน"
    if part.qty <= 0:
        return "error", "จำนวนต้องมากกว่า 0"
    if part.part_no and part.part_no in duplicates:
        return "warn", "รหัสชิ้นส่วนซ้ำ"
    if not part.material:
        return "warn", "ยังไม่ระบุวัสดุ"
    return "", ""


class PartTableModel(QAbstractTableModel):
    def __init__(self, partlist: PartList, parent=None):
        super().__init__(parent)
        self.partlist = partlist
        self._dups: set[str] = set()
        self.modelReset.connect(self._refresh_dups)
        self.dataChanged.connect(self._refresh_dups)
        self.rowsInserted.connect(self._refresh_dups)
        self.rowsRemoved.connect(self._refresh_dups)

    def _refresh_dups(self, *args):
        counts = Counter(p.part_no for p in self.partlist.parts if p.part_no)
        self._dups = {k for k, v in counts.items() if v > 1}

    def set_partlist(self, partlist: PartList) -> None:
        self.beginResetModel()
        self.partlist = partlist
        self.endResetModel()

    def issues(self) -> list[tuple[int, str, str]]:
        self._refresh_dups()
        out = []
        for row, part in enumerate(self.partlist.parts):
            level, msg = validate_part(part, self._dups)
            if level:
                out.append((row, level, msg))
        return out

    # Qt API --------------------------------------------------------------
    def rowCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(self.partlist.parts)

    def columnCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(COLUMN_KEYS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):  # noqa: N802
        if role == Qt.DisplayRole:
            return COLUMN_LABELS[COLUMN_KEYS[section]] if orientation == Qt.Horizontal else str(section + 1)
        return None

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        part = self.partlist.parts[index.row()]
        key = COLUMN_KEYS[index.column()]
        value = part.get(key)
        if role in (Qt.DisplayRole, Qt.EditRole):
            if role == Qt.DisplayRole and key in NUMERIC_COLUMNS:
                return _display(value) if (value or key == "qty") else ""
            return value
        if role == Qt.TextAlignmentRole and key in NUMERIC_COLUMNS | {"item_no", "unit"}:
            return int(Qt.AlignCenter)
        if role == Qt.ForegroundRole and key == "status":
            return theme.status_color(value)
        if role == Qt.FontRole and key == "status":
            font = QFont()
            font.setBold(True)
            return font
        level, msg = validate_part(part, self._dups)
        if role == Qt.BackgroundRole and level:
            return theme.ERROR_BG if level == "error" else theme.WARN_BG
        if role == Qt.ToolTipRole:
            return msg or (value if key == "remark" else None)
        return None

    def flags(self, index):
        return Qt.ItemIsEnabled | Qt.ItemIsSelectable | Qt.ItemIsEditable

    def setData(self, index, value, role=Qt.EditRole):  # noqa: N802
        if role != Qt.EditRole or not index.isValid():
            return False
        part = self.partlist.parts[index.row()]
        part.set(COLUMN_KEYS[index.column()], value)
        self.dataChanged.emit(self.index(index.row(), 0), self.index(index.row(), self.columnCount() - 1))
        return True

    def insert_parts(self, row: int, parts: list[Part]) -> None:
        if not parts:
            return
        self.beginInsertRows(QModelIndex(), row, row + len(parts) - 1)
        self.partlist.parts[row:row] = parts
        self.endInsertRows()

    def remove_rows(self, rows: list[int]) -> None:
        for row in sorted(set(rows), reverse=True):
            self.beginRemoveRows(QModelIndex(), row, row)
            del self.partlist.parts[row]
            self.endRemoveRows()

    def refresh(self) -> None:
        self.beginResetModel()
        self.endResetModel()


class PartFilterProxy(QSortFilterProxyModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.status = ""
        self.setFilterCaseSensitivity(Qt.CaseInsensitive)
        self.setFilterKeyColumn(-1)

    def set_status(self, status: str) -> None:
        self.status = status
        self.invalidateFilter()

    def filterAcceptsRow(self, row, parent):  # noqa: N802
        model = self.sourceModel()
        if self.status:
            part = model.partlist.parts[row]
            if part.status != self.status:
                return False
        return super().filterAcceptsRow(row, parent)

    def lessThan(self, left, right):  # noqa: N802
        lv, rv = left.data(Qt.EditRole), right.data(Qt.EditRole)
        if COLUMN_KEYS[left.column()] == "item_no":
            try:
                return float(lv or 0) < float(rv or 0)
            except ValueError:
                pass
        if isinstance(lv, (int, float)) and isinstance(rv, (int, float)):
            return lv < rv
        return str(lv) < str(rv)


class ChoiceDelegate(QStyledItemDelegate):
    """Combo box editor for status / process / unit (editable so new values are allowed)."""

    CHOICES = {"status": STATUSES, "process": PROCESSES, "unit": UNITS}

    def createEditor(self, parent, option, index):  # noqa: N802
        key = COLUMN_KEYS[index.column()]
        if key not in self.CHOICES:
            return super().createEditor(parent, option, index)
        combo = QComboBox(parent)
        combo.setEditable(key != "status")
        combo.addItems(self.CHOICES[key])
        return combo

    def setEditorData(self, editor, index):  # noqa: N802
        if isinstance(editor, QComboBox):
            editor.setCurrentText(str(index.data(Qt.EditRole)))
        else:
            super().setEditorData(editor, index)

    def setModelData(self, editor, model, index):  # noqa: N802
        if isinstance(editor, QComboBox):
            model.setData(index, editor.currentText(), Qt.EditRole)
        else:
            super().setModelData(editor, model, index)


class StockTableModel(QAbstractTableModel):
    def __init__(self, stock: StockList, parent=None):
        super().__init__(parent)
        self.stock = stock

    def set_stock(self, stock: StockList) -> None:
        self.beginResetModel()
        self.stock = stock
        self.endResetModel()

    def rowCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(self.stock.items)

    def columnCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(STOCK_KEYS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):  # noqa: N802
        if role == Qt.DisplayRole:
            return STOCK_LABELS[STOCK_KEYS[section]] if orientation == Qt.Horizontal else str(section + 1)
        return None

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        item: StockItem = self.stock.items[index.row()]
        key = STOCK_KEYS[index.column()]
        value = item.get(key)
        if role == Qt.DisplayRole:
            return _display(value) if key in STOCK_NUMERIC else value
        if role == Qt.EditRole:
            return value
        if role == Qt.TextAlignmentRole and key in STOCK_NUMERIC | {"unit"}:
            return int(Qt.AlignCenter)
        if role == Qt.BackgroundRole and key == "on_hand" and item.min_qty and item.on_hand < item.min_qty:
            return theme.WARN_BG
        return None

    def flags(self, index):
        return Qt.ItemIsEnabled | Qt.ItemIsSelectable | Qt.ItemIsEditable

    def setData(self, index, value, role=Qt.EditRole):  # noqa: N802
        if role != Qt.EditRole:
            return False
        self.stock.items[index.row()].set(STOCK_KEYS[index.column()], value)
        self.dataChanged.emit(index, index)
        return True

    def add_item(self) -> None:
        row = len(self.stock.items)
        self.beginInsertRows(QModelIndex(), row, row)
        self.stock.items.append(StockItem())
        self.endInsertRows()

    def remove_rows(self, rows: list[int]) -> None:
        for row in sorted(set(rows), reverse=True):
            self.beginRemoveRows(QModelIndex(), row, row)
            del self.stock.items[row]
            self.endRemoveRows()


class RequirementModel(QAbstractTableModel):
    STATUS_COL = REQUIREMENT_HEADERS.index("สถานะ")
    NUM_COLS = {3, 4, 5, 6, 7, 9}

    def __init__(self, parent=None):
        super().__init__(parent)
        self.lines: list[RequirementLine] = []
        self.rows: list[list] = []

    def set_lines(self, lines: list[RequirementLine]) -> None:
        self.beginResetModel()
        self.lines = lines
        self.rows = [requirement_row(line) for line in lines]
        self.endResetModel()

    def rowCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(self.rows)

    def columnCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(REQUIREMENT_HEADERS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):  # noqa: N802
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            return REQUIREMENT_HEADERS[section]
        return None

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        value = self.rows[index.row()][index.column()]
        status = self.lines[index.row()].status
        if role == Qt.DisplayRole:
            return _display(value)
        if role == Qt.TextAlignmentRole and index.column() in self.NUM_COLS:
            return int(Qt.AlignCenter)
        if role == Qt.ForegroundRole and index.column() == self.STATUS_COL:
            return theme.status_color(status)
        if role == Qt.FontRole and index.column() in (self.STATUS_COL, 9):
            font = QFont()
            font.setBold(True)
            return font
        if role == Qt.BackgroundRole and status in ("ขาด", "ไม่พบในสต็อก"):
            return QColor("#FFF4F4") if status == "ขาด" else QColor("#F6F2FF")
        return None
