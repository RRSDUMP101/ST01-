"""Tab of สโตร์ / คลังสินค้า: Min / Max from real usage and the reorder warning."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtWidgets import QComboBox, QDoubleSpinBox, QHBoxLayout, QLabel, QSpinBox, QVBoxLayout, QWidget

from ...core.production import reserved_by_jobs
from ...core.replenish import (REPLENISH_HEADERS, RS_NEAR, RS_ORDER, RS_ORDER_STATES, ReplenishParams, apply_min_max,
                               compute, export_replenish, replenish_row)
from ..state import AppState
from ..widgets import StatusChipRow, button, fill, table


class ReplenishTab(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.lines = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 12, 12, 12)
        p = state.settings.replenish
        row = QHBoxLayout()
        self.lead = self._spin(p.lead_days, " วัน")
        self.review = self._spin(p.review_days, " วัน")
        self.service = QComboBox()
        for v in (0.90, 0.95, 0.98, 0.99):
            self.service.addItem(f"{v:.0%}", v)
        self.service.setCurrentIndex([0.90, 0.95, 0.98, 0.99].index(p.service) if p.service in (0.9, 0.95, 0.98, 0.99) else 1)
        self.history = QSpinBox()
        self.history.setRange(7, 730)
        self.history.setValue(p.history_days)
        self.history.setSuffix(" วัน")
        self.beds = self._spin(p.default_beds, " คัน")
        self.batch = self._spin(p.batch_beds, " คัน")
        for label, w in (("ระยะเวลาสั่งของ", self.lead), ("รอบสั่ง", self.review), ("ระดับบริการ", self.service),
                         ("ข้อมูลย้อนหลัง", self.history), ("ไม่มีประวัติ: Min สำรอง", self.beds),
                         ("+ สั่งเพิ่ม", self.batch)):
            row.addWidget(QLabel(label))
            row.addWidget(w)
        row.addStretch(1)
        lay.addLayout(row)
        row = QHBoxLayout()
        run = button("คำนวณ Min / Max", "accent")
        run.clicked.connect(self.run)
        row.addWidget(run)
        self.chips = StatusChipRow(list(RS_ORDER_STATES), hide_zero=True)
        row.addLayout(self.chips)
        lay.addLayout(row)
        self.hint = QLabel("ยอดใช้จริง = ใบเบิก PD/OU ในโปรแกรม + ช่อง จ่ายออก รายวันของแท็บ สต๊อกเหล็ก · "
                           "ไม่มีประวัติ = ค่าเริ่มต้นจากแบบกระบะ (จำนวนต่อคัน × คันสำรอง) · จองให้งาน = ชิ้นส่วนจากสต็อกที่งานผลิตเปิดอยู่จองไว้")
        self.hint.setObjectName("Hint")
        self.hint.setWordWrap(True)
        lay.addWidget(self.hint)
        self.table = table(REPLENISH_HEADERS, [130, 240, 50, 70, 70, 70, 80, 70, 60, 60, 70, 70, 140, 140])
        lay.addWidget(self.table, 1)
        row = QHBoxLayout()
        row.addStretch(1)
        for text, slot, kind in (("ใช้ Min / Max ที่แนะนำ", self.apply, ""), ("ส่งออก Min/Max (Excel)", lambda: self.export(False), ""),
                                 ("ใบขอซื้อ (ร่าง) ตามจุดสั่งซื้อ", lambda: self.export(True), "primary")):
            b = button(text, kind) if kind else button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)

    @staticmethod
    def _spin(value: float, suffix: str) -> QDoubleSpinBox:
        s = QDoubleSpinBox()
        s.setRange(0, 999)
        s.setDecimals(0)
        s.setValue(value)
        s.setSuffix(suffix)
        return s

    def params(self) -> ReplenishParams:
        p = ReplenishParams(self.lead.value(), self.review.value(), self.service.currentData(), self.history.value(),
                            self.beds.value(), self.batch.value())
        self.state.settings.replenish = p
        return p

    def run(self) -> None:
        params = self.params()
        self.lines = compute(self.state.stock, params, self.state.ledger.daily_out(),
                             reserved_by_jobs(self.state.jobs), self.state.models)
        fill(self.table, [replenish_row(x) for x in self.lines], status_col=13)
        counts = {}
        for x in self.lines:
            counts[x.status] = counts.get(x.status, 0) + 1
        self.chips.set_counts(counts)
        n = counts.get(RS_ORDER, 0)
        self.state.notify(f"Min/Max {len(self.lines)} รายการ · ต้องสั่งซื้อ {n} · ใกล้ Min {counts.get(RS_NEAR, 0)}")

    def apply(self) -> None:
        if not self.lines:
            self.run()
        n = apply_min_max(self.lines)
        self.state.rebuild_stock()
        self.run()
        self.state.notify(f"ใช้ Min/Max ที่แนะนำ {n} รายการ (เก็บในแหล่งสต็อกของโปรแกรม)")

    def export(self, only_orders: bool) -> None:
        if not self.lines:
            self.run()
        path = self.actions.save_path("ใบขอซื้อ (ร่าง)" if only_orders else "Min / Max",
                                      "ใบขอซื้อตามจุดสั่งซื้อ.xlsx" if only_orders else "MinMax.xlsx",
                                      "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            export_replenish(self.lines, path, self.params(), only_orders)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")
