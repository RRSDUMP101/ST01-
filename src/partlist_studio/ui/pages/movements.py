"""เบิก/รับ สต็อก - stock documents (PD / OU / FR / RR / AJ), movement history, raw material per part."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QDate, Qt
from PySide6.QtWidgets import (QComboBox, QDateEdit, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMenu,
                               QMessageBox, QSplitter, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from ...core.movements import (DOC_TYPES, HISTORY_HEADERS, ST_CANCELLED, ST_DRAFT, ST_POSTED, DocLine,
                               StockDoc, export_doc, export_history, history_rows, lines_from_parts,
                               lines_from_requirements)
from ...core.production import RAW_HEADERS, RawUse, mark_document, suggest_raw_uses
from ...core.stock import find_by_code
from ..state import AppState
from ..widgets import PageHeader, button, fill, selected_rows, table

LINE_COLS = ["รหัส", "รายละเอียด", "คลัง", "จำนวน", "หน่วย", "ราคาต่อหน่วย", "จำนวนเงิน", "หมายเหตุ"]


class MovementsPage(QWidget):
    def __init__(self, state: AppState, actions, stock_page, parent=None):
        super().__init__(parent)
        self.state, self.actions, self.stock_page = state, actions, stock_page
        self.doc: StockDoc | None = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        header = PageHeader("เบิก / รับ สต็อก และประวัติการเคลื่อนไหว",
                            "ใบเบิก/รับตามประเภทเอกสาร Express (PD จ่ายวัตถุดิบเพื่อผลิต · OU จ่ายใช้ภายใน · "
                            "FR รับสินค้าสำเร็จรูปจากการผลิต · RR รับสินค้า · AJ ปรับปรุงยอด) · บันทึกแล้วยอดในโปรแกรมเปลี่ยนทันที "
                            "และได้ร่างสำหรับคีย์เข้า Express")
        new = header.add_action(button("ใบใหม่ ▾", "primary"))
        menu = QMenu(new)
        for code, (name, _sign) in DOC_TYPES.items():
            menu.addAction(f"{code} – {name}", lambda c=code: self.new_doc(c))
        new.setMenu(menu)
        auto = header.add_action(button("จาก Part List × จำนวนคัน ▾"))
        menu = QMenu(auto)
        menu.addAction("PD เบิกวัตถุดิบ (ตามผลตรวจวัตถุดิบ)", self.from_requirements)
        menu.addAction("PD จ่ายชิ้นส่วนเพื่อประกอบ", lambda: self.from_partlist("PD"))
        menu.addAction("OU จ่ายใช้ภายใน", lambda: self.from_partlist("OU"))
        menu.addAction("FR รับชิ้นงานผลิตเสร็จเข้าสต็อก", lambda: self.from_partlist("FR"))
        auto.setMenu(menu)
        exp = header.add_action(button("ส่งออก ▾"))
        menu = QMenu(exp)
        menu.addAction("เอกสารที่เลือก (ร่างสำหรับคีย์ Express)…", self.export_doc)
        menu.addAction("ประวัติการเคลื่อนไหว (บัตรสินค้า)…", self.export_history)
        exp.setMenu(menu)
        lay.addWidget(header)

        self.tabs = QTabWidget()
        lay.addWidget(self.tabs, 1)

        # ---- documents
        docs_tab = QWidget()
        dl = QVBoxLayout(docs_tab)
        split = QSplitter(Qt.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 8, 0)
        self.filter = QComboBox()
        self.filter.addItems(["ทุกสถานะ", ST_DRAFT, ST_POSTED, ST_CANCELLED])
        self.filter.currentIndexChanged.connect(self.refresh)
        ll.addWidget(self.filter)
        self.docs = table(["เลขที่", "ประเภท", "วันที่", "งาน / SO", "สถานะ", "เลขที่ Express"], [105, 40, 80, 100, 80])
        self.docs.itemSelectionChanged.connect(self._doc_selected)
        ll.addWidget(self.docs, 1)
        split.addWidget(left)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        self.caption = QLabel("เลือกเอกสาร หรือสร้างใบใหม่")
        self.caption.setObjectName("CardTitle")
        rl.addWidget(self.caption)
        grid = QGridLayout()
        self.date = QDateEdit(QDate.currentDate())
        self.date.setCalendarPopup(True)
        self.date.setDisplayFormat("dd/MM/yyyy")
        self.job = QLineEdit()
        self.department = QLineEdit()
        self.remark = QLineEdit()
        self.express_no = QLineEdit()
        self.express_no.setPlaceholderText("เช่น PD0000503 (หลังคีย์เข้า Express)")
        for i, (label, w) in enumerate((("วันที่", self.date), ("งาน / SO", self.job), ("สำหรับแผนก", self.department),
                                        ("หมายเหตุ", self.remark), ("เลขที่ Express", self.express_no))):
            grid.addWidget(QLabel(label), i // 3, (i % 3) * 2)
            grid.addWidget(w, i // 3, (i % 3) * 2 + 1)
        rl.addLayout(grid)
        self.lines = table(LINE_COLS, [160, 300, 50, 70, 60, 90, 90], editable=True)
        self.lines.itemChanged.connect(self._line_edited)
        rl.addWidget(self.lines, 1)
        row = QHBoxLayout()
        for text, slot, kind in (("+ บรรทัด", self.add_line, ""), ("ลบบรรทัด", self.remove_lines, ""),
                                 ("ลบร่าง", self.delete_draft, ""), ("ยกเลิกเอกสาร", self.cancel_doc, ""),
                                 ("บันทึก (ตัด/รับสต็อก)", self.post_doc, "primary")):
            b = button(text, kind) if kind else button(text)
            b.clicked.connect(slot)
            if text.startswith("+"):
                row.addWidget(b)
            elif text == "ลบบรรทัด":
                row.addWidget(b)
                row.addStretch(1)
            else:
                row.addWidget(b)
        rl.addLayout(row)
        self.total = QLabel()
        self.total.setObjectName("Hint")
        rl.addWidget(self.total)
        split.addWidget(right)
        split.setSizes([460, 900])
        dl.addWidget(split)
        self.tabs.addTab(docs_tab, "เอกสาร")

        # ---- history
        hist = QWidget()
        hl = QVBoxLayout(hist)
        row = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("ค้นหา รหัส / ชื่อสินค้า / เลขที่เอกสาร / SO")
        self.search.textChanged.connect(self.show_history)
        self.type_filter = QComboBox()
        self.type_filter.addItems(["ทุกประเภท", *DOC_TYPES])
        self.type_filter.currentIndexChanged.connect(self.show_history)
        row.addWidget(self.search, 1)
        row.addWidget(self.type_filter)
        hl.addLayout(row)
        self.history = table(HISTORY_HEADERS, [80, 190, 105, 100, 100, 150, 240, 70, 70, 70, 50])
        hl.addWidget(self.history, 1)
        self.tabs.addTab(hist, "ประวัติการเคลื่อนไหว")

        # ---- raw material per part
        raw = QWidget()
        rwl = QVBoxLayout(raw)
        hint = QLabel("วัตถุดิบที่ใช้ต่อชิ้นงาน 1 ชิ้น (เช่น ฝาข้าง 1 ชิ้น ใช้เหล็กแผ่น 2.5 มม. 4x8 ฟุต 0.5 แผ่น) – "
                      "ใช้สร้างใบ PD เบิกวัตถุดิบจากงานผลิต · ปุ่ม แนะนำ อ่านจากหมายเหตุในชื่อแผ่นของ Express "
                      "(เช่น 'เหล็กแผ่นดำ 2.5 มม.4x8ฟุต(ฝาข้าง+ฝาท้าย)') แต่จำนวนต่อชิ้นต้องกรอกเอง "
                      "(หรือได้จากหน้า วางแผนตัดเหล็ก)")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        rwl.addWidget(hint)
        row = QHBoxLayout()
        for text, slot in (("แนะนำจากชื่อแผ่นใน Express", self.suggest_raw), ("+ เพิ่ม", self.add_raw),
                           ("ลบ", self.remove_raw)):
            b = button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        row.addStretch(1)
        rwl.addLayout(row)
        self.raw = table(RAW_HEADERS, [170, 220, 140, 300, 80, 60], editable=True)
        self.raw.itemChanged.connect(self._raw_edited)
        rwl.addWidget(self.raw, 1)
        self.tabs.addTab(raw, "วัตถุดิบต่อชิ้น")

        state.ledger_changed.connect(self.refresh)
        state.ledger_changed.connect(self.show_history)
        self.refresh()
        self.show_history()
        self.show_raw()

    # ---- documents -------------------------------------------------------------------------
    def refresh(self) -> None:
        wanted = self.filter.currentText()
        docs = [d for d in reversed(self.state.ledger.docs) if wanted == "ทุกสถานะ" or d.status == wanted]
        current = self.doc
        fill(self.docs, [[d.doc_no, d.doc_type, QDate.fromString(d.date, "yyyy-MM-dd").toString("dd/MM/yy"), d.job,
                          d.status, d.express_no] for d in docs], status_col=4, data=docs)
        if current in docs:
            self.docs.selectRow(docs.index(current))
        elif docs:
            self.docs.selectRow(0)
        else:
            self._show_doc(None)

    def _doc_selected(self) -> None:
        rows = selected_rows(self.docs)
        if rows:
            self._show_doc(self.docs.item(rows[0], 0).data(Qt.UserRole))

    def _show_doc(self, doc: StockDoc | None) -> None:
        self._save_header()
        self.doc = doc
        if doc is None:
            self.caption.setText("เลือกเอกสาร หรือสร้างใบใหม่")
            self.lines.setRowCount(0)
            self.total.setText("")
            return
        self.caption.setText(f"{doc.doc_no} · {doc.doc_type} {doc.type_name} · {doc.status}")
        self.date.setDate(QDate.fromString(doc.date, "yyyy-MM-dd"))
        for w, v in ((self.job, doc.job), (self.department, doc.department), (self.remark, doc.remark),
                     (self.express_no, doc.express_no)):
            w.setText(v)
        draft = doc.status == ST_DRAFT
        for w in (self.date, self.job, self.department, self.remark):
            w.setEnabled(draft)
        self._fill_lines()

    def _fill_lines(self) -> None:
        doc = self.doc
        fill(self.lines, [[ln.code, ln.name, ln.warehouse, ln.qty, ln.unit, ln.unit_cost, ln.amount, ln.remark]
                          for ln in doc.lines])
        if doc.status != ST_DRAFT:
            self.lines.blockSignals(True)
            for r in range(self.lines.rowCount()):
                for c in range(self.lines.columnCount()):
                    it = self.lines.item(r, c)
                    it.setFlags(it.flags() & ~Qt.ItemIsEditable)
            self.lines.blockSignals(False)
        sign = {1: "รับเข้า", -1: "จ่ายออก", 0: "ปรับยอด (+/-)"}[doc.sign]
        self.total.setText(f"{len(doc.lines)} บรรทัด · {sign} · รวม {sum(ln.qty for ln in doc.lines):,.2f} หน่วย"
                           f" · มูลค่า {doc.total:,.2f} บาท")

    def _save_header(self) -> None:
        doc = self.doc
        if doc is None:
            return
        doc.express_no = self.express_no.text().strip()
        if doc.status == ST_DRAFT:
            doc.date = self.date.date().toString("yyyy-MM-dd")
            doc.job, doc.department, doc.remark = (w.text().strip() for w in (self.job, self.department, self.remark))

    def _line_edited(self, item: QTableWidgetItem) -> None:
        doc = self.doc
        if doc is None or doc.status != ST_DRAFT or item.row() >= len(doc.lines):
            return
        line = doc.lines[item.row()]
        text = item.text().strip()
        key = ["code", "name", "warehouse", "qty", "unit", "unit_cost", None, "remark"][item.column()]
        if key is None:
            return
        if key in ("qty", "unit_cost"):
            try:
                setattr(line, key, float(text.replace(",", "") or 0))
            except ValueError:
                pass
        else:
            setattr(line, key, text)
        if key == "code":
            found = find_by_code(text, self.state.stock)
            if found:
                line.code, line.name, line.unit = found.code, found.name, found.unit_name
                line.unit_cost = line.unit_cost or found.unit_cost
        self._fill_lines()
        self.state.save_library()

    def new_doc(self, doc_type: str, lines: list[DocLine] | None = None, **kw) -> StockDoc:
        self._save_header()
        doc = self.state.ledger.new_doc(doc_type, lines or [], **kw)
        self.state.save_library()
        self.doc = doc
        self.filter.setCurrentIndex(0)
        self.refresh()
        self.tabs.setCurrentIndex(0)
        return doc

    def add_line(self) -> None:
        if self.doc and self.doc.status == ST_DRAFT:
            self.doc.lines.append(DocLine("", "", 1, "", self.state.settings.get("express/warehouse", "01") or "01"))
            self._fill_lines()

    def remove_lines(self) -> None:
        if self.doc and self.doc.status == ST_DRAFT:
            for r in reversed(selected_rows(self.lines)):
                del self.doc.lines[r]
            self._fill_lines()
            self.state.save_library()

    def delete_draft(self) -> None:
        doc = self.doc
        if doc and doc.status == ST_DRAFT and QMessageBox.question(self, "ลบร่าง", f"ลบ {doc.doc_no}?") == QMessageBox.Yes:
            self.state.ledger.docs.remove(doc)
            self.doc = None
            self.state.save_library()
            self.refresh()

    def post_doc(self) -> None:
        self._save_header()
        doc = self.doc
        if doc is None or doc.status != ST_DRAFT:
            return
        if not doc.lines:
            self.actions.error("ไม่มีรายการ", "เพิ่มบรรทัดก่อนบันทึก")
            return
        if QMessageBox.question(self, "บันทึกเอกสาร",
                                f"บันทึก {doc.doc_no} {doc.type_name} {len(doc.lines)} บรรทัด?\n"
                                "ยอดคงเหลือในโปรแกรมจะเปลี่ยนทันที") != QMessageBox.Yes:
            return
        warnings = self.state.post_doc(doc)
        job = next((j for j in self.state.jobs if j.job_no == doc.job), None)
        if job is not None:
            mark_document(job, doc)
            self.state.save_jobs()
        else:
            self.state.save_library()
        self.refresh()
        if warnings:
            QMessageBox.information(self, "บันทึกแล้ว", "\n".join(warnings[:30]))
        self.state.notify(f"บันทึก {doc.doc_no} แล้ว – ส่งออกร่างเพื่อคีย์เข้า Express ได้ที่ ส่งออก ▾")

    def cancel_doc(self) -> None:
        doc = self.doc
        if doc is None or doc.status == ST_CANCELLED:
            return
        if QMessageBox.question(self, "ยกเลิกเอกสาร", f"ยกเลิก {doc.doc_no}?"
                                + ("\nยอดที่ตัด/รับไปแล้วจะถูกคืน" if doc.status == ST_POSTED else "")) != QMessageBox.Yes:
            return
        self.state.cancel_doc(doc)
        self.state.save_library()
        self.refresh()

    # ---- from the Part List ---------------------------------------------------------------------
    def _info_kw(self) -> dict:
        info = self.state.partlist.info
        return {"job": info.so_no, "remark": " ".join(x for x in (info.job_type, info.vehicle_model,
                                                                  f"{info.build_qty} คัน") if x)}

    def from_requirements(self) -> None:
        if not self.state.partlist.parts:
            self.actions.error("ยังไม่มี Part List", "สร้างหรือนำเข้า Part List ก่อน")
            return
        if not self.state.requirements and not self.stock_page.run_check(show=False):
            return
        lines = lines_from_requirements(self.state.requirements, self.state.settings.get("express/warehouse", "01") or "01")
        if not lines:
            self.actions.error("ไม่มีวัตถุดิบที่เบิกได้", "ผลตรวจวัตถุดิบไม่มีรายการที่มีรหัสใน Express")
            return
        self.new_doc("PD", lines, **self._info_kw())
        self.state.notify(f"ร่าง PD เบิกวัตถุดิบ {len(lines)} บรรทัด")

    def from_partlist(self, doc_type: str) -> None:
        pl = self.state.partlist
        if not pl.parts:
            self.actions.error("ยังไม่มี Part List", "สร้างหรือนำเข้า Part List ก่อน")
            return
        lines = lines_from_parts(pl.parts, self.state.stock, self.state.settings.get("express/warehouse", "01") or "01",
                                 max(1, pl.info.build_qty))
        kw = self._info_kw()
        if doc_type in ("PD", "OU"):
            kw["remark"] = f"จ่ายชิ้นส่วนประกอบกระบะ {kw['remark']}"
        self.new_doc(doc_type, lines, **kw)

    # ---- exports ------------------------------------------------------------------------------
    def export_doc(self) -> None:
        self._save_header()
        if self.doc is None:
            return
        path = self.actions.save_path("ร่างเอกสารสำหรับ Express", f"{self.doc.doc_no}.xlsx", "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            export_doc(self.doc, path)
            self.state.save_library()
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def _movements(self):
        text = self.search.text().strip().lower()
        kind = self.type_filter.currentText()
        out = []
        for m in self.state.ledger.movements:
            if kind != "ทุกประเภท" and m.doc_type != kind:
                continue
            if text and not any(text in (v or "").lower() for v in (m.code, m.name, m.doc_no, m.job, m.express_no)):
                continue
            out.append(m)
        return out

    def show_history(self) -> None:
        fill(self.history, history_rows(list(reversed(self._movements()))))

    def export_history(self) -> None:
        path = self.actions.save_path("ประวัติการเคลื่อนไหว", "ประวัติการเคลื่อนไหวสินค้า.xlsx", "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            export_history(self._movements(), path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    # ---- raw material per part ---------------------------------------------------------------------
    def show_raw(self) -> None:
        names = {}
        for m in self.state.models:
            for r in m.rows:
                for c in r.codes:
                    names.setdefault(c, r.name)
        for j in self.state.jobs:
            for p in j.parts:
                names.setdefault(p.code, p.name)
        fill(self.raw, [[u.part_code, names.get(u.part_code, ""), u.raw_code, u.raw_name, u.qty, u.unit, u.source]
                        for u in self.state.raw_uses])

    def suggest_raw(self) -> None:
        express = self.state.express_stock() or self.state.stock
        parts = [p for j in self.state.jobs for p in j.parts] or list(self.state.partlist.parts)
        known = {(u.part_code, u.raw_code) for u in self.state.raw_uses}
        added = [u for u in suggest_raw_uses(parts, express) if (u.part_code, u.raw_code) not in known and u.part_code]
        seen = set()
        for u in added:
            if (u.part_code, u.raw_code) not in seen:
                seen.add((u.part_code, u.raw_code))
                self.state.raw_uses.append(u)
        self.state.save_library()
        self.show_raw()
        self.state.notify(f"แนะนำวัตถุดิบ {len(seen)} รายการ – กรอกช่อง ใช้ต่อชิ้น")

    def add_raw(self) -> None:
        self.state.raw_uses.append(RawUse("", ""))
        self.show_raw()

    def remove_raw(self) -> None:
        for r in reversed(selected_rows(self.raw)):
            del self.state.raw_uses[r]
        self.state.save_library()
        self.show_raw()

    def _raw_edited(self, item: QTableWidgetItem) -> None:
        r = item.row()
        if r >= len(self.state.raw_uses):
            return
        u = self.state.raw_uses[r]
        key = ["part_code", None, "raw_code", "raw_name", "qty", "unit", "source"][item.column()]
        if key is None:
            return
        text = item.text().strip()
        if key == "qty":
            try:
                u.qty = float(text.replace(",", "") or 0)
            except ValueError:
                return
        else:
            setattr(u, key, text)
        if key == "raw_code":
            found = find_by_code(text, self.state.stock)
            if found:
                u.raw_code, u.raw_name, u.unit = found.code, found.name, found.unit_name
                self.show_raw()
        u.source = u.source or "กรอกเอง"
        self.state.save_library()

