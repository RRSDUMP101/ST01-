"""งานผลิต (SO) - jobs and the status of every part: รอตัด → รอพับ → รอเชื่อม → เสร็จ."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QDate, Qt
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDateEdit, QDialog, QDialogButtonBox, QDoubleSpinBox,
                               QGridLayout, QHBoxLayout, QInputDialog, QLabel, QLineEdit, QListWidget, QListWidgetItem,
                               QMenu, QMessageBox, QProgressBar, QSplitter, QTabWidget, QVBoxLayout, QWidget)

from ...core.production import (DONE, FROM_STOCK, JOB_CANCELLED, JOB_STATUSES, STEPS, LogEntry, export_status,
                                job_documents, job_from_parts, wip_from_stock)
from ..state import AppState
from ..widgets import PageHeader, StatusChipRow, button, fill, selected_rows, table

PART_COLS = ["ลำดับ", "รหัส", "ชิ้นส่วน", "ต้องใช้", "ใช้จากสต็อก", "ต้องผลิต", "ขั้นตอน", *STEPS, "สถานะ",
             "รับเข้าแล้ว", "%"]
STEP_COL0 = 7
CHIPS = ["รอตัด", "รอพับ", "รอเหยียบปิด", "รอเชื่อม", "รอกลึง", "รอทำสี", DONE, FROM_STOCK]


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
        b = header.add_action(button("+ งานจากแบบกระบะ", "primary", "เลือกแบบในหน้า แบบกระบะ แล้วกด สร้างงานผลิต"))
        b.clicked.connect(lambda: self.actions.go("models"))
        b = header.add_action(button("+ งานจาก Part List ปัจจุบัน"))
        b.clicked.connect(self.new_from_partlist)
        exp = header.add_action(button("ส่งออก ▾"))
        menu = QMenu(exp)
        menu.addAction("สถานะงานที่เลือก (Excel)…", lambda: self.export(False))
        menu.addAction("สถานะทุกงานที่ยังไม่ปิด (Excel)…", lambda: self.export(True))
        exp.setMenu(menu)
        lay.addWidget(header)

        split = QSplitter(Qt.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 8, 0)
        self.show_closed = QCheckBox("แสดงงานที่ปิดแล้ว")
        self.show_closed.toggled.connect(self.refresh)
        ll.addWidget(self.show_closed)
        self.list = QListWidget()
        self.list.setObjectName("Plain")
        self.list.setWordWrap(True)
        self.list.currentRowChanged.connect(self._show)
        ll.addWidget(self.list, 1)
        rm = button("ลบงาน")
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
        for i, (label, w) in enumerate((("ลูกค้า", self.customer), ("กำหนดส่ง", self.due), ("สถานะงาน", self.status))):
            grid.addWidget(QLabel(label), 0, i * 2)
            grid.addWidget(w, 0, i * 2 + 1)
        grid.addWidget(self.progress, 0, 6)
        rl.addLayout(grid)
        self.chips = StatusChipRow(CHIPS, hide_zero=True)
        rl.addLayout(self.chips)

        tools = QHBoxLayout()
        for text, slot, tip, kind in (
                ("ผ่านขั้นถัดไป ▶", self.advance, "แถวที่เลือก: ชิ้นที่รออยู่ขั้นแรกผ่านขั้นนั้นทั้งหมด", ""),
                ("เสร็จทั้งหมด ✓", self.finish, "แถวที่เลือก: ผ่านทุกขั้น", ""),
                ("บันทึกจำนวน…", self.record_qty, "บันทึกจำนวนชิ้นที่ผ่านขั้นหนึ่ง", ""),
                ("แก้ขั้นตอน…", self.edit_route, "ขั้นตอนการผลิตของแถวที่เลือก", ""),
                ("สร้างใบเบิก/รับ (PD · FR)", self.make_documents,
                 "ร่าง PD วัตถุดิบ + PD จ่ายชิ้นส่วนประกอบ + FR รับชิ้นงานเสร็จ → ตรวจและบันทึกในหน้า เบิก/รับ สต็อก",
                 "accent")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            tools.addWidget(b)
        tools.addStretch(1)
        rl.addLayout(tools)

        self.tabs = QTabWidget()
        self.parts = table(PART_COLS, [50, 170, 220, 60, 75, 65, 150] + [62] * len(STEPS) + [150, 75], editable=True)
        self.parts.itemChanged.connect(self._cell_edited)
        self.tabs.addTab(self.parts, "ชิ้นส่วน")
        self.log = table(["เวลา", "รหัส", "ชิ้นส่วน", "ขั้น", "จำนวน", "หมายเหตุ"], [130, 170, 240, 80, 70])
        self.tabs.addTab(self.log, "บันทึกการทำงาน")
        self.wip = table(["รหัส", "รายการ", "รอขั้น", "จำนวน", "หมายเหตุ"], [140, 280, 90, 70])
        self.tabs.addTab(self.wip, "สถานะจากไฟล์นับสต๊อค")
        rl.addWidget(self.tabs, 1)
        split.addWidget(right)
        split.setSizes([300, 1000])
        lay.addWidget(split, 1)

        state.jobs_changed.connect(self.refresh)
        state.stock_changed.connect(self._show_wip)
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
            item = QListWidgetItem(f"{j.job_no}\n{j.model} × {j.sets:g} คัน\n{j.progress:.0%} · {j.status} · ส่ง {due}")
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
                             vehicle=info.vehicle_model, title=" ".join(x for x in (info.job_type, info.vehicle_model) if x))
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

