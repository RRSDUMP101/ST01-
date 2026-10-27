"""Tab of สโตร์ / คลังสินค้า: made parts waiting for assembly (ชิ้นส่วนพร้อมประกอบ) by assembly group,
with the six numbers of every code, the shelf location and the shelf labels."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ...core.catalog import (
    BRANDS,
    GROUP_NAMES,
    GROUP_ORDER,
    NO_GROUP,
    PART_STOCK_HEADERS,
    PartStock,
    export_part_stock,
    group_name,
    part_stock,
    part_stock_rows,
    shelf_labels,
)
from ...core.qr import PREFIX, parse_payload
from ..state import AppState
from ..widgets import StatusChipRow, button, empty_hint, fill, selected_rows, table

COL_LOCATION = PART_STOCK_HEADERS.index("ตำแหน่ง")
COL_STATUS = PART_STOCK_HEADERS.index("สถานะ")
STATES = ["ขาด", "ต่ำกว่า Min", "ระหว่างผลิต", "พอ"]
ALL = "*"
AUTO = "อัตโนมัติ (ตามชื่อ / รหัสสโตร์)"


class PartsReadyTab(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.rows: list[PartStock] = []
        self.shown: list[PartStock] = []
        self._stale = True
        self._own_edit = False  # a location typed in the table: the table already shows it
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 12, 12, 12)
        top = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("ค้นหา รหัส / ชื่อ / ตำแหน่ง / งาน – หรือสแกน QR ป้ายชั้นวาง / ใบงาน")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self._filter)
        top.addWidget(self.search, 1)
        self.brand = QComboBox()
        self.brand.addItem("ทุกรุ่นรถ", "")
        for name in dict.fromkeys(BRANDS.values()):
            self.brand.addItem(name, name)
        self.brand.currentIndexChanged.connect(self._filter)
        top.addWidget(self.brand)
        self.only_jobs = QCheckBox("เฉพาะที่งานเปิดต้องใช้")
        self.only_jobs.toggled.connect(self._filter)
        top.addWidget(self.only_jobs)
        self.chips = StatusChipRow(STATES, hide_zero=True)
        top.addLayout(self.chips)
        lay.addLayout(top)

        split = QSplitter(Qt.Horizontal)
        self.groups = QListWidget()
        self.groups.setObjectName("Plain")
        self.groups.setSpacing(3)
        self.groups.currentRowChanged.connect(self._filter)
        split.addWidget(self.groups)
        self.table = table(PART_STOCK_HEADERS, [150, 150, 200, 45, 90, 95, 75, 60, 140, 55, 115, 50, 45, 45, 90],
                           editable=True)
        empty_hint(self.table, lambda: "ไม่พบรายการที่ตรงกับการค้นหา / ตัวกรอง" if self.search.text().strip() else
                   "ยังไม่มีชิ้นส่วน – นำเข้าสต็อก หรือเปิดงานผลิต แล้วชิ้นส่วนจะแยกกลุ่มประกอบให้ที่นี่")
        self.table.itemChanged.connect(self._edited)
        split.addWidget(self.table)
        split.setSizes([230, 1050])
        lay.addWidget(split, 1)

        row = QHBoxLayout()
        hint = QLabel("ใช้ได้ = พร้อมประกอบ − จองให้งาน · ขาด = ต้องใช้ − จะได้ − พร้อมประกอบ · "
                      "ดับเบิลคลิกช่อง ตำแหน่ง เพื่อแก้ · กลุ่มจัดอัตโนมัติจากชื่อ ตั้งเองได้")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        row.addWidget(hint, 1)
        for text, slot, kind, tip in (
                ("ตั้งกลุ่มประกอบ…", self.set_group, "", "เลือกกลุ่มประกอบให้รหัสที่เลือก (แทนกลุ่มที่จัดจากชื่อ)"),
                ("ตั้งตำแหน่งเก็บ…", self.set_location, "", "ตั้งตำแหน่งชั้นวางให้รหัสที่เลือก เช่น P-A-01"),
                ("พิมพ์ป้ายชั้นวาง (QR)…", self.print_labels, "accent", "ป้ายติดชั้นวางพร้อม QR ของรหัสที่เลือก"),
                ("ส่งออก Excel…", self.export, "", "ตารางชิ้นส่วนพร้อมประกอบเป็น Excel")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)

        for signal in (state.stock_changed, state.jobs_changed, state.catalog_changed):
            signal.connect(self._changed)

    # ---------------------------------------------------------------------
    def showEvent(self, event):
        super().showEvent(event)
        if self._stale:
            self.refresh()

    def _changed(self) -> None:
        if self._own_edit:
            return
        self._stale = True
        if self.isVisible():
            self.refresh()

    def refresh(self) -> None:
        self._stale = False
        self.rows = part_stock(self.state.stock, self.state.jobs, self.state.catalog)
        current = self.groups.currentItem().data(Qt.UserRole) if self.groups.currentItem() else ALL
        counts: dict[str, list[int]] = {}
        for r in self.rows:
            c = counts.setdefault(r.group, [0, 0])
            c[0] += 1
            c[1] += r.short > 0
        self.groups.blockSignals(True)
        self.groups.clear()
        short = sum(c[1] for c in counts.values())
        entries = [(ALL, "ทุกกลุ่ม", len(self.rows), short)]
        entries += [(g, group_name(g), counts[g][0], counts[g][1]) for g in GROUP_ORDER + [NO_GROUP] if g in counts]
        for key, name, n, miss in entries:
            item = QListWidgetItem(f"{name}\n{n} รหัส" + (f" · ขาด {miss}" if miss else ""))
            item.setData(Qt.UserRole, key)
            self.groups.addItem(item)
        keys = [e[0] for e in entries]
        self.groups.setCurrentRow(keys.index(current) if current in keys else 0)
        self.groups.blockSignals(False)
        self._filter()

    def _needle(self) -> str:
        text = self.search.text().strip()
        if text.upper().startswith(PREFIX + "|"):  # scanned QR of a shelf label or a ticket
            return parse_payload(text).code.lower()
        return text.lower()

    def _filter(self, *_args) -> None:
        item = self.groups.currentItem()
        group = item.data(Qt.UserRole) if item else ALL
        needle, brand = self._needle(), self.brand.currentData()
        rows = []
        for r in self.rows:
            if group != ALL and r.group != group:
                continue
            if brand and r.brand != brand:
                continue
            if self.only_jobs.isChecked() and not r.need:
                continue
            if needle and needle not in " ".join((r.code, r.name, r.location, " ".join(r.jobs))).lower():
                continue
            rows.append(r)
        self.shown = rows
        fill(self.table, part_stock_rows(rows), status_col=COL_STATUS)
        self.table.blockSignals(True)
        for r in range(self.table.rowCount()):
            for c in range(self.table.columnCount()):
                cell = self.table.item(r, c)
                if c != COL_LOCATION:
                    cell.setFlags(cell.flags() & ~Qt.ItemIsEditable)
        self.table.blockSignals(False)
        counts: dict[str, int] = {}
        for r in rows:
            counts[r.status] = counts.get(r.status, 0) + 1
        self.chips.set_counts(counts)

    def _selected(self) -> list[PartStock]:
        return [self.shown[r] for r in selected_rows(self.table) if r < len(self.shown)]

    # ---------------------------------------------------------------------
    def _edited(self, cell) -> None:
        if cell.column() != COL_LOCATION or cell.row() >= len(self.shown):
            return
        row = self.shown[cell.row()]
        self.state.catalog.set_location(row.code, cell.text())
        row.location = cell.text().strip()
        self._own_edit = True  # keep the table (and the cell being typed in) as it is
        try:
            self.state.save_catalog()
        finally:
            self._own_edit = False

    def set_group(self) -> None:
        rows = self._selected()
        if not rows:
            self.actions.error("ยังไม่ได้เลือก", "เลือกแถวของรหัสที่จะตั้งกลุ่มก่อน")
            return
        labels = [AUTO] + [f"{g} – {GROUP_NAMES[g]}" for g in GROUP_ORDER]
        current = labels.index(f"{rows[0].group} – {GROUP_NAMES[rows[0].group]}") if rows[0].group in GROUP_NAMES else 0
        text, ok = QInputDialog.getItem(self, "ตั้งกลุ่มประกอบ", f"{len(rows)} รหัสที่เลือก → กลุ่มประกอบ:", labels,
                                        current, False)
        if not ok:
            return
        group = None if text == AUTO else text.split(" – ")[0]
        for r in rows:
            self.state.catalog.set_group(r.code, group)
        self.state.save_catalog()
        self.state.notify(f"ตั้งกลุ่ม {len(rows)} รหัส → {group_name(group) if group else 'อัตโนมัติ'}")

    def set_location(self) -> None:
        rows = self._selected()
        if not rows:
            self.actions.error("ยังไม่ได้เลือก", "เลือกแถวของรหัสที่จะตั้งตำแหน่งเก็บก่อน")
            return
        text, ok = QInputDialog.getText(self, "ตั้งตำแหน่งเก็บ",
                                        f"{len(rows)} รหัสที่เลือก → ตำแหน่ง เช่น P-POST-04 (ว่าง = ลบ):",
                                        text=rows[0].location)
        if not ok:
            return
        for r in rows:
            self.state.catalog.set_location(r.code, text)
        self.state.save_catalog()
        self.state.notify(f"ตั้งตำแหน่ง {len(rows)} รหัส → {text.strip() or '(ลบ)'}")

    def print_labels(self) -> None:
        rows = self._selected() or self.shown
        if not rows:
            self.actions.error("ไม่มีรายการ", "ไม่มีรหัสในรายการที่แสดงอยู่")
            return
        path = self.actions.save_path("ป้ายชั้นวาง (PDF)", "ป้ายชั้นวาง.pdf", "PDF (*.pdf)")
        if not path:
            return
        from ..printing import open_document, write_labels_pdf

        n = write_labels_pdf(path, shelf_labels(rows))
        self.state.notify(f"บันทึก {Path(path).name} แล้ว ({n} ป้าย · A4 3 × 8 ดวง)")
        open_document(path)

    def export(self) -> None:
        rows = self.shown or self.rows
        path = self.actions.save_path("ชิ้นส่วนพร้อมประกอบ", "ชิ้นส่วนพร้อมประกอบ_แยกกลุ่ม.xlsx", "Excel (*.xlsx)")
        if path:
            export_part_stock(rows, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({len(rows)} รหัส)")
