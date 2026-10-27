"""สโตร์ / คลัง - store stock master and the material check against the Part List."""

from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import QSortFilterProxyModel, Qt
from PySide6.QtWidgets import (QAbstractItemView, QCheckBox, QFileDialog, QHBoxLayout, QHeaderView, QLabel,
                               QLineEdit, QListWidget,
                               QListWidgetItem, QMenu, QSplitter, QTableView, QTabWidget, QVBoxLayout,
                               QWidget)

from ...core.company_files import (SHEET_STEEL, export_steel_issue, export_stock_count, read_company_workbook,
                                   sheet_names)
from ...core.express import read_express_file
from ...core.part_match import CLOSE, M_NONE, M_STOCK_CODE, match_parts
from ...core.stock import (ST_LOW, ST_MISSING, ST_OK, ST_SHORT, StockList, apply_status_to_parts,
                           check_requirements, export_requirements)
from ..actions import TABLE_FILTER
from ..state import AppState
from ..table_models import RequirementModel, StockTableModel
from ..widgets import PageHeader, StatusChipRow, button, empty_hint, fill, selected_rows, table
from .parts_ready import PartsReadyTab
from .replenish import ReplenishTab
from .steel import SteelTab


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
        exp = header.add_action(button("ส่งออก ▾", tooltip="ส่งสต็อกออกเป็น Excel/CSV (หัวตารางแบบ Express หรือไฟล์นับสต๊อค)"))
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
        rm = button("ลบแหล่งที่เลือก", tooltip="เอาแหล่งข้อมูลที่เลือกออก (ไฟล์ต้นฉบับไม่ถูกลบ) – นำเข้าใหม่ได้ทุกเมื่อ")
        rm.clicked.connect(self._remove_source)
        src_lay.addWidget(rm)
        split.addWidget(src_box)
        table_box = QWidget()
        tl = QVBoxLayout(table_box)
        tl.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        self.stock_search = QLineEdit()
        self.stock_search.setPlaceholderText("ค้นหา รหัส / ชื่อสินค้า / วัสดุ / ขนาด …")
        self.stock_search.setClearButtonEnabled(True)
        self.stock_search.setToolTip("พิมพ์บางส่วนของรหัสหรือชื่อ เช่น 01-B00, 3 มม., หูช้าง (Ctrl+F)")
        self.stock_search.textChanged.connect(self._filter_stock)
        row.addWidget(self.stock_search, 2)
        for text, slot, tip in (("+ เพิ่มรายการ", self._add_item, "เพิ่มรายการสต็อกเอง (แหล่ง: เพิ่มเอง) แล้วพิมพ์ในตาราง"),
                                ("ลบที่เลือก", self._remove_items, "ลบรายการที่เลือกออกจากสต็อกในโปรแกรม")):
            b = button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        tl.addLayout(row)
        self.source_label = QLabel()
        self.source_label.setObjectName("Hint")
        self.source_label.setWordWrap(True)
        tl.addWidget(self.source_label)
        self.stock_model = StockTableModel(state.stock, self)
        self.stock_model.dataChanged.connect(self._stock_edited)
        # search and sort (click a column head) without changing the order of the stock itself
        self.stock_proxy = QSortFilterProxyModel(self)
        self.stock_proxy.setSourceModel(self.stock_model)
        self.stock_proxy.setFilterKeyColumn(-1)
        self.stock_proxy.setFilterCaseSensitivity(Qt.CaseInsensitive)
        self.stock_proxy.setSortRole(Qt.EditRole)  # numbers sort as numbers
        self.stock_view = _table(self.stock_proxy)
        self.stock_view.horizontalHeader().setSortIndicator(-1, Qt.AscendingOrder)  # the order of the files …
        self.stock_view.setSortingEnabled(True)  # … until a column head is clicked
        self.stock_view.horizontalHeader().setSortIndicatorClearable(True)
        empty_hint(self.stock_view, lambda: "ไม่พบรายการที่ตรงกับการค้นหา / ตัวกรอง – ล้างช่องค้นหาเพื่อดูทั้งหมด" if self.state.stock.items else
                   "ยังไม่มีสต็อก – กด นำเข้าไฟล์สต็อก (Express Excel/CSV/รายงาน, ไฟล์นับสต๊อค, สต็อกเหล็ก)")
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
        self.build = QLabel()
        self.build.setToolTip("จำนวนคันของ Part List แก้ได้ที่หน้าภาพรวมที่เดียว · งานที่เปิดแล้วแก้ที่หน้างานผลิต")
        row.addWidget(self.build)
        edit_build = button("แก้ที่หน้าภาพรวม ›", tooltip="จำนวนคันของ Part List แก้ได้ที่หน้าภาพรวมที่เดียว · งานที่เปิดแล้วแก้ที่หน้างานผลิต")
        edit_build.clicked.connect(lambda: self.actions.go("dashboard"))
        row.addWidget(edit_build)
        run = button("ตรวจวัตถุดิบเทียบสต็อก", "accent", "เทียบสิ่งที่ Part List × จำนวนคันต้องใช้ กับยอดคงเหลือในสต็อก")
        run.clicked.connect(self.run_check)
        row.addWidget(run)
        self.chips = StatusChipRow([ST_SHORT, ST_MISSING, ST_LOW, ST_OK], hide_zero=True)
        row.addLayout(self.chips)
        row.addStretch(1)
        cl.addLayout(row)
        self.req_model = RequirementModel(self)
        self.req_view = _table(self.req_model)
        empty_hint(self.req_view, "กด ตรวจวัตถุดิบเทียบสต็อก – เทียบสิ่งที่ Part List × จำนวนคันต้องใช้กับยอดคงเหลือ")
        for i, w in enumerate([140, 210, 55, 80, 80, 110, 60, 60, 100, 100, 75, 200, 160, 120]):
            self.req_view.setColumnWidth(i, w)
        self.check_tabs = QTabWidget()
        self.check_tabs.addTab(self.req_view, "ผลตรวจวัตถุดิบ")
        match_page = QWidget()
        ml = QVBoxLayout(match_page)
        ml.setContentsMargins(0, 6, 0, 0)
        hint = QLabel("ชิ้นส่วนแต่ละรายการหารายการสต็อก: รหัสสโตร์ใน Part List → รหัสในแบบ (ตรง / ตารางเทียบรหัส) → "
                      "รหัสชิ้นส่วนเดียวกัน (RRS-ยี่ห้อ-เลขชิ้นส่วน: T Toyota · I Isuzu · M Mitsubishi · F Ford · "
                      "N Nissan · A = ทุกยี่ห้อ เช่น RRS-T-039 เต้า1 = RRS-A-039-NO1-PR) → "
                      "ชื่อชิ้นส่วน (ชื่อ เลขชิ้นส่วนในรหัส รุ่นรถ ความสูงคอก ความยาวกระบะ ซ้าย/ขวา) → วัสดุ/ความหนา · "
                      "ผลใกล้เคียง (รหัสเดียวกันแต่ชื่อ/ขนาดต่าง, ชื่อสะกดต่าง) จับคู่ให้เลย "
                      "ขึ้นก่อนพร้อมตัวเลือกอื่น · "
                      "ยี่ห้อรถเลือกได้ที่หน้าภาพรวม (ไม่เลือก = อ่านจากรหัสในแบบ) · "
                      "ชิ้นในแบบที่ไม่ระบุซ้าย/ขวา แบ่งจำนวนให้รหัสซ้ายและขวาอย่างละครึ่ง")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        ml.addWidget(hint)
        self.match_table = table(["รหัสในแบบ", "ชื่อชิ้นส่วน", "รหัสสินค้า (สต็อก)", "ชื่อในสต็อก", "คงเหลือ",
                                  "การจับคู่", "อ่านรหัส / ตัวเลือกอื่น"], [110, 190, 230, 260, 70, 170, 340])
        ml.addWidget(self.match_table, 1)
        mrow = QHBoxLayout()
        self.confirm_btn = button("ยืนยันรหัสที่เลือก → รหัสสโตร์ใน Part List", "primary",
                                  tooltip="บันทึกรหัสสินค้าที่จับคู่ได้ของแถวที่เลือกเป็นรหัสสโตร์ของชิ้นส่วนใน Part List "
                                          "ครั้งต่อไปใช้รหัสนี้ทันที (แถวที่ไม่เลือก = ทุกแถวที่จับคู่จากผลใกล้เคียง)")
        self.confirm_btn.clicked.connect(self.confirm_matches)
        mrow.addWidget(self.confirm_btn)
        self.clear_btn = button("ล้างรหัสสโตร์ที่เลือก", tooltip="ให้ระบบจับคู่แถวที่เลือกใหม่จากรหัส/ชื่อ")
        self.clear_btn.clicked.connect(self.clear_matches)
        mrow.addWidget(self.clear_btn)
        mrow.addStretch(1)
        self.nearest = QCheckBox("ไม่พบรหัสในสต็อก → ใช้ผลใกล้เคียงจากตารางเทียบรหัส / รายการใกล้เคียงที่สุด")
        self.nearest.setToolTip("ชิ้นที่จับคู่จากรหัสและชื่อแล้วยังไม่พบ: ใช้คู่รหัสในตารางเทียบรหัส (รหัส 3 หลักหน้าเดียวกัน "
                                "หรือชื่อใกล้เคียง) ถ้าไม่มีใช้รายการแรกในรายการใกล้เคียง – ไม่ใช้ยี่ห้ออื่น และไม่ใช้เบอร์อื่น "
                                "ของชิ้นที่มีเบอร์ (เต้า4 ≠ เต้าเบอร์ 1) · ผลขึ้นเป็น ใกล้เคียงที่สุด ให้ตรวจ/เปลี่ยนได้")
        self.nearest.setChecked(self.state.settings.get("match/nearest", "1") == "1")
        self.nearest.toggled.connect(self._nearest_toggled)
        mrow.addWidget(self.nearest)
        ml.addLayout(mrow)
        self.check_tabs.addTab(match_page, "จับคู่ชิ้นส่วน ↔ สต็อก")
        cl.addWidget(self.check_tabs, 1)
        row = QHBoxLayout()
        hint = QLabel("น้ำหนักชิ้นงาน × จำนวน × คัน ใช้กับรายการสต็อกที่นับเป็น กก. · รายการอื่นนับจำนวนชิ้น")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        row.addWidget(hint, 1)
        self.apply_btn = button("อัปเดตสถานะใน Part List", tooltip="ใส่สถานะ พร้อม / ขาด / รอสั่งซื้อ ให้แต่ละแถวของ Part List")
        self.apply_btn.clicked.connect(self.apply_status)
        self.export_btn = button("ส่งออกผลตรวจ (Excel)", tooltip="ตารางผลตรวจวัตถุดิบเป็น Excel")
        self.export_btn.clicked.connect(lambda: self._export_req(False))
        self.po_btn = button("ส่งออกใบขอซื้อ (ร่าง)", "primary", "รายการที่ขาด/ต่ำกว่า Min พร้อมจำนวนแนะนำสั่งซื้อ")
        self.po_btn.clicked.connect(lambda: self._export_req(True))
        self.steel_btn = button("ใบจ่ายเหล็ก (ลงแท็บสต๊อกเหล็ก)", tooltip="เหล็กที่ต้องใช้ในรูปแบบแท็บสต๊อกเหล็กของไฟล์นับสต๊อค")
        self.steel_btn.clicked.connect(self._export_steel_issue)
        for b in (self.apply_btn, self.export_btn, self.steel_btn, self.po_btn):
            row.addWidget(b)
        cl.addLayout(row)
        self.tabs.addTab(check_tab, "ตรวจวัตถุดิบ / Parts")
        self.replenish = ReplenishTab(state, actions)
        self.tabs.addTab(self.replenish, "Min / Max && เตือนสั่งซื้อ")  # && = one & (a single & underlines)
        self.ready = PartsReadyTab(state, actions)
        self.tabs.addTab(self.ready, "ชิ้นส่วนพร้อมประกอบ (แยกกลุ่ม)")
        self.steel = SteelTab(state, actions)
        self.tabs.addTab(self.steel, "สต็อกเหล็ก")

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
        self.auto_check()

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
        self._count_stock()

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
        rows = {self.stock_proxy.mapToSource(i).row() for i in self.stock_view.selectionModel().selectedRows()}
        self.state.remove_items([self.state.stock.items[r] for r in sorted(rows) if r < len(self.state.stock.items)])

    def _filter_stock(self, text: str = "") -> None:
        self.stock_proxy.setFilterFixedString(self.stock_search.text().strip())
        self._count_stock()

    def _count_stock(self) -> None:
        total, shown = len(self.state.stock.items), self.stock_proxy.rowCount()
        found = f"พบ {shown} จาก {total} รายการ · " if self.stock_search.text().strip() else f"{total} รายการ · "
        self.source_label.setText(
            f"{found}จาก {len(self.state.active_sources)} แหล่ง (รหัสซ้ำกันใช้แหล่งที่อยู่บนก่อน · ตัวเลขคงเหลือมาจาก"
            "ไฟล์ของสโตร์ ตรวจว่าเป็นรายงานล่าสุดก่อนใช้ · คลิกหัวคอลัมน์เพื่อเรียง · ดับเบิลคลิกเพื่อแก้)")

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
        self.build.setText(f"จำนวนผลิต <b>{max(1, self.state.partlist.info.build_qty)} คัน</b>")

    def run_check(self, show: bool = True) -> bool:
        if not self.state.partlist.parts:
            self.actions.error("ยังไม่มี Part List", "นำเข้าแบบหรือตาราง BOM ก่อน")
            return False
        if not self.state.stock.items:
            self.actions.error("ยังไม่มีข้อมูลสต็อก", "นำเข้าไฟล์สต็อกของสโตร์ก่อน (หรือดึงจาก Express / Google Sheet)")
            return False
        self.state.part_matches = match_parts(self.state.partlist, self.state.stock, self.nearest.isChecked())
        self.state.requirements = check_requirements(self.state.partlist, self.state.stock,
                                                     densities=self.state.settings.densities,
                                                     matches=self.state.part_matches)
        self.state.requirements_changed.emit()
        if show:
            self.tabs.setCurrentIndex(1)
        return True

    def _nearest_toggled(self, on: bool) -> None:
        self.state.settings.set("match/nearest", "1" if on else "0")
        if self.state.requirements:
            self.run_check(show=False)

    def auto_check(self) -> None:
        """Stock and a Part List are both there: check the material without being asked."""
        if not (self.state.partlist.parts and self.state.stock.items) or not self.run_check(show=False):
            return
        counts: dict[str, int] = {}
        for line in self.state.requirements:
            counts[line.status] = counts.get(line.status, 0) + 1
        named = sum(1 for _p, m in self.state.part_matches if m.method not in (M_NONE,) and m.score < 99)
        close = sum(1 for _p, m in self.state.part_matches if m.close)
        self.state.notify("ตรวจวัตถุดิบเทียบสต็อกแล้ว: " + " · ".join(f"{k} {v}" for k, v in counts.items())
                          + (f" · จับคู่รหัสอัตโนมัติ {named} รายการ" if named else "")
                          + (f" (จากผลใกล้เคียง {close} – ดูได้ที่แท็บ จับคู่ชิ้นส่วน ↔ สต็อก)" if close else ""))

    def _show_matches(self) -> None:
        matches = self.state.part_matches
        rows = []
        for part, m in matches:
            codes = " / ".join(i.code for i, _s in m.items)
            names = " / ".join(i.name for i, _s in m.items)
            on_hand = " / ".join(f"{i.on_hand:g}" for i, _s in m.items)
            rows.append([part.part_no, part.name, codes, names, on_hand, m.method if m.items else M_NONE,
                         "; ".join(([m.note] if m.note else []) + m.alternatives[:3])])
        idx = sorted(range(len(rows)), key=lambda i: 0 if rows[i][5] in CLOSE else 1 if rows[i][5] == M_NONE else 2)
        fill(self.match_table, [rows[i] for i in idx], status_col=5, data=[i for i in idx])
        close = sum(1 for r in rows if r[5] in CLOSE)
        none = sum(1 for r in rows if r[5] == M_NONE)
        self.check_tabs.setTabText(1, "จับคู่ชิ้นส่วน ↔ สต็อก" + (
            f" (ใกล้เคียง {close} · ไม่พบ {none})" if close or none else ""))
        self.confirm_btn.setEnabled(bool(rows))
        self.clear_btn.setEnabled(bool(rows))

    def _match_rows(self, only_check: bool) -> list:
        picked = [self.match_table.item(r, 0).data(Qt.UserRole) for r in selected_rows(self.match_table)]
        matches = self.state.part_matches
        if not picked and only_check:
            picked = [i for i, (_p, m) in enumerate(matches) if m.close]
        return [matches[i] for i in picked if 0 <= i < len(matches)]

    def confirm_matches(self) -> None:
        n = 0
        for part, m in self._match_rows(only_check=True):
            if m.items and all(i.code for i, _s in m.items) and m.method != M_STOCK_CODE:
                part.stock_code = " / ".join(i.code for i, _s in m.items)
                n += 1
        if n:
            self.state.mark_dirty()
            self.run_check(show=False)
        self.state.notify(f"บันทึกรหัสสโตร์ใน Part List {n} รายการ" if n else "ไม่มีแถวที่ยืนยันได้ (เลือกแถวที่มีรหัสสินค้า)")

    def clear_matches(self) -> None:
        n = 0
        for part, _m in self._match_rows(only_check=False):
            if part.stock_code:
                part.stock_code = ""
                n += 1
        if n:
            self.state.mark_dirty()
            self.run_check(show=False)
        self.state.notify(f"ล้างรหัสสโตร์ {n} รายการ – จับคู่ใหม่จากรหัส/ชื่อแล้ว")

    def _show_requirements(self) -> None:
        lines = self.state.requirements
        self.req_model.set_lines(lines)
        counts: dict[str, int] = {}
        for line in lines:
            counts[line.status] = counts.get(line.status, 0) + 1
        self.chips.set_counts(counts)
        for b in (self.apply_btn, self.export_btn, self.po_btn, self.steel_btn):
            b.setEnabled(bool(lines))
        self._show_matches()

    def apply_status(self) -> None:
        changed = apply_status_to_parts(self.state.partlist, self.state.stock, self.state.requirements,
                                        self.state.part_matches or None)
        self.state.mark_dirty()
        self.state.notify(f"อัปเดตสถานะและรหัสสโตร์ใน Part List {changed} รายการ")

    def _export_req(self, only_purchase: bool) -> None:
        tail = "PurchaseRequest" if only_purchase else "MaterialCheck"
        path = self.actions.save_path("ส่งออก", self.actions.default_name(".xlsx", tail), "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            export_requirements(self.state.partlist, self.state.requirements, path, only_purchase,
                                self.state.part_matches)
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
