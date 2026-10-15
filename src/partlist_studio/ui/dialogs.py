"""Import dialogs: column mapping for tables, review of parts found in DWG/DXF drawings."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (QAbstractItemView, QCheckBox, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox,
                               QGridLayout, QHBoxLayout, QHeaderView, QLabel, QListWidget, QListWidgetItem, QSpinBox,
                               QSplitter, QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from ..core.dwg_io import (QTY_DEFAULT, QTY_MANUAL, THICKNESS_MODES, THK_DEFAULT, THK_FROM_BOM, THK_FROM_PART,
                           THK_MANUAL, THK_MISSING, CandidatePart, DrawingData, drawing_to_candidates,
                           resolve_thickness, set_part_thickness)
from ..core.models import COLUMN_KEYS, COLUMN_LABELS, COMMON_THICKNESS, NUMERIC_COLUMNS, Part, to_number
from ..core.mapping import auto_map
from ..core.partlist_io import TableImport
from . import theme
from .widgets import DrawingPreview, button

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
CAND_COLUMNS = ["part_no", "drawing_no", "name", "material", "spec", "thickness", "qty", "unit", "weight", "process",
                "remark"]
SOURCE_LABEL = {"bom": "ตาราง BOM", "profile": "รูปคลี่", "title": "Title Block", "block": "บล็อกมาตรฐาน"}
THK_SOURCE_COL = "_thk_source"
QTY_SOURCE_COL = "_qty_source"


def qty_color(source: str) -> QColor | None:
    return theme.WARN_BG if source in (QTY_DEFAULT, QTY_MANUAL) else None


def thickness_color(source: str) -> QColor | None:
    if source == THK_MISSING:
        return theme.ERROR_BG
    if source in (THK_DEFAULT, THK_MANUAL):
        return theme.WARN_BG
    return None


class DrawingImportDialog(QDialog):
    """Review what was found in each drawing, tick the rows to add to the Part List.
    Code, name, thickness and quantity come from the labels of each flat pattern; the thickness can be set here."""

    def __init__(self, drawings: list[DrawingData], densities: dict[str, float], parent=None,
                 default_thickness: float = 0, thickness_mode: str = "drawing"):
        super().__init__(parent)
        self.drawings = drawings
        self.densities = densities
        self.candidates: dict[int, list[CandidatePart]] = {
            i: drawing_to_candidates(d, densities, include_blocks=True, default_thickness=default_thickness,
                                     thickness_mode=thickness_mode) for i, d in enumerate(drawings)}
        self._manual: set[int] = set()  # id() of candidates whose thickness was set row by row
        self.setWindowTitle("นำเข้าแบบ 2D จาก ZWCAD (DWG/DXF)")
        self.resize(1320, 800)

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
                                          ("labels", "ป้ายที่ชิ้นงาน"), ("qty", "จำนวน"), ("revision", "Rev."),
                                          ("bom", "ตาราง BOM"), ("profiles", "รูปคลี่ที่พบ"),
                                          ("open", "เส้นไม่ปิดเป็นวง"), ("blocks", "บล็อกมาตรฐาน"),
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
        top.setSizes([700, 340])
        rlay.addWidget(top, 3)

        # ---- thickness: as drawn, a default for parts without one, or one value for every part
        thk = QHBoxLayout()
        thk.addWidget(QLabel("<b>ความหนา</b>"))
        self.thk_mode = QComboBox()
        for key, label in THICKNESS_MODES.items():
            self.thk_mode.addItem(label, key)
        self.thk_mode.setCurrentIndex(max(0, self.thk_mode.findData(thickness_mode)))
        self.thk_mode.setToolTip("ตามแบบ: ใช้ค่าที่เขียนไว้ที่ชิ้นงาน (t3, Thickness=3.00, หนา 3 มิล, Attribute THK) "
                                 "ถ้าไม่มีใช้ THK ใน Title Block แล้วจึงใช้ค่าเริ่มต้น\n"
                                 "กำหนดเองทุกชิ้น: ใช้ค่าที่ตั้งกับทุกชิ้นที่เป็นแผ่น")
        thk.addWidget(self.thk_mode)
        self.thk_label = QLabel()
        thk.addWidget(self.thk_label)
        self.thk_value = QDoubleSpinBox()
        self.thk_value.setRange(0, 100)
        self.thk_value.setDecimals(2)
        self.thk_value.setSingleStep(0.1)
        self.thk_value.setSuffix(" mm")
        self.thk_value.setSpecialValueText("ไม่กำหนด")
        self.thk_value.setValue(default_thickness)
        self.thk_value.setMinimumWidth(110)
        thk.addWidget(self.thk_value)
        self.thk_common = QComboBox()
        self.thk_common.addItem("ค่าที่ใช้บ่อย…", 0.0)
        for v in COMMON_THICKNESS:
            self.thk_common.addItem(f"{v:g} mm", v)
        self.thk_common.activated.connect(self._common_picked)
        thk.addWidget(self.thk_common)
        self.apply_btn = button("ใช้กับแถวที่เลือก", tooltip="ตั้งความหนาของแถวที่เลือก (คลิก/Shift/Ctrl เลือกหลายแถว) "
                                                            "แล้วคำนวณขนาดและน้ำหนักใหม่")
        self.apply_btn.clicked.connect(self._apply_selected)
        thk.addWidget(self.apply_btn)
        self.reset_btn = button("คืนค่าตามแบบ", tooltip="แถวที่เลือก (หรือทั้งแบบนี้ถ้าไม่ได้เลือก) กลับไปใช้ความหนาที่อ่านจากแบบ")
        self.reset_btn.clicked.connect(self._reset_selected)
        thk.addWidget(self.reset_btn)
        thk.addStretch(1)
        rlay.addLayout(thk)
        self.thk_mode.currentIndexChanged.connect(self._thickness_rule_changed)
        self.thk_value.valueChanged.connect(self._thickness_rule_changed)

        self.tabs = QTabWidget()
        self.columns = ["_check", "_source"] + CAND_COLUMNS
        self.columns.insert(self.columns.index("thickness") + 1, THK_SOURCE_COL)
        self.columns.insert(self.columns.index("qty") + 1, QTY_SOURCE_COL)
        labels = {"_check": "เพิ่ม", "_source": "ที่มา", THK_SOURCE_COL: "ความหนาจาก", QTY_SOURCE_COL: "จำนวนจาก"}
        self.table = QTableWidget()
        self.table.setColumnCount(len(self.columns))
        self.table.setHorizontalHeaderLabels([labels.get(k) or COLUMN_LABELS[k] for k in self.columns])
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
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
        split.setSizes([230, 1090])

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Ok).setText("เพิ่มเข้า Part List")
        buttons.button(QDialogButtonBox.Ok).setProperty("kind", "primary")
        buttons.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)

        self._current = -1
        self._loading = False
        self._update_thk_label()
        if drawings:
            self.files.setCurrentRow(0)

    # ---------------------------------------------------------------------
    @property
    def thickness_mode(self) -> str:
        return self.thk_mode.currentData()

    @property
    def default_thickness(self) -> float:
        return round(self.thk_value.value(), 3)

    def _col(self, key: str) -> int:
        return self.columns.index(key)

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
        self.info_labels["thickness"].setText(f"{data.thickness:g} (Title Block)" if data.thickness
                                              else "Title Block ไม่ระบุ")
        outers = data.outer_profiles
        labelled = [p for p in outers if p.info]
        self.info_labels["labels"].setText(
            f"รหัส {sum(1 for p in outers if p.info.get('part_no'))} · ชื่อ "
            f"{sum(1 for p in outers if p.info.get('name') or p.info.get('label_name'))} · ความหนา "
            f"{sum(1 for p in outers if p.info.get('thickness'))} · จำนวน "
            f"{sum(1 for p in outers if p.info.get('qty'))} จาก {len(outers)} ชิ้น" if labelled else
            ("ไม่พบ (เขียน รหัส / ชื่อ / t3 / 16 ชิ้น ไว้ใน หรือติดกับรูปคลี่แต่ละชิ้น)" if outers else "-"))
        self.info_labels["qty"].setText(self._qty_info(data))
        self.info_labels["revision"].setText(tb.get("revision", "-"))
        self.info_labels["bom"].setText(
            f"{len(data.bom.data_rows)} แถว ({'ACAD_TABLE' if data.bom_source == 'table' else 'เส้น + ข้อความ'})"
            if data.bom else "ไม่พบ")
        self.info_labels["profiles"].setText(
            f"{len(outers)} ชิ้น · รู/ช่อง {sum(len(p.holes) for p in outers)}" if outers else "ไม่พบ")
        self.info_labels["open"].setText(
            f"{data.open_chains} เส้น – วงกลมแดงในภาพ (เส้นตัดต่อไม่สนิท หรือเส้นพับ/เส้นช่วย: ย้ายไปเลเยอร์อื่น) "
            "เลเซอร์ตัดเส้นเหล่านี้เป็นชิ้นงานไม่ได้" if data.open_chains else "ไม่มี")
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
            src.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
            self.table.setItem(r, 1, src)
            self._fill_row(r, cand)
        self.table.resizeColumnsToContents()
        self.table.setColumnWidth(self._col("name"), max(self.table.columnWidth(self._col("name")), 160))
        self._loading = False
        self._refresh_preview()

    @staticmethod
    def _qty_info(data: DrawingData) -> str:
        bits = [f"Title Block {data.title_block['qty']}"] if data.title_block.get("qty") else []
        if data.note_qty:
            outers = len(data.outer_profiles)
            used = data.note_qty_each or outers <= 1
            bits.append(f"หมายเหตุ “{data.note_qty_text}” → " + (
                ("ทุกชิ้นที่ไม่มีจำนวนของตัวเอง" if outers > 1 else "ชิ้นนี้") if used else
                "ไม่ได้อยู่ติดชิ้นใด แบบนี้มีหลายชิ้นจึงไม่ได้ใช้ (ถ้าเป็นของทุกชิ้น ให้เขียน “อย่างละ …” หรือแก้ในคอลัมน์จำนวน)"))
        return " · ".join(bits) or "-"

    def _fill_row(self, r: int, cand: CandidatePart) -> None:
        loading, self._loading = self._loading, True
        for key in CAND_COLUMNS:
            value = cand.part.get(key)
            if key in NUMERIC_COLUMNS:
                text = f"{value:g}" if value or key == "qty" else ""
            else:
                text = str(value)
            item = QTableWidgetItem(text)
            if key == "thickness":
                item.setToolTip("พิมพ์ค่าใหม่ได้ (mm) – ขนาดและน้ำหนักจะคำนวณใหม่")
            self.table.setItem(r, self._col(key), item)
        src = QTableWidgetItem(cand.thickness_source)
        src.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
        color = thickness_color(cand.thickness_source)
        for c in (self._col("thickness"), self._col(THK_SOURCE_COL)):
            cell = src if c == self._col(THK_SOURCE_COL) else self.table.item(r, c)
            if color is not None:
                cell.setBackground(color)
        if cand.thickness_source == THK_MISSING:
            src.setToolTip("แบบไม่ระบุความหนา – พิมพ์ค่าในช่อง หนา (mm) หรือตั้งค่าเริ่มต้นด้านบน")
        elif cand.part.drawing_thickness and cand.part.drawing_thickness != cand.part.thickness:
            src.setToolTip(f"ในแบบเขียนไว้ {cand.part.drawing_thickness:g} mm")
        self.table.setItem(r, self._col(THK_SOURCE_COL), src)
        qsrc = QTableWidgetItem(cand.qty_source)
        qsrc.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
        if cand.qty_text:
            qsrc.setToolTip(f"อ่านจากข้อความ “{cand.qty_text}”")
        elif cand.qty_source == QTY_DEFAULT:
            qsrc.setToolTip("แบบไม่ได้เขียนจำนวนของชิ้นนี้ (เช่น 16 ชิ้น) – ตรวจ/พิมพ์จำนวนในช่อง จำนวน")
        elif cand.qty_source == QTY_MANUAL and cand.part.drawing_qty:
            qsrc.setToolTip(f"ในแบบเขียนไว้ {cand.part.drawing_qty:g}")
        color = qty_color(cand.qty_source)
        if color is not None:
            qsrc.setBackground(color)
            self.table.item(r, self._col("qty")).setBackground(color)
        self.table.setItem(r, self._col(QTY_SOURCE_COL), qsrc)
        self._loading = loading

    def _store_row(self, r: int, cand: CandidatePart, skip: str = "") -> None:
        cand.selected = self.table.item(r, 0).checkState() == Qt.Checked
        for key in CAND_COLUMNS:
            item = self.table.item(r, self._col(key)) if key != skip else None
            if item is not None:
                cand.part.set(key, item.text())

    def _store_table(self) -> None:
        if self._current < 0:
            return
        for r, cand in enumerate(self.candidates[self._current]):
            if r >= self.table.rowCount():
                break
            self._store_row(r, cand)

    def _item_changed(self, item: QTableWidgetItem) -> None:
        if self._loading or self._current < 0:
            return
        col, r = item.column(), item.row()
        if col == 0:
            self._store_table()
            self._refresh_preview()
            return
        cand = self.candidates[self._current][r]
        if col == self._col("thickness"):
            self._store_row(r, cand, skip="thickness")  # the old value scales the weight of a BOM row
            self._set_thickness(cand, to_number(item.text()), THK_MANUAL)
            self._fill_row(r, cand)
            self._refresh_preview()
        elif col == self._col("qty"):
            self._store_row(r, cand)
            if cand.part.qty != (cand.part.drawing_qty or 1) or cand.qty_source == QTY_MANUAL:
                cand.qty_source, cand.qty_text = QTY_MANUAL, ""
                cand.part.qty_source = QTY_MANUAL + (f" (ในแบบ {cand.part.drawing_qty:g})"
                                                     if cand.part.drawing_qty else "")
            self._fill_row(r, cand)
        elif col == self._col("material") and cand.part.thickness:
            self._store_row(r, cand)
            set_part_thickness(cand.part, cand.part.thickness, self.densities)  # weigh with the new density
            self._fill_row(r, cand)

    # ---- thickness ---------------------------------------------------------
    def _plate(self, cand: CandidatePart) -> bool:
        return cand.source in ("profile", "title") or (cand.source == "bom" and bool(cand.thickness_source))

    def _own_thickness(self, index: int, cand: CandidatePart) -> tuple[float, float]:
        """(thickness written on the part / in its BOM row, thickness of the title block)."""
        data = self.drawings[index]
        if cand.source == "profile":
            return to_number(data.profiles[cand.profile_index].info.get("thickness", 0)), data.thickness
        if cand.source == "bom":
            return cand.part.drawing_thickness, 0
        return 0, data.thickness

    def _set_thickness(self, cand: CandidatePart, value: float, source: str) -> None:
        set_part_thickness(cand.part, value, self.densities)
        cand.thickness_source = source if value else THK_MISSING
        self._manual.add(id(cand))

    def _resolve(self, index: int, cand: CandidatePart, mode: str) -> None:
        own, drawing = self._own_thickness(index, cand)
        value, source = resolve_thickness(own, drawing, self.default_thickness, mode)
        if cand.source == "bom" and source == THK_FROM_PART:
            source = THK_FROM_BOM
        set_part_thickness(cand.part, value, self.densities)
        cand.thickness_source = source

    def _thickness_rule_changed(self, *_args) -> None:
        self._update_thk_label()
        self._store_table()
        for index, cands in self.candidates.items():
            for cand in cands:
                if self._plate(cand) and id(cand) not in self._manual:
                    self._resolve(index, cand, self.thickness_mode)
        self._reload_rows()

    def _update_thk_label(self) -> None:
        fixed = self.thickness_mode == "fixed"
        self.thk_label.setText("ความหนาทุกชิ้น" if fixed else "ค่าเริ่มต้น (แบบไม่ระบุ)")

    def _common_picked(self, index: int) -> None:
        value = self.thk_common.itemData(index)
        if value:
            self.thk_value.setValue(value)
        self.thk_common.setCurrentIndex(0)

    def _rows(self, all_if_none: bool) -> list[int]:
        rows = sorted({i.row() for i in self.table.selectedIndexes()})
        if not rows and all_if_none:
            rows = list(range(self.table.rowCount()))
        return rows

    def _apply_selected(self) -> None:
        if self._current < 0:
            return
        self._store_table()
        cands = self.candidates[self._current]
        for r in self._rows(all_if_none=False):
            if cands[r].source != "block":
                self._set_thickness(cands[r], self.default_thickness, THK_MANUAL)
        self._reload_rows()

    def _reset_selected(self) -> None:
        if self._current < 0:
            return
        self._store_table()
        cands = self.candidates[self._current]
        for r in self._rows(all_if_none=True):
            cand = cands[r]
            if self._plate(cand):
                self._resolve(self._current, cand, "drawing")
                self._manual.add(id(cand))  # stays as drawn even when the rule says one value for all
        self._reload_rows()

    def _reload_rows(self) -> None:
        if self._current < 0:
            return
        for r, cand in enumerate(self.candidates[self._current]):
            if r < self.table.rowCount():
                self._fill_row(r, cand)
        self._refresh_preview()

    def _refresh_preview(self) -> None:
        if self._current < 0:
            return
        data = self.drawings[self._current]
        cands = self.candidates[self._current]
        profile_cands = [c for c in cands if c.profile_index is not None]
        selected = {c.profile_index for c in profile_cands if c.selected} if profile_cands else None
        self.preview.show_drawing(data, selected)
        chosen = [c for cs in self.candidates.values() for c in cs if c.selected]
        missing = sum(1 for c in chosen if c.thickness_source == THK_MISSING)
        text = f"เลือกแล้ว {len(chosen)} รายการ จาก {len(self.drawings)} แบบ"
        if missing:
            text += f"  ·  ⚠ ยังไม่มีความหนา {missing} รายการ"
        self.summary.setText(text)

    def accept(self) -> None:
        self._store_table()
        super().accept()

    def selected_parts(self) -> list[tuple[DrawingData, list[Part]]]:
        return [(self.drawings[i], [c.part for c in cands if c.selected]) for i, cands in self.candidates.items()]
