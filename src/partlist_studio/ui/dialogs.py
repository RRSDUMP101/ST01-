"""Import dialogs: column mapping for tables, review of parts found in DWG/DXF drawings."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QAbstractItemView, QCheckBox, QComboBox, QDialog, QDialogButtonBox, QGridLayout,
                               QHBoxLayout, QHeaderView, QLabel, QListWidget, QListWidgetItem, QSpinBox, QSplitter,
                               QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from ..core.dwg_io import CandidatePart, DrawingData, drawing_to_candidates
from ..core.models import COLUMN_KEYS, COLUMN_LABELS, NUMERIC_COLUMNS, Part
from ..core.mapping import auto_map
from ..core.partlist_io import TableImport
from .widgets import DrawingPreview

NOT_USED = "— ไม่ใช้ —"


class ColumnMappingDialog(QDialog):
    """Let the user confirm which column of a ZWCAD / Excel / Google table goes to which field."""

    def __init__(self, table: TableImport, source_name: str, parent=None):
        super().__init__(parent)
        self.table = table
        self.setWindowTitle(f"จับคู่คอลัมน์ – {source_name}")
        self.resize(1000, 560)
        lay = QVBoxLayout(self)
        hint = QLabel("ตรวจสอบว่าแต่ละคอลัมน์ในไฟล์ตรงกับช่องใดใน Part List "
                      "(ระบบจับคู่ให้อัตโนมัติจากชื่อหัวตาราง ZWCAD / Excel / Google Sheet)")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)

        row = QHBoxLayout()
        row.addWidget(QLabel("แถวหัวตาราง:"))
        self.header_spin = QSpinBox()
        self.header_spin.setRange(1, max(1, len(table.rows)))
        self.header_spin.setValue(table.header_index + 1)
        self.header_spin.valueChanged.connect(self._header_changed)
        row.addWidget(self.header_spin)
        row.addStretch(1)
        self.count_label = QLabel()
        row.addWidget(self.count_label)
        lay.addLayout(row)

        self.grid = QTableWidget()
        self.grid.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.grid.verticalHeader().setVisible(False)
        lay.addWidget(self.grid, 1)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Ok).setText("นำเข้า")
        buttons.button(QDialogButtonBox.Ok).setProperty("kind", "primary")
        buttons.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)
        self._combos: list[QComboBox] = []
        self._build()

    def _header_changed(self, value: int) -> None:
        self.table.header_index = value - 1
        self.table.mapping = auto_map(self.table.header)
        self._build()

    def _build(self) -> None:
        width = max((len(r) for r in self.table.rows), default=0)
        preview = self.table.rows[self.table.header_index:self.table.header_index + 30]
        self.grid.clear()
        self.grid.setColumnCount(width)
        self.grid.setRowCount(len(preview) + 1)
        self._combos = []
        options = [NOT_USED] + [COLUMN_LABELS[k] for k in COLUMN_KEYS]
        for col in range(width):
            combo = QComboBox()
            combo.addItems(options)
            key = self.table.mapping.get(col)
            combo.setCurrentText(COLUMN_LABELS[key] if key else NOT_USED)
            combo.currentIndexChanged.connect(self._update_count)
            self.grid.setCellWidget(0, col, combo)
            self._combos.append(combo)
        for r, data_row in enumerate(preview, start=1):
            for c, value in enumerate(data_row):
                item = QTableWidgetItem("" if value is None else str(value))
                if r == 1:
                    font = item.font()
                    font.setBold(True)
                    item.setFont(font)
                self.grid.setItem(r, c, item)
        self.grid.setHorizontalHeaderLabels([f"คอลัมน์ {i + 1}" for i in range(width)])
        self.grid.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.grid.setRowHeight(0, 36)
        self._update_count()

    def _update_count(self) -> None:
        self.count_label.setText(f"{len(self.table.data_rows)} แถวข้อมูล · จับคู่แล้ว {len(self.mapping())} คอลัมน์")

    def mapping(self) -> dict[int, str]:
        label_to_key = {COLUMN_LABELS[k]: k for k in COLUMN_KEYS}
        out, used = {}, set()
        for col, combo in enumerate(self._combos):
            key = label_to_key.get(combo.currentText())
            if key and key not in used:
                out[col] = key
                used.add(key)
        return out

    def accept(self) -> None:
        self.table.mapping = self.mapping()
        super().accept()


# --------------------------------------------------------------------------
CAND_COLUMNS = ["part_no", "drawing_no", "name", "material", "spec", "qty", "unit", "weight", "process", "remark"]
SOURCE_LABEL = {"bom": "ตาราง BOM", "profile": "รูปคลี่", "title": "Title Block", "block": "บล็อกมาตรฐาน"}


class DrawingImportDialog(QDialog):
    """Review what was found in each drawing, tick the rows to add to the Part List."""

    def __init__(self, drawings: list[DrawingData], densities: dict[str, float], parent=None):
        super().__init__(parent)
        self.drawings = drawings
        self.densities = densities
        self.candidates: dict[int, list[CandidatePart]] = {
            i: drawing_to_candidates(d, densities, include_blocks=True) for i, d in enumerate(drawings)}
        self.setWindowTitle("นำเข้าแบบ 2D จาก ZWCAD (DWG/DXF)")
        self.resize(1280, 760)

        lay = QVBoxLayout(self)
        split = QSplitter(Qt.Horizontal)
        lay.addWidget(split, 1)

        self.files = QListWidget()
        self.files.setObjectName("Plain")
        for d in drawings:
            item = QListWidgetItem(d.file_name)
            item.setToolTip(d.source_path or d.path)
            self.files.addItem(item)
        self.files.currentRowChanged.connect(self._show)
        split.addWidget(self.files)

        right = QWidget()
        rlay = QVBoxLayout(right)
        rlay.setContentsMargins(0, 0, 0, 0)
        top = QSplitter(Qt.Horizontal)
        self.preview = DrawingPreview()
        top.addWidget(self.preview)
        info = QWidget()
        grid = QGridLayout(info)
        self.info_labels: dict[str, QLabel] = {}
        for r, (key, label) in enumerate([("drawing_no", "เลขที่แบบ"), ("name", "ชื่อแบบ/ชิ้นงาน"),
                                          ("material", "วัสดุ"), ("thickness", "ความหนา (mm)"),
                                          ("qty", "จำนวน"), ("revision", "Rev."), ("bom", "ตาราง BOM"),
                                          ("profiles", "รูปคลี่ที่พบ"), ("blocks", "บล็อกมาตรฐาน"),
                                          ("warn", "หมายเหตุ")]):
            name = QLabel(label)
            name.setObjectName("Hint")
            value = QLabel("-")
            value.setWordWrap(True)
            value.setTextInteractionFlags(Qt.TextSelectableByMouse)
            grid.addWidget(name, r, 0, Qt.AlignTop)
            grid.addWidget(value, r, 1)
            self.info_labels[key] = value
        grid.setRowStretch(20, 1)
        top.addWidget(info)
        top.setSizes([700, 320])
        rlay.addWidget(top, 3)

        self.tabs = QTabWidget()
        self.table = QTableWidget()
        self.table.setColumnCount(len(CAND_COLUMNS) + 2)
        self.table.setHorizontalHeaderLabels(["เพิ่ม", "ที่มา"] + [COLUMN_LABELS[k] for k in CAND_COLUMNS])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.itemChanged.connect(self._item_changed)
        self.tabs.addTab(self.table, "รายการที่จะเพิ่มเข้า Part List")
        self.attr_table = QTableWidget()
        self.attr_table.setColumnCount(3)
        self.attr_table.setHorizontalHeaderLabels(["บล็อก", "Tag", "ค่า"])
        self.attr_table.horizontalHeader().setStretchLastSection(True)
        self.attr_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tabs.addTab(self.attr_table, "Attribute ใน Title Block")
        rlay.addWidget(self.tabs, 2)

        opts = QHBoxLayout()
        self.update_info = QCheckBox("ใช้ข้อมูล Title Block เติมข้อมูลงาน (เลขที่แบบ, Rev., ลูกค้า, รุ่นรถ) ถ้ายังว่าง")
        self.update_info.setChecked(True)
        opts.addWidget(self.update_info)
        opts.addStretch(1)
        self.summary = QLabel()
        opts.addWidget(self.summary)
        rlay.addLayout(opts)
        split.addWidget(right)
        split.setSizes([230, 1050])

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Ok).setText("เพิ่มเข้า Part List")
        buttons.button(QDialogButtonBox.Ok).setProperty("kind", "primary")
        buttons.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)

        self._current = -1
        self._loading = False
        if drawings:
            self.files.setCurrentRow(0)

    # ---------------------------------------------------------------------
    def _show(self, index: int) -> None:
        self._store_table()
        self._current = index
        if index < 0:
            return
        data = self.drawings[index]
        tb = data.title_block
        self.info_labels["drawing_no"].setText(tb.get("drawing_no", "-"))
        self.info_labels["name"].setText(tb.get("name", "-"))
        self.info_labels["material"].setText(tb.get("material", "-"))
        self.info_labels["thickness"].setText(f"{data.thickness:g}" if data.thickness else "-")
        self.info_labels["qty"].setText(tb.get("qty", "-"))
        self.info_labels["revision"].setText(tb.get("revision", "-"))
        self.info_labels["bom"].setText(
            f"{len(data.bom.data_rows)} แถว ({'ACAD_TABLE' if data.bom_source == 'table' else 'เส้น + ข้อความ'})"
            if data.bom else "ไม่พบ")
        outers = data.outer_profiles
        self.info_labels["profiles"].setText(
            f"{len(outers)} ชิ้น · รู/ช่อง {sum(len(p.holes) for p in outers)}" if outers else "ไม่พบ")
        self.info_labels["blocks"].setText(", ".join(f"{k} ×{v}" for k, v in data.blocks.most_common(6)) or "-")
        self.info_labels["warn"].setText("\n".join(data.warnings) or "-")

        self.attr_table.setRowCount(len(data.attributes))
        for r, (block, tag, value) in enumerate(data.attributes):
            for c, text in enumerate((block, tag, value)):
                self.attr_table.setItem(r, c, QTableWidgetItem(text))

        self._loading = True
        cands = self.candidates[index]
        self.table.setRowCount(len(cands))
        for r, cand in enumerate(cands):
            check = QTableWidgetItem()
            check.setFlags(Qt.ItemIsUserCheckable | Qt.ItemIsEnabled)
            check.setCheckState(Qt.Checked if cand.selected else Qt.Unchecked)
            self.table.setItem(r, 0, check)
            src = QTableWidgetItem(SOURCE_LABEL.get(cand.source, cand.source))
            src.setFlags(Qt.ItemIsEnabled)
            self.table.setItem(r, 1, src)
            for c, key in enumerate(CAND_COLUMNS, start=2):
                value = cand.part.get(key)
                if key in NUMERIC_COLUMNS:
                    text = f"{value:g}" if value or key == "qty" else ""
                else:
                    text = str(value)
                self.table.setItem(r, c, QTableWidgetItem(text))
        self.table.resizeColumnsToContents()
        self._loading = False
        self._refresh_preview()

    def _store_table(self) -> None:
        if self._current < 0:
            return
        for r, cand in enumerate(self.candidates[self._current]):
            if r >= self.table.rowCount():
                break
            cand.selected = self.table.item(r, 0).checkState() == Qt.Checked
            for c, key in enumerate(CAND_COLUMNS, start=2):
                item = self.table.item(r, c)
                if item is not None:
                    cand.part.set(key, item.text())

    def _item_changed(self, item: QTableWidgetItem) -> None:
        if self._loading or item.column() != 0:
            return
        self._store_table()
        self._refresh_preview()

    def _refresh_preview(self) -> None:
        if self._current < 0:
            return
        data = self.drawings[self._current]
        cands = self.candidates[self._current]
        profile_cands = [c for c in cands if c.profile_index is not None]
        selected = {c.profile_index for c in profile_cands if c.selected} if profile_cands else None
        self.preview.show_drawing(data, selected)
        total = sum(1 for cs in self.candidates.values() for c in cs if c.selected)
        self.summary.setText(f"เลือกแล้ว {total} รายการ จาก {len(self.drawings)} แบบ")

    def accept(self) -> None:
        self._store_table()
        super().accept()

    def selected_parts(self) -> list[tuple[DrawingData, list[Part]]]:
        return [(self.drawings[i], [c.part for c in cands if c.selected]) for i, cands in self.candidates.items()]
