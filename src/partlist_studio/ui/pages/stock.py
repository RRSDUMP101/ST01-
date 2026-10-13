"""สโตร์ / คลัง - store stock master and the material check against the Part List."""

from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QAbstractItemView, QFileDialog, QHBoxLayout, QHeaderView, QLabel, QListWidget,
                               QListWidgetItem, QMenu, QSpinBox, QSplitter, QTableView, QTabWidget, QVBoxLayout,
                               QWidget)

from ...core.company_files import (SHEET_STEEL, export_steel_issue, export_stock_count, read_company_workbook,
                                   sheet_names)
from ...core.express import read_express_file
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
        self._migrate_old_cache()
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        header = PageHeader("สโตร์ / คลังสินค้า",
                            "นำเข้าสต็อกจากไฟล์ของสโตร์ (Express / Excel / Google Sheet) แล้วตรวจวัตถุดิบและ Parts "
                            "ที่ต้องใช้ตาม Part List × จำนวนคัน ก่อนปล่อยงานเข้าฝ่ายผลิต")
        b = header.add_action(button("นำเข้าไฟล์สต็อก", "primary",
                                     "Express (Excel/CSV/รายงาน .txt), ไฟล์นับสต๊อค .xls, แท็บสต๊อกเหล็ก/อะไหล่กระบะ"))
        b.clicked.connect(self.import_stock)
        exp = header.add_action(button("ส่งออก ▾"))
        menu = QMenu(exp)
        menu.addAction("สต็อก (Excel/CSV หัวตารางเดียวกับ Express)…", self._export_stock)
        menu.addAction("สต็อกรูปแบบไฟล์นับสต๊อค (STBALLL + Format Stock R1)…", self._export_count_format)
        exp.setMenu(menu)
        lay.addWidget(header)

        self.tabs = QTabWidget()
        lay.addWidget(self.tabs, 1)

        # --- tab 1: stock master
        stock_tab = QWidget()
        sl = QVBoxLayout(stock_tab)
        sl.setContentsMargins(12, 12, 12, 12)
        split = QSplitter(Qt.Horizontal)
        src_box = QWidget()
        src_lay = QVBoxLayout(src_box)
        src_lay.setContentsMargins(0, 0, 8, 0)
        cap = QLabel("แหล่งข้อมูลสต็อก (ติ๊ก = ใช้ตรวจวัตถุดิบ)")
        cap.setObjectName("CardTitle")
        src_lay.addWidget(cap)
        self.sources = QListWidget()
        self.sources.setObjectName("Plain")
        self.sources.itemChanged.connect(self._source_toggled)
        src_lay.addWidget(self.sources, 1)
        rm = button("ลบแหล่งที่เลือก")
        rm.clicked.connect(self._remove_source)
        src_lay.addWidget(rm)
        split.addWidget(src_box)
        table_box = QWidget()
        tl = QVBoxLayout(table_box)
        tl.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        self.source_label = QLabel()
        self.source_label.setObjectName("Hint")
        self.source_label.setWordWrap(True)
        row.addWidget(self.source_label, 1)
        for text, slot in (("+ เพิ่มรายการ", self._add_item), ("ลบที่เลือก", self._remove_items)):
            b = button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        tl.addLayout(row)
        self.stock_model = StockTableModel(state.stock, self)
        self.stock_model.dataChanged.connect(self._stock_edited)
        self.stock_view = _table(self.stock_model)
        for i, w in enumerate([130, 230, 50, 70, 90, 80, 50, 80, 90, 50, 50, 50, 60]):
            self.stock_view.setColumnWidth(i, w)
        tl.addWidget(self.stock_view, 1)
        split.addWidget(table_box)
        split.setSizes([260, 1000])
        sl.addWidget(split, 1)
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
        self.steel_btn = button("ใบจ่ายเหล็ก (ลงแท็บสต๊อกเหล็ก)")
        self.steel_btn.clicked.connect(self._export_steel_issue)
        for b in (self.apply_btn, self.export_btn, self.steel_btn, self.po_btn):
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
    def _migrate_old_cache(self) -> None:
        """Version 0.1 kept one stock list in the settings."""
        raw = self.state.settings.get("stock/cache")
        if raw and not self.state.stock_sources:
            try:
                old = StockList.from_dict(json.loads(raw))
            except ValueError:
                old = None
            if old and old.items:
                self.state.add_stock_source(Path(old.source).name or "สต็อกเดิม", old)
        if raw:
            self.state.settings.set("stock/cache", "")

    def import_stock(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(
                self, "เลือกไฟล์สต็อก (Express / ไฟล์นับสต๊อค / สต๊อกเหล็ก)", self.state.settings.get("last_dir"),
                TABLE_FILTER + ";;Express รายงาน (*.txt *.prn)")
        if not path:
            return
        self.state.settings.set("last_dir", str(Path(path).parent))
        try:
            added = self.read_stock_file(path)
        except Exception as exc:  # noqa: BLE001
            self.actions.error("เปิดไฟล์สต็อกไม่ได้", str(exc))
            return
        if not added:
            self.actions.error("ไม่พบรายการสต็อก", "ไม่พบหัวตาราง เช่น รหัสสินค้า / รายการ / จำนวน / ยอดคงเหลือ / หน่วย")
            return
        self.tabs.setCurrentIndex(0)
        self.state.notify("นำเข้าสต็อก: " + ", ".join(f"{n} ({c} รายการ)" for n, c in added))

    def read_stock_file(self, path: str) -> list[tuple[str, int]]:
        """Every stock sheet of a company workbook becomes its own source; other files one source."""
        p = Path(path)
        added: list[tuple[str, int]] = []
        if p.suffix.lower() in (".xls", ".xlsx", ".xlsm") and len(sheet_names(p)) > 1:
            book = read_company_workbook(p)
            first_coded = True
            for sheet, stock in book.stocks.items():
                name = f"{p.stem} / {sheet}"
                coded = any(i.code for i in stock.items)
                # STBALLL and Format Stock R1 hold the same items: activate one of them only
                active = book.kinds.get(sheet) == SHEET_STEEL or not coded or first_coded
                first_coded = first_coded and not coded
                self.state.add_stock_source(name, stock, activate=active)
                added.append((name, len(stock.items)))
            if added:
                return added
        stock, _report = read_express_file(p)
        if stock.items:
            self.set_stock(stock, p.name)
            added.append((p.name, len(stock.items)))
        return added

    def set_stock(self, stock: StockList, name: str = "") -> None:
        self.state.add_stock_source(name or stock.source or "สต็อก", stock)

    def _stock_replaced(self) -> None:
        self.stock_model.set_stock(self.state.stock)
        self.sources.blockSignals(True)
        self.sources.clear()
        for name, src in self.state.stock_sources.items():
            item = QListWidgetItem(f"{name}\n{len(src.items)} รายการ" + ("" if src.has_quantities else " · ไม่มียอด"))
            item.setData(Qt.UserRole, name)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Checked if name in self.state.active_sources else Qt.Unchecked)
            self.sources.addItem(item)
        self.sources.blockSignals(False)
        self.source_label.setText(
            f"{len(self.state.stock.items)} รายการจาก {len(self.state.active_sources)} แหล่ง "
            "(รหัสซ้ำกันใช้แหล่งที่อยู่บนก่อน · ตัวเลขคงเหลือมาจากไฟล์ของสโตร์ ตรวจว่าเป็นรายงานล่าสุดก่อนใช้)")

    def _source_toggled(self, item: QListWidgetItem) -> None:
        self.state.set_source_active(item.data(Qt.UserRole), item.checkState() == Qt.Checked)

    def _remove_source(self) -> None:
        item = self.sources.currentItem()
        if item:
            self.state.remove_stock_source(item.data(Qt.UserRole))

    def _stock_edited(self, *args) -> None:
        self.state.save_library()

    def _add_item(self) -> None:
        self.state.add_manual_item()

    def _remove_items(self) -> None:
        rows = {i.row() for i in self.stock_view.selectionModel().selectedRows()}
        self.state.remove_items([self.state.stock.items[r] for r in rows])

    def _export_stock(self) -> None:
        path = self.actions.save_path("ส่งออกสต็อก", "Stock.xlsx", "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            from ...core.tabular import write_table

            rows = self.state.stock.to_rows()
            write_table(path, rows[0], rows[1:], sheet_title="Stock")
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def _export_count_format(self) -> None:
        coded = StockList(items=[i for i in self.state.stock.items if i.code])
        path = self.actions.save_path("ส่งออกรูปแบบไฟล์นับสต๊อค", "รายการ Stock ชิ้นส่วนกระบะดั้มพ์.นับสต๊อค.xlsx",
                                      "Excel (*.xlsx)")
        if path:
            export_stock_count(coded, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({len(coded.items)} รายการ)")

    # ---- check -------------------------------------------------------------
    def _sync_build(self) -> None:
        self.build.blockSignals(True)
        self.build.setValue(max(1, self.state.partlist.info.build_qty))
        self.build.blockSignals(False)

    def _build_changed(self, value: int) -> None:
        if self.state.partlist.info.build_qty != value:
            self.state.partlist.info.build_qty = value
            self.state.mark_dirty()

    def run_check(self, show: bool = True) -> bool:
        if not self.state.partlist.parts:
            self.actions.error("ยังไม่มี Part List", "นำเข้าแบบหรือตาราง BOM ก่อน")
            return False
        if not self.state.stock.items:
            self.actions.error("ยังไม่มีข้อมูลสต็อก", "นำเข้าไฟล์สต็อกของสโตร์ก่อน (หรือดึงจาก Express / Google Sheet)")
            return False
        self.state.requirements = check_requirements(self.state.partlist, self.state.stock,
                                                     densities=self.state.settings.densities)
        self.state.requirements_changed.emit()
        if show:
            self.tabs.setCurrentIndex(1)
        return True

    def _show_requirements(self) -> None:
        lines = self.state.requirements
        self.req_model.set_lines(lines)
        counts: dict[str, int] = {}
        for line in lines:
            counts[line.status] = counts.get(line.status, 0) + 1
        self.chips.set_counts(counts)
        for b in (self.apply_btn, self.export_btn, self.po_btn, self.steel_btn):
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

    def _export_steel_issue(self) -> None:
        ledgers = [s for n, s in self.state.stock_sources.items() if n in self.state.active_sources
                   and not any(i.code for i in s.items) and any(i.unit in ("แผ่น", "เส้น") for i in s.items)]
        ledger = StockList(items=[i for s in ledgers for i in s.items])
        path = self.actions.save_path("ใบจ่ายเหล็ก", self.actions.default_name(".xlsx", "SteelIssue"), "Excel (*.xlsx)")
        if path:
            info = self.state.partlist.info
            n = export_steel_issue(self.state.requirements, ledger, path,
                                   reference=" ".join(x for x in (info.so_no, info.vehicle_model) if x))
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({n} รายการ)")
