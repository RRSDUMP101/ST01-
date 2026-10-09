"""ภาพรวม - job header, KPIs and the work flow from drawing to store."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QGridLayout, QHBoxLayout, QLabel, QLineEdit, QScrollArea, QSpinBox,
                               QVBoxLayout, QWidget)

from ...core.models import STATUSES
from .. import theme
from ..state import AppState
from ..widgets import Card, KpiCard, PageHeader, StatusChipRow, button

INFO_FIELDS = [
    ("so_no", "เลขที่ SO"), ("customer", "ลูกค้า"), ("vehicle_model", "รุ่นรถ"), ("job_type", "แบบงาน"),
    ("drawing_no", "เลขที่แบบหลัก"), ("revision", "Rev."), ("prepared_by", "ผู้จัดทำ"), ("created", "วันที่"),
]

FLOW = [
    ("1", "นำเข้าแบบ 2D", "DWG/DXF จาก ZWCAD → อ่าน Title Block, BOM, รูปคลี่"),
    ("2", "ตรวจ Part List", "แก้ไขวัสดุ จำนวน กระบวนการ ผูกรหัสสโตร์"),
    ("3", "ตรวจวัตถุดิบ", "เทียบสต็อกสโตร์ × จำนวนคัน → รายการขาด"),
    ("4", "ส่งต่อ", "Google Sheet / Excel / ใบขอซื้อ (ร่าง) / ตาราง DXF กลับ ZWCAD"),
]


class DashboardPage(QWidget):
    def __init__(self, state: AppState, actions, navigate, parent=None):
        super().__init__(parent)
        self.state = state
        self.actions = actions
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        body = QWidget()
        body.setObjectName("Content")
        scroll.setWidget(body)
        outer.addWidget(scroll)
        lay = QVBoxLayout(body)
        lay.setContentsMargins(28, 24, 28, 24)
        lay.setSpacing(16)

        header = PageHeader("ภาพรวมงาน", "Part List ของงานผลิต เชื่อมแบบ ZWCAD กับสโตร์ คลังสินค้า และฝ่ายผลิต")
        b = header.add_action(button("นำเข้าแบบ DWG/DXF", "primary"))
        b.clicked.connect(lambda: actions.import_drawings())
        b = header.add_action(button("นำเข้าตาราง BOM"))
        b.clicked.connect(actions.import_table)
        lay.addWidget(header)

        kpis = QHBoxLayout()
        kpis.setSpacing(12)
        self.k_items = KpiCard("รายการชิ้นส่วน")
        self.k_qty = KpiCard("จำนวนชิ้นรวม (ทุกคัน)", accent="#3C8DD9")
        self.k_weight = KpiCard("น้ำหนักรวม (kg, ทุกคัน)", accent="#2E9D5B")
        self.k_drawings = KpiCard("แบบ 2D ในงาน", accent="#7B5BD6")
        self.k_short = KpiCard("วัตถุดิบขาด / ไม่พบ", accent="#D64545")
        for k in (self.k_items, self.k_qty, self.k_weight, self.k_drawings, self.k_short):
            kpis.addWidget(k)
        lay.addLayout(kpis)

        row = QHBoxLayout()
        row.setSpacing(16)
        info_card = Card("ข้อมูลงาน (หัว Part List)")
        form_grid = QGridLayout()
        form_grid.setHorizontalSpacing(10)
        form_grid.setVerticalSpacing(10)
        form_grid.setColumnStretch(1, 1)
        form_grid.setColumnStretch(3, 1)
        form_grid.setColumnMinimumWidth(2, 90)
        self.inputs: dict[str, QLineEdit] = {}
        for i, (key, label) in enumerate(INFO_FIELDS):
            edit = QLineEdit()
            edit.setPlaceholderText(label)
            edit.editingFinished.connect(lambda k=key, e=edit: self._info_edited(k, e.text()))
            self.inputs[key] = edit
            r, c = divmod(i, 2)
            form_grid.addWidget(QLabel(label), r, c * 2)
            form_grid.addWidget(edit, r, c * 2 + 1)
        self.build_qty = QSpinBox()
        self.build_qty.setRange(1, 9999)
        self.build_qty.setSuffix(" คัน")
        self.build_qty.setButtonSymbols(QSpinBox.NoButtons)
        self.build_qty.valueChanged.connect(self._build_changed)
        form_grid.addWidget(QLabel("จำนวนผลิต"), 4, 0)
        form_grid.addWidget(self.build_qty, 4, 1)
        info_card.body.addLayout(form_grid)
        info_card.body.addStretch(1)
        row.addWidget(info_card, 3)

        side = QVBoxLayout()
        status_card = Card("สถานะความพร้อมของชิ้นส่วน")
        self.chips = StatusChipRow(STATUSES)
        status_card.body.addLayout(self.chips)
        self.issue_label = QLabel()
        self.issue_label.setObjectName("Hint")
        self.issue_label.setWordWrap(True)
        status_card.body.addWidget(self.issue_label)
        side.addWidget(status_card)

        flow_card = Card("ขั้นตอนงาน: แบบ → Part List → สโตร์ → ผลิต")
        targets = ["drawings", "parts", "stock", "sheets"]
        for (num, title, desc), target in zip(FLOW, targets):
            line = QHBoxLayout()
            badge = QLabel(num)
            badge.setAlignment(Qt.AlignCenter)
            badge.setFixedSize(26, 26)
            badge.setStyleSheet(f"background:{theme.NAVY}; color:white; border-radius:13px; font-weight:700;")
            line.addWidget(badge)
            text = QLabel(f"<b>{title}</b><br><span style='color:{theme.MUTED}'>{desc}</span>")
            text.setWordWrap(True)
            line.addWidget(text, 1)
            go = button("ไป ›")
            go.setFixedWidth(56)
            go.clicked.connect(lambda _=False, t=target: navigate(t))
            line.addWidget(go)
            flow_card.body.addLayout(line)
        side.addWidget(flow_card)
        side.addStretch(1)
        row.addLayout(side, 2)
        lay.addLayout(row)
        lay.addStretch(1)

        state.partlist_changed.connect(self.refresh)
        state.requirements_changed.connect(self.refresh)
        self.refresh()

    def _info_edited(self, key: str, value: str) -> None:
        info = self.state.partlist.info
        if getattr(info, key) != value.strip():
            setattr(info, key, value.strip())
            self.state.mark_dirty()

    def _build_changed(self, value: int) -> None:
        if self.state.partlist.info.build_qty != value:
            self.state.partlist.info.build_qty = value
            self.state.mark_dirty()

    def refresh(self) -> None:
        pl = self.state.partlist
        for key, edit in self.inputs.items():
            if not edit.hasFocus():
                edit.setText(getattr(pl.info, key))
        self.build_qty.blockSignals(True)
        self.build_qty.setValue(max(1, pl.info.build_qty))
        self.build_qty.blockSignals(False)
        build = max(1, pl.info.build_qty)
        self.k_items.set_value(f"{len(pl.parts):,}")
        self.k_qty.set_value(f"{pl.total_qty * build:,.0f}")
        self.k_weight.set_value(f"{pl.total_weight * build:,.1f}")
        self.k_drawings.set_value(f"{len(pl.drawings):,}")
        req = self.state.requirements
        self.k_short.set_value(f"{sum(1 for r in req if r.status in ('ขาด', 'ไม่พบในสต็อก'))}" if req else "–")

        self.chips.set_counts(pl.status_counts())
        missing_mat = sum(1 for p in pl.parts if not p.material)
        no_stock = sum(1 for p in pl.parts if not p.stock_code)
        hints = []
        if not pl.parts:
            hints.append("ยังไม่มีรายการ – เริ่มจากนำเข้าแบบ DWG/DXF หรือ ตาราง BOM จาก ZWCAD")
        if missing_mat:
            hints.append(f"ยังไม่ระบุวัสดุ {missing_mat} รายการ")
        if pl.parts and no_stock:
            hints.append(f"ยังไม่ผูกรหัสสโตร์ {no_stock} รายการ (ระบบจะจับคู่จากวัสดุ+ความหนาให้ตอนตรวจวัตถุดิบ)")
        if not req and pl.parts:
            hints.append("ยังไม่ได้ตรวจวัตถุดิบเทียบสต็อก")
        self.issue_label.setText("\n".join(f"• {h}" for h in hints) or "• ข้อมูลครบ พร้อมส่งต่อ")
