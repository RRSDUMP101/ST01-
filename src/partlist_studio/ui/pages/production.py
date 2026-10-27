"""งานผลิต (SO) - jobs and the status of every part: รอตัด → รอพับ → รอเชื่อม → เสร็จ."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QDate, QItemSelectionModel, Qt
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDateEdit, QDialog, QDialogButtonBox, QDoubleSpinBox,
                               QGridLayout, QHBoxLayout, QInputDialog, QLabel, QLineEdit, QListWidget, QListWidgetItem,
                               QMenu, QMessageBox, QProgressBar, QSplitter, QTabWidget, QVBoxLayout, QWidget)

from ...core.catalog import (KIT_HEADERS, READINESS_HEADERS, export_kitting, job_readiness, job_ready_pct,
                             job_tickets, kitting_rows, readiness_rows)
from ...core.production import (DONE, FROM_STOCK, JOB_CANCELLED, JOB_STATUSES, STEPS, LogEntry, export_status,
                                job_documents, job_from_parts, wip_from_stock)
from ...core.qr import parse_payload
from ..state import AppState
from ..widgets import BarDelegate, PageHeader, StatusChipRow, button, empty_hint, fill, selected_rows, table

PART_COLS = ["ลำดับ", "รหัส", "ชิ้นส่วน", "ต้องใช้", "ใช้จากสต็อก", "ต้องผลิต", "ขั้นตอน", *STEPS, "สถานะ",
             "รับเข้าแล้ว", "%"]
STEP_COL0 = 7
CHIPS = ["รอตัด", "รอพับ", "รอเหยียบปิด", "รอเชื่อม", "รอกลึง", "รอทำสี", DONE, FROM_STOCK]
LINE_HEADERS = KIT_HEADERS[:-1]  # without the 'หยิบแล้ว' tick box of the printed picking list


class ProductionPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        header = PageHeader("งานผลิต (SO) – ติดตามสถานะรายชิ้น",
                            "เปิดงานจากแบบกระบะ × จำนวนคัน หรือจาก Part List · บันทึกจำนวนที่ผ่านแต่ละขั้น "
                            "(ตัด → พับ → เหยียบปิด → เชื่อม …) · สร้างใบเบิกวัตถุดิบ / ใบจ่ายชิ้นส่วน / ใบรับชิ้นงานเสร็จ")
        new = header.add_action(button("+ เปิดงานผลิต ▾", "primary", "งานใหม่ 1 งาน = 1 SO × จำนวนคัน"))
        menu = QMenu(new)
        menu.addAction("จาก Part List ปัจจุบัน (แบบที่เพิ่งนำเข้า)…", self.new_from_partlist)
        menu.addAction("จากแบบกระบะมาตรฐาน (เลือกรุ่นย่อย)…", lambda: self.actions.go("models"))
        new.setMenu(menu)
        exp = header.add_action(button("ส่งออก ▾", tooltip="สถานะการผลิตของงานที่เลือก หรือทุกงานที่ยังไม่ปิด เป็น Excel"))
        menu = QMenu(exp)
        menu.addAction("สถานะงานที่เลือก (Excel)…", lambda: self.export(False))
        menu.addAction("สถานะทุกงานที่ยังไม่ปิด (Excel)…", lambda: self.export(True))
        exp.setMenu(menu)
        lay.addWidget(header)

        split = QSplitter(Qt.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 8, 0)
        self.scan = QLineEdit()
        self.scan.setPlaceholderText("สแกนใบงาน (QR) / ค้นหารหัส แล้วกด Enter")
        self.scan.setClearButtonEnabled(True)
        self.scan.returnPressed.connect(self.scanned)
        ll.addWidget(self.scan)
        self.show_closed = QCheckBox("แสดงงานที่ปิดแล้ว")
        self.show_closed.toggled.connect(self.refresh)
        ll.addWidget(self.show_closed)
        self.list = QListWidget()
        self.list.setObjectName("Plain")
        self.list.setWordWrap(True)
        self.list.currentRowChanged.connect(self._show)
        empty_hint(self.list, "ยังไม่มีงาน – กด + เปิดงานผลิต ▾")
        ll.addWidget(self.list, 1)
        rm = button("ลบงาน", tooltip="ลบงานที่เลือกออกจากรายการ (ใบเบิก/รับที่บันทึกแล้วยังอยู่)")
        rm.clicked.connect(self.remove_job)
        ll.addWidget(rm)
        split.addWidget(left)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        self.caption = QLabel("ยังไม่มีงาน")
        self.caption.setObjectName("CardTitle")
        self.caption.setWordWrap(True)
        rl.addWidget(self.caption)
        grid = QGridLayout()
        self.customer = QLineEdit()
        self.customer.editingFinished.connect(self._info_edited)
        self.due = QDateEdit()
        self.due.setCalendarPopup(True)
        self.due.setDisplayFormat("dd/MM/yyyy")
        self.due.dateChanged.connect(self._info_edited)
        self.status = QComboBox()
        self.status.addItems(JOB_STATUSES)
        self.status.currentTextChanged.connect(self._info_edited)
        self.progress = QProgressBar()
        self.progress.setFormat("%p% เสร็จ")
        self.sets = QDoubleSpinBox()
        self.sets.setRange(1, 9999)
        self.sets.setDecimals(0)
        self.sets.setSuffix(" คัน")
        self.sets.setKeyboardTracking(False)
        self.sets.setToolTip("จำนวนคันของงานนี้ (แก้ที่นี่ที่เดียว) – ทุกชิ้นคิด จำนวนต่อคัน × คัน ใหม่ "
                             "ชิ้นที่ทำไปแล้วยังนับอยู่")
        self.sets.valueChanged.connect(self._sets_edited)
        for i, (label, w) in enumerate((("ลูกค้า", self.customer), ("กำหนดส่ง", self.due), ("สถานะงาน", self.status),
                                        ("จำนวนคัน", self.sets))):
            grid.addWidget(QLabel(label), 0, i * 2)
            grid.addWidget(w, 0, i * 2 + 1)
        grid.addWidget(self.progress, 0, 8)
        rl.addLayout(grid)
        self.chips = StatusChipRow(CHIPS, hide_zero=True)
        rl.addLayout(self.chips)

        tools = QHBoxLayout()
        for text, slot, tip, kind in (
                ("ผ่านขั้นถัดไป ▶", self.advance, "แถวที่เลือก: ชิ้นที่รออยู่ขั้นแรกผ่านขั้นนั้นทั้งหมด", ""),
                ("เสร็จทั้งหมด ✓", self.finish, "แถวที่เลือก: ผ่านทุกขั้น", ""),
                ("บันทึกจำนวน…", self.record_qty, "บันทึกจำนวนชิ้นที่ผ่านขั้นหนึ่ง", ""),
                ("แก้ขั้นตอน…", self.edit_route, "ขั้นตอนการผลิตของแถวที่เลือก", ""),
                ("พิมพ์ใบงาน (QR)…", self.print_tickets,
                 ("ใบงานต่อชิ้นส่วน: QR รูป 2D จากแบบ รหัส ขนาด ขั้นตอน และที่เก็บ (แถวที่เลือก หรือทุกชิ้นที่ต้องผลิต) · "
                  "เลือกจำนวนใบต่อแผ่นที่ช่องข้าง ๆ"), ""),
                ("สร้างใบเบิก/รับ (PD · FR)", self.make_documents,
                 "ร่าง PD วัตถุดิบ + PD จ่ายชิ้นส่วนประกอบ + FR รับชิ้นงานเสร็จ → ตรวจและบันทึกในหน้า เบิก/รับ สต็อก",
                 "accent")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            tools.addWidget(b)
            if slot == self.print_tickets:
                tools.addWidget(self._ticket_layout_box())
        tools.addStretch(1)
        rl.addLayout(tools)

        self.tabs = QTabWidget()
        self.parts = table(PART_COLS, [50, 170, 220, 60, 75, 65, 150] + [62] * len(STEPS) + [150, 75], editable=True)
        self.parts.itemChanged.connect(self._cell_edited)
        self.tabs.addTab(self.parts, "ชิ้นส่วน")
        self.tabs.addTab(self._readiness_tab(), "ความพร้อมประกอบ")
        self.log = table(["เวลา", "รหัส", "ชิ้นส่วน", "ขั้น", "จำนวน", "หมายเหตุ"], [130, 170, 240, 80, 70])
        empty_hint(self.log, "ยังไม่มีการบันทึก – กด ผ่านขั้นถัดไป / บันทึกจำนวน… หรือสแกนใบงาน (QR)")
        self.tabs.addTab(self.log, "บันทึกการทำงาน")
        self.wip = table(["รหัส", "รายการ", "รอขั้น", "จำนวน", "หมายเหตุ"], [140, 280, 90, 70])
        self.tabs.addTab(self.wip, "สถานะจากไฟล์นับสต๊อค")
        rl.addWidget(self.tabs, 1)
        split.addWidget(right)
        split.setSizes([300, 1000])
        lay.addWidget(split, 1)

        state.jobs_changed.connect(self.refresh)
        state.stock_changed.connect(self._show_wip)
        state.stock_changed.connect(self._show_readiness)
        state.catalog_changed.connect(self._show_readiness)
        self.refresh()
        self._show_wip()

    # ---------------------------------------------------------------------
    def _visible_jobs(self):
        return [j for j in self.state.jobs if self.show_closed.isChecked() or j.status not in ("ส่งมอบแล้ว", JOB_CANCELLED)]

    def refresh(self) -> None:
        jobs = self._visible_jobs()
        current = self._job()
        self.list.blockSignals(True)
        self.list.clear()
        for j in jobs:
            due = QDate.fromString(j.due, "yyyy-MM-dd").toString("dd/MM/yy") if j.due else "-"
            nb = "\u00a0"  # a short line that does not break in the middle of the date
            item = QListWidgetItem(f"{j.job_no}  ·  {j.progress:.0%}\n{j.model} × {j.sets:g} คัน\n"
                                   f"{j.status.replace(' ', nb)} · ส่ง{nb}{due}")
            item.setToolTip(f"{j.job_no} · {j.title or j.model} · {j.customer or '-'} · กำหนดส่ง {due}"
                            + (" (เลยกำหนด)" if j.overdue else ""))
            item.setData(Qt.UserRole, j.job_no)
            if j.overdue:
                item.setForeground(QBrush(QColor("#D64545")))
            self.list.addItem(item)
        self.list.blockSignals(False)
        names = [j.job_no for j in jobs]
        if jobs:
            self.list.setCurrentRow(names.index(current.job_no) if current and current.job_no in names else 0)
        self._show(self.list.currentRow())

    def _job(self):
        item = self.list.currentItem()
        if item is None:
            return None
        return next((j for j in self.state.jobs if j.job_no == item.data(Qt.UserRole)), None)

    def _show(self, _row: int = -1) -> None:
        job = self._job()
        if job is None:
            self.caption.setText("ยังไม่มีงาน – เปิดงานจากหน้า แบบกระบะ (สร้างงานผลิต) หรือจาก Part List ปัจจุบัน")
            self.parts.setRowCount(0)
            self.log.setRowCount(0)
            self._show_readiness()
            return
        self.caption.setText(f"{job.job_no} · {job.title or job.model}" + (f" · {job.variant}" if job.variant else "")
                             + f" · {job.sets:g} คัน" + (f" · เอกสาร {', '.join(job.docs)}" if job.docs else ""))
        for w, v in ((self.customer, job.customer),):
            w.blockSignals(True)
            w.setText(v)
            w.blockSignals(False)
        self.due.blockSignals(True)
        self.due.setDate(QDate.fromString(job.due, "yyyy-MM-dd") if job.due else QDate.currentDate())
        self.due.blockSignals(False)
        self.status.blockSignals(True)
        self.status.setCurrentText(job.status)
        self.status.blockSignals(False)
        self.sets.blockSignals(True)
        self.sets.setValue(job.sets)
        self.sets.blockSignals(False)
        self.progress.setValue(round(job.progress * 100))
        counts = {}
        for p in job.parts:
            for st in [p.status] if p.status in (DONE, FROM_STOCK) else [f"รอ{s}" for s in p.waiting()]:
                counts[st] = counts.get(st, 0) + 1
        self.chips.set_counts(counts)
        rows = []
        for p in job.parts:
            rows.append([p.item_no, p.code, p.name, p.required, p.from_stock, p.to_make, " → ".join(p.route),
                         *[p.done_at(s) if s in p.route else "" for s in STEPS], p.status_text, p.received,
                         f"{p.progress:.0%}"])
        fill(self.parts, rows, status_col=STEP_COL0 + len(STEPS))
        self.parts.blockSignals(True)
        for r, p in enumerate(job.parts):
            for c in range(self.parts.columnCount()):
                item = self.parts.item(r, c)
                step = STEPS[c - STEP_COL0] if STEP_COL0 <= c < STEP_COL0 + len(STEPS) else ""
                editable = bool(step) and step in p.route and p.to_make > 0
                item.setFlags(item.flags() | Qt.ItemIsEditable if editable else item.flags() & ~Qt.ItemIsEditable)
                if editable:
                    item.setBackground(QBrush(QColor("#FFF8E1")))
        self.parts.blockSignals(False)
        fill(self.log, [[e.when.replace("T", " "), e.code, e.name, e.step, e.qty, e.note] for e in reversed(job.log)])
        self._show_readiness()

    def _readiness_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 8, 0, 0)
        row = QHBoxLayout()
        self.ready_label = QLabel()
        self.ready_label.setObjectName("CardTitle")
        self.ready_label.setWordWrap(True)
        row.addWidget(self.ready_label, 1)
        b = button("ใบจัดชุด (Excel)…", "accent", "ใบหยิบชิ้นส่วนเข้าประกอบของงานนี้ แยกกลุ่ม พร้อมตำแหน่งเก็บ")
        b.clicked.connect(self.export_kitting)
        row.addWidget(b)
        lay.addLayout(row)
        split = QSplitter(Qt.Vertical)
        split.setChildrenCollapsible(False)
        self.ready_groups = table(READINESS_HEADERS, [170, 70, 70, 170, 70])
        self.ready_groups.setMinimumHeight(115)  # header + 3 groups on a 768 px screen
        self._bars = BarDelegate(self.ready_groups)
        self.ready_groups.setItemDelegateForColumn(3, self._bars)
        self.ready_groups.itemSelectionChanged.connect(self._show_ready_lines)
        split.addWidget(self.ready_groups)
        self.ready_lines = table(LINE_HEADERS, [130, 150, 200, 60, 60, 50, 95])
        self.ready_lines.setMinimumHeight(115)
        split.addWidget(self.ready_lines)
        split.setStretchFactor(0, 2)
        split.setStretchFactor(1, 3)
        split.setSizes([220, 380])
        lay.addWidget(split, 1)
        hint = QLabel("พร้อม = ใช้จากสต็อก + ผลิตผ่านครบทุกขั้น · ปล่อยประกอบชุดย่อยเมื่อกลุ่มนั้นครบ 100% · "
                      "กลุ่มประกอบ/ตำแหน่งเก็บตั้งได้ในหน้า สโตร์ → ชิ้นส่วนพร้อมประกอบ")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self._ready = []
        return w

    def _show_readiness(self) -> None:
        job = self._job()
        self._ready = job_readiness(job, self.state.catalog, self.state.stock) if job else []
        if job is None:
            self.ready_label.setText("ยังไม่มีงาน")
        else:
            done = sum(g.complete for g in self._ready)
            self.ready_label.setText(f"{job.job_no} · พร้อมประกอบ {job_ready_pct(self._ready):.0%} · "
                                     f"ครบ {done}/{len(self._ready)} กลุ่ม")
        fill(self.ready_groups, readiness_rows(self._ready), status_col=4)
        for r, g in enumerate(self._ready):
            self.ready_groups.item(r, 3).setData(BarDelegate.ROLE, 1.0 if g.complete else min(g.pct, 0.99))
        self._show_ready_lines()

    def _show_ready_lines(self) -> None:
        rows = selected_rows(self.ready_groups)
        groups = [self._ready[r] for r in rows if r < len(self._ready)] or self._ready
        fill(self.ready_lines, [line[:-1] for line in kitting_rows(groups)], status_col=len(LINE_HEADERS) - 1)

    def _show_wip(self) -> None:
        fill(self.wip, [[c, n, s, q if q is not None else "", note] for c, n, s, q, note in wip_from_stock(self.state.stock)],
             status_col=2)

    # ---------------------------------------------------------------------
    def _info_edited(self) -> None:
        job = self._job()
        if job is None:
            return
        job.customer = self.customer.text().strip()
        job.due = self.due.date().toString("yyyy-MM-dd")
        job.status = self.status.currentText()
        self.state.save_jobs()

    def _sets_edited(self, value: float) -> None:
        job = self._job()
        if job is None or value == job.sets:
            return
        old = job.set_sets(value)
        self.state.save_jobs()
        self.state.notify(f"{job.job_no}: จำนวนคัน {old:g} → {job.sets:g} · ทุกชิ้นคิดจำนวนใหม่แล้ว "
                          "(ชิ้นที่ทำไปแล้วยังนับอยู่)")

    def _cell_edited(self, item) -> None:
        job = self._job()
        c = item.column()
        if job is None or not STEP_COL0 <= c < STEP_COL0 + len(STEPS):
            return
        part, step = job.parts[item.row()], STEPS[c - STEP_COL0]
        try:
            value = float(item.text().replace(",", "") or 0)
        except ValueError:
            value = part.done_at(step)
        now = part.done_at(step)
        if value > now:
            job.record(part, step, value - now)
        elif value < now:  # correction: later steps cannot be above this one
            part.done[step] = max(0.0, value)
            i = part.route.index(step)
            for later in part.route[i + 1:]:
                part.done[later] = min(part.done_at(later), part.done[step])
            job.log.append(LogEntry(datetime.now().isoformat(timespec="minutes"), part.code, part.name, step,
                                    value - now, "แก้ไขจำนวน"))
        self.state.save_jobs()

    def _selected_parts(self):
        job = self._job()
        if job is None:
            return None, []
        rows = selected_rows(self.parts)
        return job, [job.parts[r] for r in rows]

    def advance(self) -> None:
        job, parts = self._selected_parts()
        if not parts:
            return
        n = 0
        for p in parts:
            waiting = p.waiting()
            if waiting:
                step, qty = next(iter(waiting.items()))
                n += bool(job.record(p, step, qty))
        self.state.save_jobs()
        self.state.notify(f"ผ่านขั้นถัดไป {n} รายการ")

    def finish(self) -> None:
        job, parts = self._selected_parts()
        if not parts:
            return
        for p in parts:
            job.record(p, DONE, 0, "เสร็จทั้งหมด")
        self.state.save_jobs()
        unreceived = job.unreceived()
        self.state.notify(f"เสร็จ {len(parts)} รายการ" + (f" · รอรับเข้าสต็อก {len(unreceived)} รายการ (สร้างใบ FR)"
                                                          if unreceived else ""))

    def record_qty(self) -> None:
        job, parts = self._selected_parts()
        if not parts:
            return
        dialog = QDialog(self)
        dialog.setWindowTitle("บันทึกจำนวนที่ผ่านขั้น")
        form = QGridLayout(dialog)
        step = QComboBox()
        step.addItems(sorted({s for p in parts for s in p.route}, key=STEPS.index))
        qty = QDoubleSpinBox()
        qty.setRange(0, 1e6)
        qty.setDecimals(0)
        qty.setValue(1)
        note = QLineEdit()
        for i, (label, w) in enumerate((("ขั้น", step), ("จำนวน (ต่อแถว)", qty), ("หมายเหตุ", note))):
            form.addWidget(QLabel(label), i, 0)
            form.addWidget(w, i, 1)
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        box.accepted.connect(dialog.accept)
        box.rejected.connect(dialog.reject)
        form.addWidget(box, 3, 0, 1, 2)
        if not dialog.exec():
            return
        taken = sum(job.record(p, step.currentText(), qty.value(), note.text()) for p in parts if step.currentText() in p.route)
        self.state.save_jobs()
        self.state.notify(f"บันทึก {step.currentText()} {taken:g} ชิ้น")

    def edit_route(self) -> None:
        job, parts = self._selected_parts()
        if not parts:
            return
        current = " → ".join(parts[0].route)
        text, ok = QInputDialog.getText(self, "ขั้นตอนการผลิต",
                                        "ขั้นตอน (คั่นด้วย , หรือ →) จาก: " + ", ".join(STEPS), text=current)
        if not ok:
            return
        route = [s.strip() for s in text.replace("→", ",").split(",") if s.strip() in STEPS]
        for p in parts:
            p.route = sorted(dict.fromkeys(route), key=STEPS.index)
            p.done = {s: q for s, q in p.done.items() if s in p.route}
        self.state.save_jobs()

    def make_documents(self) -> None:
        job = self._job()
        if job is None:
            return
        docs = job_documents(job, self.state.stock, self.state.ledger, self.state.raw_uses)
        if not docs:
            self.state.notify("ไม่มีรายการให้เบิก/รับ")
            return
        for doc in docs:
            doc.doc_no = self.state.ledger.next_no(doc.doc_type, doc.date)
            self.state.ledger.docs.append(doc)
            job.docs.append(doc.doc_no)
        self.state.save_jobs()
        self.state.ledger_changed.emit()
        raw = any(d.remark.startswith("วัตถุดิบ") for d in docs)
        self.state.notify(f"ร่างเอกสาร {', '.join(d.doc_no for d in docs)} – ตรวจแล้วกด บันทึก ในหน้า เบิก/รับ สต็อก"
                          + ("" if raw else " · ยังไม่มีใบเบิกวัตถุดิบ: กรอก 'วัตถุดิบต่อชิ้น' ในหน้า เบิก/รับ สต็อก"))
        self.actions.go("movements")

    # ---------------------------------------------------------------------
    def new_from_partlist(self) -> None:
        pl = self.state.partlist
        if not pl.parts:
            self.actions.error("ยังไม่มี Part List", "สร้างหรือนำเข้า Part List ก่อน")
            return
        job_no, ok = QInputDialog.getText(self, "เปิดงานจาก Part List", "เลขที่ SO / งาน:",
                                          text=pl.info.so_no or f"JOB-{len(self.state.jobs) + 1:03d}")
        if not ok or not job_no.strip():
            return
        if any(j.job_no == job_no.strip() for j in self.state.jobs):
            self.actions.error("เลขที่งานซ้ำ", f"มีงาน {job_no} แล้ว")
            return
        use_stock = QMessageBox.question(self, "ใช้สต็อก", "ใช้ชิ้นส่วนที่มีในสต็อกก่อน (ผลิตเฉพาะส่วนที่ขาด)?") \
            == QMessageBox.Yes
        info = pl.info
        job = job_from_parts(job_no.strip(), pl.parts, max(1, info.build_qty), self.state.stock, use_stock,
                             self.state.jobs, model=info.job_type or info.drawing_no, customer=info.customer,
                             vehicle=info.vehicle_model, title=" ".join(x for x in (info.job_type, info.vehicle_model) if x),
                             body=info.job_type, brand=info.vehicle_brand)
        self.state.jobs.append(job)
        self.state.save_jobs()
        self.state.notify(f"เปิดงาน {job.job_no} {len(job.parts)} รายการ")

    def remove_job(self) -> None:
        job = self._job()
        if job and QMessageBox.question(self, "ลบงาน", f"ลบงาน {job.job_no}? (เอกสารที่บันทึกแล้วยังอยู่)") == QMessageBox.Yes:
            self.state.jobs.remove(job)
            self.state.save_jobs()

    def export(self, all_open: bool) -> None:
        jobs = [j for j in self.state.jobs if j.status not in ("ส่งมอบแล้ว", JOB_CANCELLED)] if all_open else \
            [j for j in [self._job()] if j]
        if not jobs:
            return
        path = self.actions.save_path("สถานะการผลิต", f"สถานะการผลิต_{jobs[0].job_no if len(jobs) == 1 else 'ทุกงาน'}.xlsx",
                                      "Excel (*.xlsx);;CSV (*.csv)")
        if path:
            export_status(jobs, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    # ---- tickets, picking list, scan ---------------------------------------
    def _ticket_layout_box(self) -> QComboBox:
        """How many tickets per sheet: A6 paper/sticker, or 2 / 4 / 8 on A4 (remembered)."""
        from ..printing import TICKET_LAYOUT_TEXT

        self.ticket_layout = QComboBox()
        for per_page, text in TICKET_LAYOUT_TEXT.items():
            self.ticket_layout.addItem(text, per_page)
        self.ticket_layout.setToolTip("จำนวนใบงานต่อแผ่น: A6 = กระดาษ/สติกเกอร์ A6 · A4 = หลายใบต่อแผ่น มีเส้นประให้ตัด "
                                      "(4 ใบ = ขนาดเกือบเต็ม A6 · 8 ใบ = ใบเล็กลง)")
        saved = self.state.settings.get("tickets/per_page", "4")
        index = self.ticket_layout.findData(int(saved) if saved.isdigit() else 4)
        self.ticket_layout.setCurrentIndex(max(0, index))
        self.ticket_layout.currentIndexChanged.connect(
            lambda _i: self.state.settings.set("tickets/per_page", str(self.ticket_layout.currentData())))
        return self.ticket_layout

    def print_tickets(self) -> None:
        job = self._job()
        if job is None:
            return
        indexes = [r for r in selected_rows(self.parts) if r < len(job.parts)] or None
        tickets = job_tickets(job, indexes, self.state.catalog, self.state.stock, self.state.flats,
                              self.state.cut_queue.programs, self.state.xref_lookup)
        if not tickets:
            self.actions.error("ไม่มีใบงาน", "งานนี้ไม่มีชิ้นที่ต้องผลิต (ใช้จากสต็อกทั้งหมด)")
            return
        path = self.actions.save_path("ใบงาน (PDF)", f"ใบงาน_{job.job_no}.pdf", "PDF (*.pdf)")
        if not path:
            return
        from ..printing import TICKET_LAYOUT_TEXT, open_document, write_tickets_pdf

        per_page = self.ticket_layout.currentData() or 1
        n = write_tickets_pdf(path, tickets, per_page)
        sheets = -(-n // per_page)
        self.state.notify(f"บันทึก {Path(path).name} แล้ว ({n} ใบ · {TICKET_LAYOUT_TEXT[per_page]} = {sheets} แผ่น"
                          + (" · ตัดตามเส้นประ" if per_page > 1 else "") + " · สแกน QR ที่ช่อง สแกนใบงาน)")
        open_document(path)

    def export_kitting(self) -> None:
        job = self._job()
        if job is None:
            return
        path = self.actions.save_path("ใบจัดชุด", f"ใบจัดชุด_{job.job_no}.xlsx", "Excel (*.xlsx)")
        if path:
            export_kitting(job, job_readiness(job, self.state.catalog, self.state.stock), path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def scanned(self) -> None:
        """A scanned ticket (RRS1|J|job|line|…) opens the job and selects the part; other text finds codes."""
        text = self.scan.text().strip()
        if not text:
            return
        scan = parse_payload(text)
        if scan.kind == "job":
            job = next((j for j in self.state.jobs if j.job_no == scan.job_no), None)
            if job is None:
                self.actions.error("ไม่พบงาน", f"ไม่พบงาน {scan.job_no} ในโปรแกรม")
                return
            if job not in self._visible_jobs():
                self.show_closed.setChecked(True)
            self._select_job(job.job_no)
            index = scan.line - 1
            if not (0 <= index < len(job.parts) and (not scan.code or job.parts[index].code == scan.code)):
                index = next((i for i, p in enumerate(job.parts) if p.code == scan.code), -1)
            rows = [index] if index >= 0 else []
        else:
            job = self._job()
            if job is None:
                return
            needle = scan.code.lower()
            rows = [i for i, p in enumerate(job.parts) if needle in f"{p.code} {p.name}".lower()]
        self.tabs.setCurrentIndex(0)
        self.parts.clearSelection()
        selection = self.parts.selectionModel()
        for r in rows:
            selection.select(self.parts.model().index(r, 0), QItemSelectionModel.Select | QItemSelectionModel.Rows)
        if rows:
            self.parts.scrollToItem(self.parts.item(rows[0], 0))
            p = job.parts[rows[0]]
            self.state.notify(f"{job.job_no} · {p.code} {p.name} · {p.status_text}"
                              + (f" (+ อีก {len(rows) - 1} แถว)" if len(rows) > 1 else ""))
        else:
            self.state.notify(f"ไม่พบ '{text}' ในงาน {job.job_no}")
        self.scan.clear()

    def _select_job(self, job_no: str) -> None:
        for i in range(self.list.count()):
            if self.list.item(i).data(Qt.UserRole) == job_no:
                self.list.setCurrentRow(i)
                return
