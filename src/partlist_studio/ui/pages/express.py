"""Express - files to and from the Express accounting program, code table, sync checks."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtWidgets import (QAbstractItemView, QFileDialog, QGridLayout, QHBoxLayout, QHeaderView, QLabel,
                               QLineEdit, QScrollArea, QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout,
                               QWidget)

from ...core.express import (SYNC_SAME, check_part_codes, code_family, compare_stock, export_new_items,
                             export_pd_draft, new_items, read_express_file)
from ...core.stock import StockList, export_requirements
from ...core.tabular import read_table, write_table
from ...core.xref import XREF_HEADERS, CodeXref, XrefEntry, suggest_links
from .. import theme
from ..state import AppState
from ..widgets import Card, PageHeader, button

EXPRESS_FILTER = ("ไฟล์จาก Express (*.xlsx *.xls *.csv *.txt *.prn);;Excel (*.xlsx *.xls);;CSV (*.csv);;"
                  "รายงานข้อความ (*.txt *.prn)")


def _table(headers: list[str]) -> QTableWidget:
    t = QTableWidget(0, len(headers))
    t.setHorizontalHeaderLabels(headers)
    t.setAlternatingRowColors(True)
    t.setSelectionBehavior(QAbstractItemView.SelectRows)
    t.verticalHeader().setVisible(False)
    t.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
    t.horizontalHeader().setStretchLastSection(True)
    return t


class ExpressPage(QWidget):
    def __init__(self, state: AppState, actions, stock_page, sheets_page, parent=None):
        super().__init__(parent)
        self.state = state
        self.actions = actions
        self.stock_page = stock_page
        self.sheets_page = sheets_page
        s = state.settings
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
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(14)
        lay.addWidget(PageHeader(
            "Express (โปรแกรมบัญชี)",
            "นำเข้าทะเบียนสินค้า/ยอดคงเหลือจาก Express · ส่งออกร่างเอกสารเรียงตามหน้าจอ Express ให้สโตร์คีย์ "
            "· เทียบรหัสและยอดให้ตรงกันทั้งโปรแกรมนี้ Express และ Google Sheet"))

        top = QHBoxLayout()
        top.setSpacing(14)
        imp = Card("1. นำเข้าจาก Express")
        t = QLabel("• <b>4.สินค้า → รายละเอียดสินค้า</b> (หน้ารายการ) ส่งออกเป็น Excel/CSV<br>"
                   "• <b>6.รายงาน</b> เช่น สินค้าคงเหลือ / แบบฟอร์มตรวจนับ บันทึกเป็นไฟล์ข้อความ (.txt)<br>"
                   "<span style='color:%s'>รายงานแบบข้อความตัดรหัสที่ยาวเกิน 16 ตัว – ใช้ไฟล์ Excel "
                   "เมื่อต้องการรหัสเต็ม</span>" % theme.MUTED)
        t.setWordWrap(True)
        imp.body.addWidget(t)
        b = button("นำเข้าไฟล์จาก Express", "primary")
        b.clicked.connect(self.import_express)
        imp.body.addWidget(b)
        self.import_summary = QLabel("-")
        self.import_summary.setObjectName("Hint")
        self.import_summary.setWordWrap(True)
        imp.body.addWidget(self.import_summary)
        top.addWidget(imp, 1)

        exp = Card("2. ส่งออกเพื่อคีย์เข้า Express (ร่าง)")
        form = QGridLayout()
        self.warehouse = QLineEdit(s.get("express/warehouse", "01"))
        self.department = QLineEdit(s.get("express/department", ""))
        self.category = QLineEdit(s.get("express/category", "21"))
        self.account_group = QLineEdit(s.get("express/account_group", "ST01"))
        for i, (label, edit, key) in enumerate([("คลัง", self.warehouse, "warehouse"),
                                                ("สำหรับแผนก", self.department, "department"),
                                                ("หมวด (สินค้าใหม่)", self.category, "category"),
                                                ("กลุ่มบัญชี (สินค้าใหม่)", self.account_group, "account_group")]):
            form.addWidget(QLabel(label), i // 2, (i % 2) * 2)
            form.addWidget(edit, i // 2, (i % 2) * 2 + 1)
            edit.editingFinished.connect(lambda e=edit, k=key: s.set(f"express/{k}", e.text().strip()))
        exp.body.addLayout(form)
        row = QHBoxLayout()
        for text, slot, tip in (
                ("PD จ่ายวัตถุดิบเพื่อผลิต", self.export_pd, "รายการวัตถุดิบตามผลตรวจ × จำนวนคัน เรียงตามหน้าจอ PD"),
                ("ใบขอซื้อ (1.ซื้อ)", self.export_purchase, "รายการที่ขาด/ต่ำกว่า Min พร้อมจำนวนแนะนำ"),
                ("สินค้าใหม่ (4.สินค้า)", self.export_new_items, "รหัสใน Part List ที่ยังไม่มีใน Express")):
            b = button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        exp.body.addLayout(row)
        note = QLabel("ไฟล์เป็นร่างสำหรับคีย์ – Express ออกเลขที่เอกสารเอง และต้องตรวจก่อนบันทึก")
        note.setObjectName("Hint")
        exp.body.addWidget(note)
        top.addWidget(exp, 1)
        lay.addLayout(top)

        check = Card("3. ตรวจให้ข้อมูลตรงกัน")
        row = QHBoxLayout()
        for text, slot in (("ตรวจรหัส Part List ↔ Express", self.check_codes),
                           ("เทียบสต็อก Express ↔ Google Sheet", self.compare_with_sheet),
                           ("ส่งสต็อก Express ขึ้น Google Sheet", self.push_to_sheet)):
            b = button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        row.addStretch(1)
        check.body.addLayout(row)
        self.tabs = QTabWidget()
        self.result = _table(["รหัส", "ชื่อ", "สถานะ", "รายละเอียด"])
        for i, w in enumerate([160, 260, 150]):
            self.result.setColumnWidth(i, w)
        self.tabs.addTab(self.result, "ผลตรวจ")

        xref_tab = QWidget()
        xl = QVBoxLayout(xref_tab)
        row = QHBoxLayout()
        hint = QLabel("ชิ้นงานเดียวกันมีหลายรหัส เช่น Express/แบบ RRS-A-… กับไฟล์นับสต๊อค 01-0007-…: "
                      "ตารางนี้ทำให้ Part List หา ยอดคงเหลือ ได้จากทุกไฟล์")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        row.addWidget(hint, 1)
        for text, slot in (("สร้างจากชื่อสินค้า", self.suggest_xref), ("+ เพิ่ม", self.add_xref),
                           ("ลบ", self.remove_xref), ("นำเข้า…", self.import_xref), ("ส่งออก…", self.export_xref)):
            b = button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        xl.addLayout(row)
        self.xref_table = _table(XREF_HEADERS)
        for i, w in enumerate([170, 150, 280, 120]):
            self.xref_table.setColumnWidth(i, w)
        self.xref_table.itemChanged.connect(self._xref_edited)
        xl.addWidget(self.xref_table, 1)
        self.tabs.addTab(xref_tab, "ตารางเทียบรหัส")
        self.tabs.setMinimumHeight(380)
        check.body.addWidget(self.tabs, 1)
        lay.addWidget(check, 1)

        state.stock_changed.connect(self._summary)
        state.xref_changed.connect(self._show_xref)
        self._summary()
        self._show_xref()

    # ---- import ----------------------------------------------------------
    def import_express(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์จาก Express", self.state.settings.get("last_dir"),
                                              EXPRESS_FILTER)
        if not path:
            return
        self.state.settings.set("last_dir", str(Path(path).parent))
        try:
            stock, report = read_express_file(path)
        except Exception as exc:  # noqa: BLE001
            self.actions.error("อ่านไฟล์ไม่ได้", str(exc))
            return
        if not stock.items:
            self.actions.error("ไม่พบรายการสินค้า", "ไม่พบหัวตาราง รหัสสินค้า / ชื่อสินค้า หรือบรรทัดรายการในรายงาน")
            return
        name = f"Express: {Path(path).name}"
        self.state.add_stock_source(name, stock)
        added = self.state.xref.merge(self._suggestions())
        if added:
            self.state.set_xref(self.state.xref)
        title = f" ({report.title})" if report and report.title else ""
        self.state.notify(f"นำเข้า {len(stock.items)} รายการจาก Express{title}"
                          + (f" · จับคู่รหัสใหม่ {added} รายการ" if added else ""))

    def _summary(self) -> None:
        express = [(n, s) for n, s in self.state.stock_sources.items() if n.startswith("Express")]
        if not express:
            self.import_summary.setText("ยังไม่ได้นำเข้าข้อมูลจาก Express")
            return
        name, stock = express[-1]
        families: dict[str, int] = {}
        for item in stock.items:
            families[code_family(item.code)] = families.get(code_family(item.code), 0) + 1
        cut = sum(1 for i in stock.items if i.code_truncated)
        text = (f"{name}: {len(stock.items)} รายการ · กลุ่มรหัส "
                + ", ".join(f"{k} {v}" for k, v in sorted(families.items(), key=lambda kv: -kv[1])[:6]))
        if cut:
            text += f" · รหัสถูกตัดในรายงาน {cut} รายการ"
        if not stock.has_quantities:
            text += " · ไฟล์นี้ไม่มียอดคงเหลือ"
        self.import_summary.setText(text)

    def _express_stock(self) -> StockList:
        items = [i for n, s in self.state.stock_sources.items() if n.startswith("Express") for i in s.items]
        return StockList(items=items) if items else self.state.stock

    # ---- export ----------------------------------------------------------
    def _ensure_requirements(self) -> bool:
        if self.state.requirements:
            return True
        return self.stock_page.run_check(show=False)

    def export_pd(self) -> None:
        if not self._ensure_requirements():
            return
        path = self.actions.save_path("ร่าง PD จ่ายวัตถุดิบเพื่อผลิต", self.actions.default_name(".xlsx", "PD"),
                                      "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            n = export_pd_draft(self.state.partlist, self.state.requirements, path, self.warehouse.text().strip() or "01",
                                self.department.text().strip())
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({n} บรรทัด)")

    def export_purchase(self) -> None:
        if not self._ensure_requirements():
            return
        path = self.actions.save_path("ร่างใบขอซื้อ", self.actions.default_name(".xlsx", "PurchaseRequest"),
                                      "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            export_requirements(self.state.partlist, self.state.requirements, path, only_purchase=True)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def export_new_items(self) -> None:
        stock = self._express_stock()
        missing = new_items(self.state.partlist, stock)
        if not missing:
            self.state.notify("ทุกรหัสใน Part List มีใน Express แล้ว")
            return
        path = self.actions.save_path("สินค้าใหม่สำหรับเปิดใน Express", self.actions.default_name(".xlsx", "NewItems"),
                                      "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            n = export_new_items(self.state.partlist, stock, path, self.category.text().strip(),
                                 self.account_group.text().strip())
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({n} รหัส)")

    # ---- checks ----------------------------------------------------------
    def _fill_result(self, rows: list[tuple[str, str, str, str]], tab: int = 0) -> None:
        self.result.setRowCount(len(rows))
        for r, values in enumerate(rows):
            for c, text in enumerate(values):
                item = QTableWidgetItem(text)
                if c == 2:
                    ok = text in (SYNC_SAME, "ตรงกัน")
                    item.setForeground(theme.status_color("พร้อม" if ok else "ขาด" if "ไม่" in text else "รอสั่งซื้อ"))
                self.result.setItem(r, c, item)
        self.tabs.setCurrentIndex(tab)

    def check_codes(self) -> None:
        checks = check_part_codes(self.state.partlist, self._express_stock())
        self._fill_result([(c.part_no, c.name, c.status, c.detail or c.express_code) for c in checks])
        bad = sum(1 for c in checks if c.status != "ตรงกัน")
        self.state.notify(f"ตรวจรหัส {len(checks)} รายการ · ต้องตรวจ {bad} รายการ")

    def compare_with_sheet(self) -> None:
        page = self.sheets_page

        def done(rows):
            sheet_stock = StockList.from_rows(rows, source="Google Sheet")
            result = compare_stock(self._express_stock(), sheet_stock)
            self._fill_result([(r.code, r.name, r.status, r.detail) for r in result])
            diff = sum(1 for r in result if r.status != SYNC_SAME)
            self.state.notify(f"เทียบ {len(result)} รายการ · ไม่ตรงกัน/มีฝั่งเดียว {diff} รายการ")

        page._call(page.client().read_rows, done, page.url.text(), page.ws_stock.text())

    def push_to_sheet(self) -> None:
        page = self.sheets_page
        page._push(page.ws_stock.text(), self._express_stock().to_rows(), "ส่งสต็อก Express แล้ว")

    # ---- code table --------------------------------------------------------
    def _suggestions(self) -> list[XrefEntry]:
        express = self._express_stock()
        others = [s for n, s in self.state.stock_sources.items() if not n.startswith("Express")]
        out = []
        for other in others:
            out += suggest_links(express, other)
        return out

    def suggest_xref(self) -> None:
        added = self.state.xref.merge(self._suggestions())
        self.state.set_xref(self.state.xref)
        self.tabs.setCurrentIndex(1)
        self.state.notify(f"เพิ่มคู่รหัสจากชื่อสินค้า {added} รายการ (ตรวจแล้วติ๊ก ยืนยันแล้ว = Y)")

    def _show_xref(self) -> None:
        self.xref_table.blockSignals(True)
        rows = self.state.xref.to_rows()[1:]
        self.xref_table.setRowCount(len(rows))
        for r, values in enumerate(rows):
            for c, text in enumerate(values):
                self.xref_table.setItem(r, c, QTableWidgetItem(str(text)))
        self.xref_table.blockSignals(False)

    def _xref_edited(self, *args) -> None:
        rows = [[self.xref_table.item(r, c).text() if self.xref_table.item(r, c) else ""
                 for c in range(self.xref_table.columnCount())] for r in range(self.xref_table.rowCount())]
        self.state.xref = CodeXref.from_rows([XREF_HEADERS] + rows)
        self.state.save_library()
        self.state.stock_changed.emit()

    def add_xref(self) -> None:
        self.state.xref.entries.append(XrefEntry("", ""))
        self.state.set_xref(self.state.xref)
        self.tabs.setCurrentIndex(1)

    def remove_xref(self) -> None:
        rows = sorted({i.row() for i in self.xref_table.selectedIndexes()}, reverse=True)
        for r in rows:
            del self.state.xref.entries[r]
        self.state.set_xref(self.state.xref)

    def import_xref(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "นำเข้าตารางเทียบรหัส", self.state.settings.get("last_dir"),
                                              "ตาราง (*.xlsx *.xls *.csv)")
        if path:
            added = self.state.xref.merge(CodeXref.from_rows(read_table(path)).entries)
            self.state.set_xref(self.state.xref)
            self.state.notify(f"นำเข้าคู่รหัส {added} รายการ")

    def export_xref(self) -> None:
        path = self.actions.save_path("ส่งออกตารางเทียบรหัส", "ตารางเทียบรหัส.xlsx", "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            rows = self.state.xref.to_rows()
            write_table(path, rows[0], rows[1:], sheet_title="CodeXref")
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")
