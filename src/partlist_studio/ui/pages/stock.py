"""สโตร์ / คลัง - store stock master and the material check against the Part List."""

from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtWidgets import (QAbstractItemView, QFileDialog, QHBoxLayout, QHeaderView, QLabel, QSpinBox,
                               QTableView, QTabWidget, QVBoxLayout, QWidget)

from ...core.stock import (ST_LOW, ST_MISSING, ST_OK, ST_SHORT, StockList, apply_status_to_parts,
                           check_requirements, export_requirements)
from ..actions import TABLE_FILTER
from ..state import AppState
from ..table_models import RequirementModel, StockTableModel
from ..widgets import PageHeader, StatusChipRow, button


def _table(model) -> QTableView:
    view = QTableView()
    view.setModel(model)
    view.setAlternatingRowColors(True)
    view.setSelectionBehavior(QAbstractItemView.SelectRows)
    view.verticalHeader().setVisible(False)
    view.verticalHeader().setDefaultSectionSize(30)
    view.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
    view.horizontalHeader().setStretchLastSection(True)
    return view


class StockPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state = state
        self.actions = actions
        self._load_cached_stock()
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        header = PageHeader("สโตร์ / คลังสินค้า",
                            "นำเข้าสต็อกจากไฟล์ของสโตร์ (Express / Excel / Google Sheet) แล้วตรวจวัตถุดิบและ Parts "
                            "ที่ต้องใช้ตาม Part List × จำนวนคัน ก่อนปล่อยงานเข้าฝ่ายผลิต")
        b = header.add_action(button("นำเข้าไฟล์สต็อก", "primary"))
        b.clicked.connect(self.import_stock)
        lay.addWidget(header)

        self.tabs = QTabWidget()
        lay.addWidget(self.tabs, 1)

        # --- tab 1: stock master
        stock_tab = QWidget()
        sl = QVBoxLayout(stock_tab)
        sl.setContentsMargins(12, 12, 12, 12)
        row = QHBoxLayout()
        self.source_label = QLabel()
        self.source_label.setObjectName("Hint")
        row.addWidget(self.source_label, 1)
        for text, slot in (("+ เพิ่มรายการ", self._add_item), ("ลบที่เลือก", self._remove_items),
                           ("ส่งออกสต็อก", self._export_stock)):
            b = button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        sl.addLayout(row)
        self.stock_model = StockTableModel(state.stock, self)
        self.stock_model.dataChanged.connect(self._stock_edited)
        self.stock_view = _table(self.stock_model)
        for i, w in enumerate([150, 220, 90, 110, 60, 80, 70, 70]):
            self.stock_view.setColumnWidth(i, w)
        sl.addWidget(self.stock_view, 1)
        self.tabs.addTab(stock_tab, "สต็อกสโตร์")

        # --- tab 2: material check
        check_tab = QWidget()
        cl = QVBoxLayout(check_tab)
        cl.setContentsMargins(12, 12, 12, 12)
        row = QHBoxLayout()
        row.addWidget(QLabel("จำนวนผลิต"))
        self.build = QSpinBox()
        self.build.setRange(1, 9999)
        self.build.setSuffix(" คัน")
        self.build.setButtonSymbols(QSpinBox.NoButtons)
        self.build.setFixedWidth(90)
        self.build.valueChanged.connect(self._build_changed)
        row.addWidget(self.build)
        run = button("ตรวจวัตถุดิบเทียบสต็อก", "accent")
        run.clicked.connect(self.run_check)
        row.addWidget(run)
        self.chips = StatusChipRow([ST_SHORT, ST_MISSING, ST_LOW, ST_OK], hide_zero=True)
        row.addLayout(self.chips)
        row.addStretch(1)
        cl.addLayout(row)
        self.req_model = RequirementModel(self)
        self.req_view = _table(self.req_model)
        for i, w in enumerate([140, 210, 55, 80, 80, 110, 60, 60, 100, 100, 75, 200]):
            self.req_view.setColumnWidth(i, w)
        cl.addWidget(self.req_view, 1)
        row = QHBoxLayout()
        hint = QLabel("น้ำหนักชิ้นงาน × จำนวน × คัน ใช้กับรายการสต็อกที่นับเป็น กก. · รายการอื่นนับจำนวนชิ้น")
        hint.setObjectName("Hint")
        row.addWidget(hint, 1)
        self.apply_btn = button("อัปเดตสถานะใน Part List")
        self.apply_btn.clicked.connect(self.apply_status)
        self.export_btn = button("ส่งออกผลตรวจ (Excel)")
        self.export_btn.clicked.connect(lambda: self._export_req(False))
        self.po_btn = button("ส่งออกใบขอซื้อ (ร่าง)", "primary")
        self.po_btn.clicked.connect(lambda: self._export_req(True))
        for b in (self.apply_btn, self.export_btn, self.po_btn):
            row.addWidget(b)
        cl.addLayout(row)
        self.tabs.addTab(check_tab, "ตรวจวัตถุดิบ / Parts")

        state.stock_changed.connect(self._stock_replaced)
        state.partlist_changed.connect(self._sync_build)
        state.requirements_changed.connect(self._show_requirements)
        self._stock_replaced()
        self._sync_build()
        self._show_requirements()

    # ---- stock -------------------------------------------------------------
    def _load_cached_stock(self) -> None:
        raw = self.state.settings.get("stock/cache")
        if raw:
            try:
                self.state.stock = StockList.from_dict(json.loads(raw))
            except ValueError:
                pass

    def _save_cache(self) -> None:
        self.state.settings.set("stock/cache", json.dumps(self.state.stock.to_dict(), ensure_ascii=False))

    def import_stock(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์สต็อกสโตร์ (Express / Excel / CSV)",
                                              self.state.settings.get("last_dir"), TABLE_FILTER)
        if not path:
            return
        try:
            stock = StockList.from_file(path)
        except Exception as exc:  # noqa: BLE001
            self.actions.error("เปิดไฟล์สต็อกไม่ได้", str(exc))
            return
        if not stock.items:
            self.actions.error("ไม่พบรายการสต็อก", "ไม่พบหัวตาราง เช่น รหัสสินค้า / ชื่อสินค้า / คงเหลือ / หน่วย")
            return
        self.set_stock(stock)
        self.state.notify(f"นำเข้าสต็อก {len(stock.items)} รายการจาก {Path(path).name}")

    def set_stock(self, stock: StockList) -> None:
        self.state.stock = stock
        self._save_cache()
        self.state.stock_changed.emit()

    def _stock_replaced(self) -> None:
        self.stock_model.set_stock(self.state.stock)
        src = self.state.stock.source
        self.source_label.setText(
            f"{len(self.state.stock.items)} รายการ · ที่มา: {src or 'ยังไม่ได้นำเข้า'} "
            "(ตัวเลขคงเหลือมาจากไฟล์ของสโตร์ ตรวจให้เป็นรายงานล่าสุดก่อนใช้)")

    def _stock_edited(self, *args) -> None:
        self._save_cache()

    def _add_item(self) -> None:
        self.stock_model.add_item()
        self._save_cache()

    def _remove_items(self) -> None:
        rows = [i.row() for i in self.stock_view.selectionModel().selectedRows()]
        self.stock_model.remove_rows(rows)
        self._save_cache()

    def _export_stock(self) -> None:
        path = self.actions.save_path("ส่งออกสต็อก", "Stock.xlsx", "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            from ...core.tabular import write_table

            rows = self.state.stock.to_rows()
            write_table(path, rows[0], rows[1:], sheet_title="Stock")

    # ---- check -------------------------------------------------------------
    def _sync_build(self) -> None:
        self.build.blockSignals(True)
        self.build.setValue(max(1, self.state.partlist.info.build_qty))
        self.build.blockSignals(False)

    def _build_changed(self, value: int) -> None:
        if self.state.partlist.info.build_qty != value:
            self.state.partlist.info.build_qty = value
            self.state.mark_dirty()

    def run_check(self) -> None:
        if not self.state.partlist.parts:
            self.actions.error("ยังไม่มี Part List", "นำเข้าแบบหรือตาราง BOM ก่อน")
            return
        if not self.state.stock.items:
            self.actions.error("ยังไม่มีข้อมูลสต็อก", "นำเข้าไฟล์สต็อกของสโตร์ก่อน (หรือดึงจาก Google Sheet)")
            return
        self.state.requirements = check_requirements(self.state.partlist, self.state.stock)
        self.state.requirements_changed.emit()
        self.tabs.setCurrentIndex(1)

    def _show_requirements(self) -> None:
        lines = self.state.requirements
        self.req_model.set_lines(lines)
        counts: dict[str, int] = {}
        for line in lines:
            counts[line.status] = counts.get(line.status, 0) + 1
        self.chips.set_counts(counts)
        for b in (self.apply_btn, self.export_btn, self.po_btn):
            b.setEnabled(bool(lines))

    def apply_status(self) -> None:
        changed = apply_status_to_parts(self.state.partlist, self.state.stock, self.state.requirements)
        self.state.mark_dirty()
        self.state.notify(f"อัปเดตสถานะและรหัสสโตร์ใน Part List {changed} รายการ")

    def _export_req(self, only_purchase: bool) -> None:
        tail = "PurchaseRequest" if only_purchase else "MaterialCheck"
        path = self.actions.save_path("ส่งออก", self.actions.default_name(".xlsx", tail), "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            export_requirements(self.state.partlist, self.state.requirements, path, only_purchase)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")
