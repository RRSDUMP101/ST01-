"""คู่มือติดตั้ง Ford Ranger Super Duty: ข้อมูลงาน → ผลตรวจตาม BEMM → ขั้นตอนติดตั้ง (เช็กลิสต์) → ใบขั้นตอนพิมพ์ได้."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QPageSize, QPdfWriter, QTextDocument
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout, QGridLayout, QGroupBox, QHBoxLayout,
                               QLabel, QLineEdit, QSpinBox, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from ...core import install_manual as im
from .. import theme
from ..state import AppState
from ..widgets import PageHeader, StatusChipRow, button, fill, table
from .oem_parts import OemPartsTab

# field of InstallJob → (label, kind, (min, max), suffix) – kind: int · float · bool · text · combo name
FORM = {
    "งาน & รถ": [
        ("job_no", "เลขที่งาน / SO", "text"), ("customer", "ลูกค้า", "text"), ("vin", "VIN", "text"),
        ("cab", "รุ่นเก๋ง", "cab"), ("product", "ผลิตภัณฑ์ RRS", "product"),
        ("tub_removed", "ถอดกระบะ/ไฟท้ายเดิม (Cab-Chassis)", "bool"),
        ("parking_sensors", "มีเซนเซอร์ถอย", "bool"), ("aux_battery", "ติดแบตเตอรี่สำรอง", "bool"),
    ],
    "ขนาดตัวถัง (มม.)": [
        ("body_length", "ยาว", "int", (0, 7000)), ("body_width", "กว้าง", "int", (0, 3000)),
        ("body_height", "สูงเหนือหลังแชสซี", "int", (0, 4000)), ("cab_gap", "ช่องห่างหลังเก๋ง", "int", (0, 500)),
        ("cab_top_gap", "ช่องห่างเหนือหลังคาเก๋ง", "int", (0, 500)),
    ],
    "น้ำหนัก & จุด CG": [
        ("body_mass", "น้ำหนักตัวถัง (กก.)", "float", (0, 5000)), ("payload", "น้ำหนักบรรทุก (กก.)", "float", (0, 5000)),
        ("cg_x", "CG หลังศูนย์เพลาหน้า (มม.)", "int", (0, 7000)), ("cg_z", "CG สูงเหนือแชสซี (มม.)", "int", (0, 3000)),
        ("cg_y", "CG เยื้องข้าง (มม.)", "int", (-1000, 1000)),
        ("kerb_front", "ชั่งรถเปล่า เพลาหน้า (กก.)", "float", (0, 5000)),
        ("kerb_rear", "ชั่งรถเปล่า เพลาหลัง (กก.)", "float", (0, 5000)), ("passengers", "ผู้โดยสาร (คน)", "int", (0, 5)),
    ],
    "การยึด": [
        ("bolt_size", "ขนาดสลักยึดแท่น", "bolt_size"), ("bolt_grade", "เกรดสลัก", "bolt_grade"),
        ("all_mounts_used", "ใช้จุดยึดแชสซีครบทุกจุด", "bool"), ("rigid_subframe", "ซับเฟรมแข็งมาก (ตู้/ถัง)", "bool"),
        ("frame_holes", "รูเจาะเพิ่มบนแชสซี (รู)", "int", (0, 50)),
        ("frame_hole_dia", "ขนาดรูใหญ่สุด (มม.)", "float", (0, 40)),
        ("holes_in_vertical_line", "รูในแนวดิ่งเดียวกัน", "int", (0, 10)), ("welded_frame", "มีงานเชื่อมแชสซี", "bool"),
    ],
    "ไฟ & เซนเซอร์ (มม.)": [
        ("lamp_low", "ไฟท้าย: พื้น → ขอบล่าง", "int", (0, 3000)), ("lamp_high", "ไฟท้าย: พื้น → ขอบบน", "int", (0, 3000)),
        ("lamp_from_edge", "ขอบนอกรถ → โคม", "int", (0, 1500)), ("plate_height", "ป้ายทะเบียนหลัง สูงสุด", "int", (0, 3000)),
        ("sensor_x", "เซนเซอร์ถอย X", "int", (0, 2000)), ("sensor_y", "เซนเซอร์ถอย Y", "int", (0, 2000)),
        ("sensor_z", "เซนเซอร์ถอย Z", "int", (0, 2000)),
    ],
    "ลากจูง": [
        ("tow_hitch", "ชุดลาก", "hitch"), ("trailer_tare", "หางลากเปล่า (กก.)", "float", (0, 10000)),
        ("trailer_load", "บรรทุกบนหาง (กก.)", "float", (0, 10000)),
        ("towball_load", "น้ำหนักกดลูกบอล (กก.)", "float", (0, 2000)),
        ("towball_limit", "พิกัดกดลูกบอล ตาม Owner Guide (กก.)", "float", (0, 2000)),
        ("trailer_led_ma", "ไฟ LED หาง กระแสต่ำสุด (mA)", "int", (0, 20000)),
    ],
}
COMBOS = {
    "cab": [(c.name, k) for k, c in im.CABS.items()],
    "product": [(p.name, k) for k, p in im.PRODUCTS.items()],
    "bolt_size": [(s, s) for s in im.BOLT_SIZES],
    "bolt_grade": [(g, g) for g in im.BOLT_GRADES],
    "hitch": [("ไม่มี", ""), ("3.5T – ลูกบอล Ø50", "3.5T"), ("4.5T – ลูกบอล Ø70", "4.5T")],
}
FINDING_HEADERS = ["หัวข้อ", "ข้อกำหนด", "ค่าจริง", "เกณฑ์", "ผล", "BEMM"]
STEP_HEADERS = ["#", "ขั้นตอน", "รายละเอียด / คำเตือน", "แรงขัน", "ค่าที่ต้องวัด", "ค่าที่วัดได้", "เสร็จ", "ผล", "BEMM"]
COL_VALUE, COL_DONE, COL_STATE = 5, 6, 7


class InstallPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.job = im.InstallJob()
        self.job.apply_product()
        self.path = ""
        self.findings: list[im.Finding] = []
        self.steps: list[im.Step] = []
        self.inputs: dict[str, QWidget] = {}
        self._loading = False

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 18, 24, 18)
        head = PageHeader("คู่มือติดตั้ง – Ford Ranger Super Duty",
                          f"ตรวจงานติดตั้งกระบะ / ตู้ / หางลาก ตาม {im.BEMM_DOC} แล้วทำตามขั้นตอนพร้อมบันทึกค่าที่วัด")
        for text, slot, kind, tip in (
                ("งานใหม่", self.new_job, "", "เริ่มงานติดตั้งคันใหม่"),
                ("เปิด…", self.open_job, "", "เปิดไฟล์งานติดตั้ง (.rrsinst)"),
                ("บันทึก…", self.save_job, "", "บันทึกงานพร้อมเช็กลิสต์ (.rrsinst)"),
                ("ใบขั้นตอน PDF", lambda: self.export("pdf"), "primary", "ใบขั้นตอนติดตั้ง + ผลตรวจ + ช่องเซ็น")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            head.add_action(b)
        lay.addWidget(head)
        self.verdict = QLabel()
        self.verdict.setObjectName("Hint")
        self.verdict.setWordWrap(True)
        lay.addWidget(self.verdict)

        self.tabs = QTabWidget()
        self.tabs.addTab(self._form_tab(), "ข้อมูลงาน")
        self.tabs.addTab(self._findings_tab(), "ผลตรวจ BEMM")
        self.tabs.addTab(self._steps_tab(), "ขั้นตอนติดตั้ง")
        self.tabs.addTab(self._reference_tab(), "ข้อมูลอ้างอิง")
        self.oem = OemPartsTab(state)
        self.tabs.addTab(self.oem, "อะไหล่ Ford OEM")
        lay.addWidget(self.tabs, 1)
        self.load_job(self.job)

    # ---- tabs -------------------------------------------------------------
    def _form_tab(self) -> QWidget:
        w = QWidget()
        grid = QGridLayout(w)
        grid.setContentsMargins(4, 10, 4, 4)
        for n, (title, entries) in enumerate(FORM.items()):
            box = QGroupBox(title.replace("&", "&&"))
            form = QFormLayout(box)
            for entry in entries:
                name, label, kind = entry[:3]
                widget = self._input(kind, entry[3] if len(entry) > 3 else None)
                self.inputs[name] = widget
                form.addRow(label, widget)
            if title == "งาน & รถ":
                std = button("ใช้ขนาดมาตรฐานของผลิตภัณฑ์", tooltip="ใส่ ยาว/กว้าง/สูง ตามแบบ RRS ของผลิตภัณฑ์ที่เลือก")
                std.clicked.connect(self.apply_product)
                form.addRow("", std)
            grid.addWidget(box, n // 2, n % 2)
        return w

    def _input(self, kind: str, rng) -> QWidget:
        if kind == "text":
            w = QLineEdit()
            w.textChanged.connect(self._changed)
        elif kind == "bool":
            w = QCheckBox()
            w.toggled.connect(self._changed)
        elif kind in COMBOS:
            w = QComboBox()
            for text, value in COMBOS[kind]:
                w.addItem(text, value)
            w.currentIndexChanged.connect(self._changed)
        else:
            w = QSpinBox() if kind == "int" else QDoubleSpinBox()
            if kind == "float":
                w.setDecimals(1)
            w.setRange(*(rng or (0, 99999)))
            w.setGroupSeparatorShown(True)
            w.valueChanged.connect(self._changed)
        return w

    def _findings_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.chips = StatusChipRow(im.FINDING_STATES)
        lay.addLayout(self.chips)
        self.ftable = table(FINDING_HEADERS, [130, 470, 110, 120, 80, 90])
        self.ftable.setWordWrap(True)
        lay.addWidget(self.ftable, 1)
        return w

    def _steps_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        row = QHBoxLayout()
        self.progress = QLabel()
        row.addWidget(self.progress, 1)
        self.by = QLineEdit()
        self.by.setPlaceholderText("ชื่อช่างที่บันทึก")
        self.by.setMaximumWidth(200)
        row.addWidget(QLabel("ผู้บันทึก"))
        row.addWidget(self.by)
        lay.addLayout(row)
        self.stable = table(STEP_HEADERS, [36, 230, 420, 150, 160, 90, 50, 70, 90], editable=True)
        self.stable.setWordWrap(True)
        self.stable.itemChanged.connect(self._step_edited)
        lay.addWidget(self.stable, 1)
        hint = QLabel("ติ๊กช่อง เสร็จ เมื่อทำขั้นตอนนั้นแล้ว · พิมพ์ค่าที่วัดได้ในช่อง ค่าที่วัดได้ – ค่านอกเกณฑ์จะขึ้น ไม่ผ่าน")
        hint.setObjectName("Hint")
        lay.addWidget(hint)
        return w

    def _reference_tab(self) -> QWidget:
        w = QWidget()
        lay = QGridLayout(w)
        v = im.VEHICLE
        spec = [("ฐานล้อ", f"{v.wheelbase} มม."), ("ความกว้างตัวรถ / รวมกระจก", f"{v.width_no_mirrors} / {v.width_mirrors} มม."),
                ("GVM / เพลาหน้า / เพลาหลัง", f"{v.gvm:,} / {v.fgawr:,} / {v.rgawr:,} กก."), ("GCM", f"{v.gcm:,} กก."),
                ("ยื่นหลังสูงสุด (50 % ฐานล้อ)", f"{int(v.wheelbase * v.max_overhang_ratio)} มม."),
                ("ความสูงตัวถังเหนือแชสซี", f"≤ {v.max_body_height} มม."), ("ช่องห่างหลังเก๋ง", f"≥ {v.cab_gap_min} มม."),
                ("รูเจาะแชสซีสูงสุด", f"Ø {v.max_frame_hole} มม."), ("น็อตล้อ", f"{v.wheel_nut_torque} Nm (ขันแบบดาว)"),
                ("เครื่องยนต์", v.engine)]
        spec += [(f"{c.name}: แชสซีหลังเก๋ง / ยาวพื้นสูงสุด / กว้างสูงสุด",
                  f"{c.frame_behind_cab} / {c.max_load_length} / {c.max_body_width} มม.") for c in im.CABS.values()]
        t1 = table(["รายการ", "ค่า (BEMM)"], [380, 260])
        fill(t1, [list(x) for x in spec])
        t2 = table(["ขนาด", "เกรด 8.8 (Nm)", "เกรด 10.9 (Nm)"], [60, 110, 110])
        fill(t2, [[s, f"{g['8.8'][1]:g}–{g['8.8'][0]:g}", f"{g['10.9'][1]:g}–{g['10.9'][0]:g}"] for s, g in im.TORQUE.items()])
        t3 = table(["สัญญาณ", "สาย", "สูงสุด", "ตำแหน่ง", "BEMM"], [260, 230, 120, 230, 100])
        fill(t3, [list(x) for x in im.WIRES])
        for title, t, pos in (("ข้อมูลรถ", t1, (0, 0, 1, 1)), ("แรงขันแนะนำ (1.12)", t2, (0, 1, 1, 1)),
                              ("สายสัญญาณสำหรับผู้ติดตั้ง (4.x)", t3, (1, 0, 1, 2))):
            box = QGroupBox(title)
            QVBoxLayout(box).addWidget(t)
            lay.addWidget(box, *pos)
        lay.setColumnStretch(0, 2)
        lay.setColumnStretch(1, 1)
        return w

    # ---- job <-> form -----------------------------------------------------
    def load_job(self, job: im.InstallJob) -> None:
        self.job = job
        self._loading = True
        for name, w in self.inputs.items():
            value = getattr(job, name)
            if isinstance(w, QLineEdit):
                w.setText(str(value))
            elif isinstance(w, QCheckBox):
                w.setChecked(bool(value))
            elif isinstance(w, QComboBox):
                w.setCurrentIndex(max(0, w.findData(value)))
            else:
                w.setValue(value)
        self._loading = False
        self.refresh()

    def read_form(self) -> None:
        for name, w in self.inputs.items():
            if isinstance(w, QLineEdit):
                value = w.text().strip()
            elif isinstance(w, QCheckBox):
                value = w.isChecked()
            elif isinstance(w, QComboBox):
                value = w.currentData()
            else:
                value = w.value()
            setattr(self.job, name, value)

    def _changed(self, *_args) -> None:
        if not self._loading:
            self.read_form()
            self.refresh()

    def apply_product(self) -> None:
        self.read_form()
        self.job.apply_product()
        self.load_job(self.job)

    # ---- results ----------------------------------------------------------
    def refresh(self) -> None:
        self.findings = im.check(self.job)
        counts = im.summary(self.findings)
        fill(self.ftable, [[f.topic, f.text, f.value, f.limit, f.status, f.ref] for f in self.findings], status_col=4)
        self.ftable.resizeRowsToContents()
        self.chips.set_counts(counts)
        fails = [f for f in self.findings if f.status == im.FAIL]
        if fails:
            self.verdict.setText("❌  ไม่ผ่านตาม BEMM: " + " · ".join(f"{f.text.split(' – ')[0]} ({f.value} / {f.limit})"
                                                                for f in fails[:4]))
            self.verdict.setStyleSheet(f"color:{theme.status_color(im.FAIL).name()}; font-weight:bold;")
        else:
            self.verdict.setText(f"✔  ไม่มีข้อที่ไม่ผ่าน · ต้องตรวจเพิ่ม {counts[im.WARN]} ข้อ – "
                                 f"{self.job.cab_spec.name} + {self.job.product_spec.name}")
            self.verdict.setStyleSheet(f"color:{theme.status_color(im.PASS).name()}; font-weight:bold;")
        self._fill_steps()

    def _fill_steps(self) -> None:
        self.steps = im.procedure(self.job)
        t = self.stable
        t.blockSignals(True)
        t.setRowCount(len(self.steps))
        for r, s in enumerate(self.steps):
            rec = self.job.record.get(s.id, {})
            detail = s.detail + (f"\n⚠ {s.warning}" if s.warning else "")
            measure = ""
            if s.measure:
                lim = " ".join(x for x in (f"≥ {s.measure.lo:g}" if s.measure.lo is not None else "",
                                           f"≤ {s.measure.hi:g}" if s.measure.hi is not None else "") if x)
                measure = f"{s.measure.label} {lim} {s.measure.unit}"
            cells = [str(r + 1), f"{s.phase.split(' ', 1)[0]} {s.title}", detail, s.torque, measure,
                     rec.get("value", ""), "", "", s.ref]
            for c, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if c != COL_VALUE:
                    item.setFlags(item.flags() & ~Qt.ItemIsEditable)
                if c == COL_VALUE and not s.measure:
                    item.setFlags(item.flags() & ~Qt.ItemIsEditable)
                if c == COL_DONE:
                    item.setFlags((item.flags() | Qt.ItemIsUserCheckable) & ~Qt.ItemIsEditable)
                    item.setCheckState(Qt.Checked if rec.get("done") else Qt.Unchecked)
                if c == 0:
                    item.setData(Qt.UserRole, s.id)
                t.setItem(r, c, item)
            self._paint_state(r, s)
        t.blockSignals(False)
        t.resizeRowsToContents()
        done, total = im.progress(self.job)
        self.progress.setText(f"ทำแล้ว {done} / {total} ขั้นตอน · {self.job.product_spec.name} บน {self.job.cab_spec.name}")

    def _paint_state(self, row: int, step: im.Step) -> None:
        st = im.step_state(self.job, step)
        item = self.stable.item(row, COL_STATE)
        if item is None:
            item = QTableWidgetItem()
            item.setFlags(item.flags() & ~Qt.ItemIsEditable)
            self.stable.setItem(row, COL_STATE, item)
        item.setText(st)
        item.setForeground(QBrush(theme.status_color(st) if st else theme.status_color(im.INFO)))

    def _step_edited(self, item: QTableWidgetItem) -> None:
        r = item.row()
        if not 0 <= r < len(self.steps) or item.column() not in (COL_VALUE, COL_DONE):
            return
        s = self.steps[r]
        by = self.by.text().strip() or getattr(self.state.actor, "name", "")
        if item.column() == COL_DONE:
            im.mark(self.job, s.id, done=item.checkState() == Qt.Checked, by=by)
        else:
            im.mark(self.job, s.id, value=item.text().strip(), by=by)
        self.stable.blockSignals(True)
        self._paint_state(r, s)
        self.stable.blockSignals(False)
        done, total = im.progress(self.job)
        self.progress.setText(f"ทำแล้ว {done} / {total} ขั้นตอน · {self.job.product_spec.name} บน {self.job.cab_spec.name}")

    # ---- files ------------------------------------------------------------
    def new_job(self) -> None:
        job = im.InstallJob(cab=self.job.cab, product=self.job.product)
        job.apply_product()
        self.path = ""
        self.load_job(job)
        self.state.notify("เริ่มงานติดตั้งใหม่")

    def open_job(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "เปิดงานติดตั้ง", "", "งานติดตั้ง (*.rrsinst *.json)")
        if path:
            self.path = path
            self.load_job(im.InstallJob.load(path))
            self.state.notify(f"เปิด {Path(path).name} แล้ว")

    def save_job(self, path: str = "") -> None:
        self.read_form()
        name = f"{self.job.job_no or 'งานติดตั้ง'}.rrsinst"
        path = path or self.actions.save_path("บันทึกงานติดตั้ง", name, "งานติดตั้ง (*.rrsinst)")
        if path:
            self.job.save(path)
            self.path = path
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def export(self, fmt: str = "pdf", path: str = "") -> str:
        self.read_form()
        doc_html = im.render_html(self.job, self.findings)
        if not path:
            stem = f"ใบขั้นตอนติดตั้ง_{self.job.job_no or 'Ford'}"
            path = self.actions.save_path("ใบขั้นตอนติดตั้ง", f"{stem}.{fmt}",
                                          "PDF (*.pdf);;HTML (*.html)" if fmt == "pdf" else "HTML (*.html)")
        if not path:
            return ""
        if path.lower().endswith(".html"):
            Path(path).write_text(doc_html, encoding="utf-8")
        else:
            write_pdf(path, doc_html)
        self.state.notify(f"บันทึก {Path(path).name} แล้ว")
        return path


def write_pdf(path: str | Path, doc_html: str) -> None:
    writer = QPdfWriter(str(path))
    writer.setPageSize(QPageSize(QPageSize.A4))
    writer.setResolution(150)
    writer.setCreator("RRS Part List Studio")
    doc = QTextDocument()
    doc.setDefaultFont(theme.app_font())
    doc.setHtml(doc_html)
    doc.print_(writer)
