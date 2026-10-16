"""ตัดเหล็ก / เลเซอร์ - cutting plan from the flat patterns, checks before cutting, the laser queue and the
library of flat patterns (คลังรูปคลี่) that links the drawings to the production jobs."""

from __future__ import annotations

import tempfile
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QPointF, Qt, QUrl
from PySide6.QtGui import QBrush, QColor, QDesktopServices, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFileDialog,
                               QFormLayout, QGraphicsScene, QGraphicsView, QGridLayout, QHBoxLayout, QLabel,
                               QLineEdit, QListWidget, QListWidgetItem, QMenu, QMessageBox, QSpinBox, QSplitter,
                               QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from ...core import laser, nesting
from ...core.nesting import Placement
from ...core.stock import material_family
from ..state import AppState
from ..widgets import Card, PageHeader, button, fill, selected_rows, table

SRC_PARTLIST = "partlist"
SRC_JOBS = "jobs"
FLAT_HEADERS = ["รหัส", "ชิ้นส่วน", "วัสดุ", "หนา (มม.)", "ขนาด (มม.)", "รู", "ระยะตัด/ชิ้น (ม.)", "เวลา/ชิ้น (นาที)",
                "เลขที่แบบ", "Rev.", "จากไฟล์", "บันทึกเมื่อ"]
CHECK_HEADERS = ["ระดับ", "รหัส", "ชิ้นส่วน", "งาน / SO", "ปัญหา"]


class SheetView(QGraphicsView):
    """Sheets with the parts placed on them (wheel = zoom, drag = pan, double click = fit)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setScene(QGraphicsScene(self))
        self.setRenderHint(QPainter.Antialiasing)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setBackgroundBrush(QColor("#0F1B2B"))
        self.setMinimumHeight(220)

    def _pens(self):
        pens = []
        for color in ("#9FB3CC", "#F28C28", "#4FC3F7"):
            pen = QPen(QColor(color))
            pen.setCosmetic(True)
            pens.append(pen)
        return pens

    def _sheet(self, x0: float, w: float, h: float, label: str, pen) -> None:
        scene = self.scene()
        scene.addRect(x0, -h, w, h, pen, QBrush(QColor("#16283E")))
        text = scene.addSimpleText(label)
        text.setBrush(QColor("#E6EDF6"))
        text.setScale(max(w, 300) / 700)
        text.setPos(x0, 20)

    def _part(self, part: nesting.NestPart, pl: Placement, x0: float, part_pen, hole_pen) -> None:
        loops = part.outline or [[(0, 0), (part.width, 0), (part.width, part.height), (0, part.height)]]
        for k, loop in enumerate(loops):
            pts = [nesting.place_point(pt, part, pl, x0, 0) for pt in loop]
            poly = QPolygonF([QPointF(x, -y) for x, y in pts])
            self.scene().addPolygon(poly, part_pen if k == 0 else hole_pen,
                                    QBrush(QColor(242, 140, 40, 60)) if k == 0 else QBrush(Qt.NoBrush))

    def _fit(self) -> None:
        rect = self.scene().itemsBoundingRect()
        if not rect.isNull():
            self.fitInView(rect, Qt.KeepAspectRatio)

    def show_group(self, group: nesting.NestGroup | None) -> None:
        self.scene().clear()
        if group is None:
            return
        sheet_pen, part_pen, hole_pen = self._pens()
        x0 = 0.0
        for n, s in enumerate(group.sheets, start=1):
            self._sheet(x0, s.width, s.height, f"{n}. {s.size}", sheet_pen)
            for pl in s.placements:
                self._part(group.parts[pl.part], pl, x0, part_pen, hole_pen)
            x0 += s.width + 150
        self._fit()

    def show_program(self, prog: laser.CutProgram | None) -> None:
        self.scene().clear()
        if prog is None:
            return
        sheet_pen, part_pen, hole_pen = self._pens()
        self._sheet(0, prog.sheet_w, prog.sheet_h, f"{prog.no} · {prog.label} · {prog.sheet_size} × {prog.repeat} แผ่น",
                    sheet_pen)
        for raw in prog.placements:
            pl = Placement(0, raw["x"], raw["y"], raw["w"], raw["h"], raw["rotated"])
            self._part(prog.nest_part(raw["key"]), pl, 0, part_pen, hole_pen)
        self._fit()

    def show_flat(self, flat: laser.FlatPattern | None) -> None:
        self.scene().clear()
        if flat is None or not flat.outline:
            return
        _sheet_pen, part_pen, hole_pen = self._pens()
        w, h = flat.size
        part = nesting.NestPart("f", flat.code, flat.name, flat.material, flat.thickness, w, h, 1,
                                outline=flat.outline)
        self._part(part, Placement(0, 0, 0, w, h, False), 0, part_pen, hole_pen)
        self._fit()

    def wheelEvent(self, event):  # noqa: N802
        factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
        self.scale(factor, factor)

    def mouseDoubleClickEvent(self, event):  # noqa: N802
        self._fit()


class LaserSettingsDialog(QDialog):
    """ค่าเครื่องตัดเลเซอร์: speeds by material and thickness, pierce time, checks, DXF layers."""

    FAMILIES = ["STEEL", "GALV", "SUS", "AL"]

    def __init__(self, params: laser.LaserParams, parent=None):
        super().__init__(parent)
        self.setWindowTitle("ค่าเครื่องตัดเลเซอร์")
        self.resize(760, 640)
        self.params = params
        lay = QVBoxLayout(self)
        top = QHBoxLayout()
        top.addWidget(QLabel("เครื่องตัด"))
        self.machine = QComboBox()
        self.machine.addItems(list(laser.MACHINES))
        if params.machine and params.machine not in laser.MACHINES:
            self.machine.addItem(params.machine)
        self.machine.setCurrentText(params.machine)
        top.addWidget(self.machine)
        use = button("ใช้ค่าของรุ่นนี้", tooltip="แทนตารางความเร็ว เวลาเจาะ และขนาดโต๊ะ ด้วยค่าของรุ่นที่เลือก")
        use.clicked.connect(self._use_machine)
        top.addWidget(use)
        top.addWidget(QLabel("โต๊ะรับแผ่นได้สูงสุด"))
        self.bed_w, self.bed_l = QDoubleSpinBox(), QDoubleSpinBox()
        for w, v in ((self.bed_w, params.bed_w), (self.bed_l, params.bed_l)):
            w.setRange(0, 20000)
            w.setDecimals(0)
            w.setSuffix(" มม.")
            w.setValue(v)
        top.addWidget(self.bed_w)
        top.addWidget(QLabel("x"))
        top.addWidget(self.bed_l)
        top.addStretch(1)
        lay.addLayout(top)
        hint = QLabel("ความเร็วตัด (มม./นาที) ตามวัสดุและความหนา – ค่า HSG 12,000W เป็นค่าประมาณ "
                      "(เหล็กใช้ลม/N2 ถึง 12 มม. หนากว่านั้น O2) ให้แก้ตามตารางตัดของเครื่องจริง · "
                      "เวลาเจาะ (วินาที/จุด) ใช้กับทุกวัสดุ · แผ่นหรือชิ้นที่ใหญ่กว่าโต๊ะจะขึ้นในตรวจก่อนตัด")
        hint.setWordWrap(True)
        hint.setObjectName("Hint")
        lay.addWidget(hint)
        thicknesses = sorted({float(k) for t in params.speeds.values() for k in t} | {float(k) for k in params.pierce})
        self.speeds = QTableWidget(len(thicknesses), len(self.FAMILIES) + 2)
        self.speeds.setHorizontalHeaderLabels(["หนา (มม.)"] + [f"{f} มม./นาที" for f in self.FAMILIES] + ["เจาะ (วินาที)"])
        self.speeds.verticalHeader().setVisible(False)
        for r, t in enumerate(thicknesses):
            self.speeds.setItem(r, 0, QTableWidgetItem(f"{t:g}"))
            for c, fam in enumerate(self.FAMILIES, start=1):
                v = (params.speeds.get(fam) or {}).get(t)
                self.speeds.setItem(r, c, QTableWidgetItem(f"{v:g}" if v else ""))
            v = params.pierce.get(t)
            self.speeds.setItem(r, len(self.FAMILIES) + 1, QTableWidgetItem(f"{v:g}" if v else ""))
        lay.addWidget(self.speeds, 1)
        row = QHBoxLayout()
        add = button("+ เพิ่มความหนา")
        add.clicked.connect(self._add_row)
        row.addWidget(add)
        reset = button("คืนค่าเริ่มต้น")
        reset.clicked.connect(self._reset)
        row.addWidget(reset)
        row.addStretch(1)
        lay.addLayout(row)

        form = QGridLayout()
        self.fields: dict[str, QWidget] = {}
        specs = [("travel_pct", "เผื่อเวลาเคลื่อนที่ (%)", 0, 200), ("sheet_minutes", "วาง/เก็บแผ่น (นาที/แผ่น)", 0, 60),
                 ("rate_per_hour", "ค่าเครื่อง (บาท/ชม., 0 = ไม่คิด)", 0, 100000),
                 ("hole_factor", "รูเล็กสุด = ความหนา ×", 0, 5), ("edge_factor", "ระยะรูถึงขอบ = ความหนา ×", 0, 5),
                 ("small_part", "ชิ้นเล็กกว่า (มม.) เตือน", 0, 500)]
        for i, (key, label, lo, hi) in enumerate(specs):
            w = QDoubleSpinBox()
            w.setRange(lo, hi)
            w.setDecimals(1 if hi <= 500 else 0)
            w.setValue(float(getattr(params, key)))
            self.fields[key] = w
            form.addWidget(QLabel(label), i // 2, (i % 2) * 2)
            form.addWidget(w, i // 2, (i % 2) * 2 + 1)
        self.dxf = QComboBox()
        self.dxf.addItems(["R2000", "R2010", "R12"])
        self.dxf.setCurrentText(params.dxf_version)
        form.addWidget(QLabel("รุ่นไฟล์ DXF"), 3, 0)
        form.addWidget(self.dxf, 3, 1)
        self.layers = {}
        for i, (key, label) in enumerate((("layer_outer", "เลเยอร์รอบนอก"), ("layer_inner", "เลเยอร์รู"),
                                          ("layer_mark", "เลเยอร์แกะสลัก"))):
            w = QLineEdit(getattr(params, key))
            self.layers[key] = w
            form.addWidget(QLabel(label), 4 + i // 2, (i % 2) * 2)
            form.addWidget(w, 4 + i // 2, (i % 2) * 2 + 1)
        self.mark = QCheckBox("แกะสลักรหัสชิ้นงานบนชิ้น (เลเยอร์ MARK)")
        self.mark.setChecked(params.mark_codes)
        self.sheet = QCheckBox("วาดกรอบแผ่นในไฟล์ (เลเยอร์ SHEET – ระวังเครื่องตัดตามกรอบ)")
        self.sheet.setChecked(params.sheet_outline)
        form.addWidget(self.mark, 6, 0, 1, 2)
        form.addWidget(self.sheet, 6, 2, 1, 2)
        colors = QHBoxLayout()
        self.colors = {}
        for key, label in (("color_outer", "สีรอบนอก"), ("color_inner", "สีรู"), ("color_mark", "สีแกะสลัก")):
            combo = QComboBox()
            for aci, name in laser.ACI_NAMES.items():
                combo.addItem(f"{aci} {name}", aci)
            combo.setCurrentIndex(max(0, combo.findData(getattr(params, key))))
            self.colors[key] = combo
            colors.addWidget(QLabel(label))
            colors.addWidget(combo)
        colors.addStretch(1)
        form.addLayout(colors, 7, 0, 1, 4)
        tip = QLabel("ซอฟต์แวร์ของเครื่องแยกเลเยอร์เอง (HSG: Big / Mid / Small Graph ตามขนาดเส้น, Mark) – "
                     "ใช้ ส่งออก ▾ → ไฟล์ทดสอบเลเยอร์ เปิดในเครื่อง แล้วตั้งสีให้ตรงกับเลเยอร์ที่ต้องการ")
        tip.setObjectName("Hint")
        tip.setWordWrap(True)
        form.addWidget(tip, 8, 0, 1, 4)
        lay.addLayout(form)
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        box.button(QDialogButtonBox.Ok).setText("บันทึก")
        box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)

    def _add_row(self) -> None:
        self.speeds.insertRow(self.speeds.rowCount())

    def _use_machine(self) -> None:
        name = self.machine.currentText()
        if name not in laser.MACHINES:
            return
        fresh = laser.LaserParams(gap=self.params.gap, margin=self.params.margin, rotate=self.params.rotate)
        fresh.use_machine(name)
        self.bed_w.setValue(fresh.bed_w)
        self.bed_l.setValue(fresh.bed_l)
        self._fill_speeds(fresh)

    def _reset(self) -> None:
        fresh = laser.LaserParams(gap=self.params.gap, margin=self.params.margin, rotate=self.params.rotate)
        self.machine.setCurrentText(fresh.machine)
        self.bed_w.setValue(fresh.bed_w)
        self.bed_l.setValue(fresh.bed_l)
        self._fill_speeds(fresh)

    def _fill_speeds(self, fresh: laser.LaserParams) -> None:
        self.params.speeds, self.params.pierce = fresh.speeds, fresh.pierce
        self.speeds.setRowCount(0)
        thicknesses = sorted({float(k) for t in fresh.speeds.values() for k in t} | {float(k) for k in fresh.pierce})
        self.speeds.setRowCount(len(thicknesses))
        for r, t in enumerate(thicknesses):
            self.speeds.setItem(r, 0, QTableWidgetItem(f"{t:g}"))
            for c, fam in enumerate(self.FAMILIES, start=1):
                v = (fresh.speeds.get(fam) or {}).get(t)
                self.speeds.setItem(r, c, QTableWidgetItem(f"{v:g}" if v else ""))
            v = fresh.pierce.get(t)
            self.speeds.setItem(r, len(self.FAMILIES) + 1, QTableWidgetItem(f"{v:g}" if v else ""))

    def result_params(self) -> laser.LaserParams:
        p = self.params
        speeds: dict[str, dict[float, float]] = {f: {} for f in self.FAMILIES}
        pierce: dict[float, float] = {}
        for r in range(self.speeds.rowCount()):
            try:
                t = float((self.speeds.item(r, 0) or QTableWidgetItem("")).text())
            except ValueError:
                continue
            for c, fam in enumerate(self.FAMILIES, start=1):
                text = (self.speeds.item(r, c) or QTableWidgetItem("")).text().replace(",", "")
                try:
                    if text and float(text) > 0:
                        speeds[fam][t] = float(text)
                except ValueError:
                    pass
            text = (self.speeds.item(r, len(self.FAMILIES) + 1) or QTableWidgetItem("")).text()
            try:
                if text:
                    pierce[t] = float(text)
            except ValueError:
                pass
        p.speeds = {f: t for f, t in speeds.items() if t}
        p.pierce = pierce or dict(laser.DEFAULT_PIERCE)
        for key, w in self.fields.items():
            setattr(p, key, w.value())
        p.dxf_version = self.dxf.currentText()
        for key, w in self.layers.items():
            setattr(p, key, w.text().strip() or getattr(laser.LaserParams(), key))
        p.mark_codes = self.mark.isChecked()
        p.sheet_outline = self.sheet.isChecked()
        p.machine = self.machine.currentText()
        for key, combo in self.colors.items():
            setattr(p, key, int(combo.currentData()))
        p.bed_w, p.bed_l = self.bed_w.value(), self.bed_l.value()
        return p


class CutDialog(QDialog):
    """บันทึกตัดแล้ว: sheets cut, who cut them, the offcut left."""

    def __init__(self, prog: laser.CutProgram, operator: str = "", parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"บันทึกตัดแล้ว – {prog.no}")
        form = QFormLayout(self)
        form.addRow(QLabel(f"{prog.label} · แผ่น {prog.sheet_size} · {prog.pieces} ชิ้น/แผ่น · "
                           f"ตัดแล้ว {prog.cut_sheets} จาก {prog.repeat} แผ่น"))
        self.sheets = QSpinBox()
        self.sheets.setRange(1, max(1, prog.left_sheets))
        self.sheets.setValue(max(1, prog.left_sheets))
        self.sheets.setSuffix(" แผ่น")
        form.addRow("ตัดเสร็จ", self.sheets)
        self.operator = QLineEdit(operator)
        form.addRow("ผู้ตัด", self.operator)
        self.remnant = QLineEdit(prog.remnant)
        self.remnant.setPlaceholderText("เช่น 1219x600 (เศษแผ่นที่เก็บไว้ใช้ต่อ)")
        form.addRow("เศษแผ่นที่เหลือ", self.remnant)
        note = QLabel("ชิ้นงานของงาน/SO จะผ่านขั้น 'ตัด' (ขึ้น รอพับ) และสร้างใบ PD (ร่าง) จ่ายแผ่นเหล็กให้สโตร์ตรวจ/บันทึก")
        note.setObjectName("Hint")
        note.setWordWrap(True)
        form.addRow(note)
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        box.button(QDialogButtonBox.Ok).setText("บันทึกตัดแล้ว")
        box.button(QDialogButtonBox.Ok).setProperty("kind", "primary")
        box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        form.addRow(box)


class NestingPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.groups: list[nesting.NestGroup] = []
        self.demand: laser.Demand | None = None
        self.issues: list[laser.Issue] = []
        self._row_group: list[nesting.NestGroup] = []
        self._programs: list[laser.CutProgram] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(10)
        header = PageHeader("ตัดเลเซอร์",
                            "ทำตามแท็บจากซ้ายไปขวา: วางแผนตัด → ตรวจก่อนตัด → คิวเลเซอร์ (ส่งออกไฟล์ / บันทึกตัดเสร็จ) · "
                            "บันทึกแล้วชิ้นงานขึ้น รอพับ และระบบร่างใบ PD แผ่นเหล็กให้สโตร์")
        run = header.add_action(button("คำนวณแผนตัด", "accent"))
        run.clicked.connect(self.run)
        self.make_btn = header.add_action(button("สร้างโปรแกรมตัด → คิวเลเซอร์", "primary",
                                                 "แผ่นที่วางเหมือนกันรวมเป็นโปรแกรมเดียว × จำนวนแผ่น"))
        self.make_btn.clicked.connect(self.make_programs)
        self.make_btn.setEnabled(False)
        exp = header.add_action(button("ส่งออก ▾"))
        menu = QMenu(exp)
        menu.addAction("ไฟล์ให้เครื่องเลเซอร์: โปรแกรมที่ยังไม่ตัด (DXF + ใบสั่งตัด)…", lambda: self.export_package(False))
        menu.addSeparator()
        menu.addAction("แผนตัดเพื่อดูจำนวนแผ่น/ต้นทุนเหล็ก (Excel)…", self.export_excel)
        menu.addAction("แผนวางชิ้นงานเปิดดูใน ZWCAD (DXF)…", self.export_dxf)
        menu.addSeparator()
        menu.addAction("ไฟล์ทดสอบเลเยอร์สำหรับเครื่องเลเซอร์ (DXF)…", self.export_layer_test)
        exp.setMenu(menu)
        b = header.add_action(button("ค่าเครื่องตัด…", tooltip="ความเร็วตัด เวลาเจาะ เกณฑ์ตรวจ และเลเยอร์ไฟล์ DXF"))
        b.clicked.connect(self.edit_settings)
        lay.addWidget(header)

        self.tabs = QTabWidget()
        lay.addWidget(self.tabs, 1)
        self._build_plan_tab()
        self._build_check_tab()
        self._build_queue_tab()
        self._build_library_tab()

        state.partlist_changed.connect(self._sync_sets)
        state.jobs_changed.connect(self._refresh_jobs)
        state.laser_changed.connect(self._refresh_laser)
        self._sync_sets()
        self._refresh_jobs()
        if not state.settings.get("laser/source"):  # first use: the jobs when some still have parts to cut
            has_jobs = any(self.jobs.item(i).checkState() == Qt.Checked for i in range(self.jobs.count()))
            self.source.setCurrentIndex(self.source.findData(SRC_JOBS if has_jobs else SRC_PARTLIST))
        self._refresh_laser()

    # ---- tabs ------------------------------------------------------------------------------------
    def _build_plan_tab(self) -> None:
        tab = QWidget()
        lay = QVBoxLayout(tab)
        lay.setContentsMargins(12, 12, 12, 12)
        params = Card("ชิ้นที่ต้องตัด และค่าที่ใช้วาง")
        row = QHBoxLayout()
        self.source = QComboBox()
        self.source.addItem("งานผลิตที่ยังตัดไม่ครบ (ใช้ตัดจริง)", SRC_JOBS)
        self.source.addItem("ทดลองคำนวณจาก Part List (ยังไม่เปิดงาน)", SRC_PARTLIST)
        saved = self.state.settings.get("laser/source")
        if saved:
            self.source.setCurrentIndex(max(0, self.source.findData(saved)))
        self.source.currentIndexChanged.connect(self._source_changed)
        row.addWidget(QLabel("ที่มา"))
        row.addWidget(self.source)
        p = self.state.settings.laser
        self.gap = QDoubleSpinBox()
        self.gap.setRange(0, 100)
        self.gap.setValue(p.gap)
        self.gap.setSuffix(" มม.")
        self.margin = QDoubleSpinBox()
        self.margin.setRange(0, 200)
        self.margin.setValue(p.margin)
        self.margin.setSuffix(" มม.")
        self.rotate = QCheckBox("หมุน 90° ได้")
        self.rotate.setChecked(p.rotate)
        self.default_thk = QDoubleSpinBox()
        self.default_thk.setRange(0, 50)
        self.default_thk.setDecimals(1)
        self.default_thk.setValue(float(self.state.settings.get("nest/default_thk", "0") or 0))
        self.default_thk.setSuffix(" มม.")
        self.default_thk.setSpecialValueText("ไม่ใช้")
        self.sets = QLabel()
        self.sets.setToolTip("จำนวนคันของ Part List แก้ได้ที่หน้าภาพรวมที่เดียว · งานที่เปิดแล้วแก้ที่หน้างานผลิต")
        self.sets_label = button("แก้ ›", tooltip="จำนวนคันของ Part List แก้ได้ที่หน้าภาพรวมที่เดียว · งานที่เปิดแล้วแก้ที่หน้างานผลิต")
        self.sets_label.clicked.connect(lambda: self.actions.go("dashboard"))
        for label, w in (("ระยะห่างชิ้นงาน", self.gap), ("ขอบแผ่น", self.margin), ("", self.rotate),
                         ("ความหนา (เมื่อแบบไม่ระบุ)", self.default_thk)):
            if label:
                row.addWidget(QLabel(label))
            row.addWidget(w)
        row.addWidget(self.sets)
        row.addWidget(self.sets_label)
        row.addStretch(1)
        params.body.addLayout(row)
        self.jobs = QListWidget()
        self.jobs.setObjectName("Plain")
        self.jobs.setMaximumHeight(96)
        self.jobs.setToolTip("ติ๊กงานที่จะตัดในรอบนี้ (ชิ้นที่ยังไม่ผ่านขั้น ตัด และยังไม่อยู่ในโปรแกรมตัด)")
        params.body.addWidget(self.jobs)
        self.summary = QLabel("กด คำนวณแผนตัด")
        self.summary.setObjectName("Hint")
        self.summary.setWordWrap(True)
        params.body.addWidget(self.summary)
        lay.addWidget(params)
        split = QSplitter(Qt.Vertical)
        self.table = table(nesting.PLAN_HEADERS, [120, 70, 260, 110, 110, 80, 90, 70, 80, 60, 90, 300])
        self.table.itemSelectionChanged.connect(self._selected)
        split.addWidget(self.table)
        self.view = SheetView()
        split.addWidget(self.view)
        split.setSizes([220, 420])
        lay.addWidget(split, 1)
        self.tabs.addTab(tab, "วางแผนตัด")
        self._source_changed()

    def _build_check_tab(self) -> None:
        tab = QWidget()
        lay = QVBoxLayout(tab)
        lay.setContentsMargins(12, 12, 12, 12)
        self.check_hint = QLabel("ตรวจรูปคลี่ก่อนส่งเครื่องตัด: รูเล็กกว่าความหนา · รูชิดขอบ · ชิ้นเล็กเกิน · เส้นซ้อน · "
                                 "ชิ้นใหญ่กว่าแผ่น · ชิ้นที่ยังไม่มีรูปคลี่ในคลัง (คำนวณแผนตัดก่อน)")
        self.check_hint.setObjectName("Hint")
        self.check_hint.setWordWrap(True)
        lay.addWidget(self.check_hint)
        self.checks = table(CHECK_HEADERS, [80, 160, 220, 110, 600])
        lay.addWidget(self.checks, 1)
        self.tabs.addTab(tab, "ตรวจก่อนตัด")

    def _build_queue_tab(self) -> None:
        tab = QWidget()
        lay = QVBoxLayout(tab)
        lay.setContentsMargins(12, 12, 12, 12)
        row = QHBoxLayout()
        self.queue_summary = QLabel()
        self.queue_summary.setObjectName("Hint")
        row.addWidget(self.queue_summary, 1)
        self.show_done = QCheckBox("แสดงที่ตัดแล้ว / ยกเลิก")
        self.show_done.toggled.connect(self._refresh_laser)
        row.addWidget(self.show_done)
        lay.addLayout(row)
        tools = QHBoxLayout()
        for text, slot, kind, tip in (
                ("ส่งออกแพ็กเลเซอร์…", lambda: self.export_package(True), "accent",
                 "โปรแกรมที่เลือก (หรือทั้งหมดที่ยังไม่ตัด): DXF ต่อแผ่น + DXF ต่อชิ้น + ภาพแผ่น + ใบสั่งตัด"),
                ("ใบสั่งตัด (Excel)…", self.export_order, "", "ใบสั่งตัดพร้อมภาพแผ่น สำหรับช่างเลเซอร์"),
                ("เริ่มตัด ▶", self.start_cut, "", "เปลี่ยนสถานะเป็น กำลังตัด"),
                ("บันทึกตัดแล้ว ✓…", self.record_cut, "primary",
                 "ชิ้นงานของงานผ่านขั้น ตัด และร่างใบ PD จ่ายแผ่นเหล็ก"),
                ("ยกเลิกโปรแกรม", self.cancel_program, "", "ชิ้นที่ยังไม่ตัดกลับไปให้วางแผนใหม่ได้"),
                ("ลบ", self.delete_program, "", "ลบออกจากคิว")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            tools.addWidget(b)
        tools.addStretch(1)
        lay.addLayout(tools)
        split = QSplitter(Qt.Vertical)
        self.programs = table(laser.PROGRAM_HEADERS,
                              [115, 70, 45, 95, 110, 45, 60, 70, 110, 75, 75, 70, 75, 160, 75, 200])
        self.programs.itemSelectionChanged.connect(self._program_selected)
        split.addWidget(self.programs)
        self.program_view = SheetView()
        split.addWidget(self.program_view)
        split.setSizes([260, 380])
        lay.addWidget(split, 1)
        self.tabs.addTab(tab, "คิวเลเซอร์")

    def _build_library_tab(self) -> None:
        tab = QWidget()
        lay = QVBoxLayout(tab)
        lay.setContentsMargins(12, 12, 12, 12)
        row = QHBoxLayout()
        self.flat_search = QLineEdit()
        self.flat_search.setPlaceholderText("ค้นหา รหัส / ชื่อ …")
        self.flat_search.setClearButtonEnabled(True)
        self.flat_search.setMaximumWidth(320)
        self.flat_search.textChanged.connect(self._refresh_flats)
        row.addWidget(self.flat_search)
        self.flat_summary = QLabel()
        self.flat_summary.setObjectName("Hint")
        row.addWidget(self.flat_summary, 1)
        b = button("บันทึกรูปคลี่จาก Part List ปัจจุบัน", tooltip="ทุกแถวที่มีรหัสและรูปคลี่ (จากการนำเข้าแบบ DWG)")
        b.clicked.connect(self.save_flats_from_partlist)
        row.addWidget(b)
        b = button("ลบที่เลือก")
        b.clicked.connect(self.remove_flats)
        row.addWidget(b)
        lay.addLayout(row)
        hint = QLabel("ทุกครั้งที่นำเข้าแบบ DWG รูปคลี่ของชิ้นที่มีรหัสจะถูกเก็บที่นี่โดยอัตโนมัติ (แบบใหม่แทนที่แบบเก่า) "
                      "เพื่อให้งานผลิตจากแบบกระบะ × จำนวนคันหารูปคลี่มาตัดได้ตามรหัส")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        split = QSplitter(Qt.Horizontal)
        self.flats = table(FLAT_HEADERS, [140, 200, 80, 60, 100, 40, 90, 90, 100, 50, 160, 90])
        self.flats.itemSelectionChanged.connect(self._flat_selected)
        split.addWidget(self.flats)
        self.flat_view = SheetView()
        split.addWidget(self.flat_view)
        split.setSizes([900, 360])
        lay.addWidget(split, 1)
        self.tabs.addTab(tab, "คลังรูปคลี่")

    # ---- settings ---------------------------------------------------------------------------------
    def laser_params(self) -> laser.LaserParams:
        p = self.state.settings.laser
        p.gap, p.margin, p.rotate = self.gap.value(), self.margin.value(), self.rotate.isChecked()
        self.state.settings.laser = p
        self.state.settings.set("nest/default_thk", self.default_thk.value())
        return p

    def params(self) -> nesting.NestParams:
        return self.laser_params().nest_params()

    def export_layer_test(self) -> None:
        """Squares on each layer / colour: open it in the laser software to see which layer each lands on."""
        path = self.actions.save_path("ไฟล์ทดสอบเลเยอร์", "LAYER_TEST.dxf", "DXF (*.dxf)")
        if path:
            laser.export_layer_test(path, self.laser_params())
            self.state.notify("บันทึก LAYER_TEST.dxf แล้ว – แถวบน: รอบนอก · รู · แกะสลัก · แถวล่าง: สี 1–7 จากซ้ายไปขวา")

    def edit_settings(self) -> None:
        dialog = LaserSettingsDialog(self.laser_params(), self)
        if dialog.exec():
            self.state.settings.laser = dialog.result_params()
            self.state.notify("บันทึกค่าเครื่องตัดแล้ว")
        dialog.deleteLater()

    def _sets(self) -> int:
        return max(1, self.state.partlist.info.build_qty)

    def _sync_sets(self) -> None:
        self.sets.setText(f"× {self._sets()} คัน (จาก Part List)")

    def _source_changed(self, index: int | None = None) -> None:
        jobs = self.source.currentData() == SRC_JOBS
        self.jobs.setVisible(jobs)
        self.sets.setVisible(not jobs)
        self.sets_label.setVisible(not jobs)
        if index is not None:  # chosen by the user: remember it
            self.state.settings.set("laser/source", self.source.currentData())

    # ---- plan ----------------------------------------------------------------------------------------
    def _refresh_jobs(self) -> None:
        from ...core.production import CLOSED

        known = {self.jobs.item(i).data(Qt.UserRole) for i in range(self.jobs.count())}
        checked = {self.jobs.item(i).data(Qt.UserRole) for i in range(self.jobs.count())
                   if self.jobs.item(i).checkState() == Qt.Checked}
        self.jobs.clear()
        planned = laser.planned_pieces(self.state.cut_queue.programs)
        for job in self.state.jobs:
            if job.status in CLOSED:
                continue
            left = sum(max(0.0, p.to_make - p.done_at(laser.CUT_STEP) - planned.get(laser.job_key(job.job_no, i), 0))
                       for i, p in enumerate(job.parts) if laser.CUT_STEP in p.route)
            item = QListWidgetItem(f"{job.job_no} · {job.title or job.model} · เหลือต้องตัด {left:g} ชิ้น")
            item.setData(Qt.UserRole, job.job_no)
            item.setData(Qt.UserRole + 1, left)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            new = job.job_no not in known  # a job opened since: ticked when it has parts to cut
            item.setCheckState(Qt.Checked if (new or job.job_no in checked) and left > 0 else Qt.Unchecked)
            self.jobs.addItem(item)

    def _job_nos(self) -> list[str]:
        return [self.jobs.item(i).data(Qt.UserRole) for i in range(self.jobs.count())
                if self.jobs.item(i).checkState() == Qt.Checked]

    def _clear_plan(self, text: str) -> None:
        self.groups, self.issues, self.demand = [], [], None
        self._show_checks()
        fill(self.table, [])
        self.view.show_group(None)
        self.make_btn.setEnabled(False)
        self.summary.setText(text)

    def run(self) -> None:
        params = self.laser_params()
        if self.source.currentData() == SRC_JOBS:
            job_nos = self._job_nos()
            if not job_nos:
                if any((self.jobs.item(i).data(Qt.UserRole + 1) or 0) > 0 for i in range(self.jobs.count())):
                    self.actions.error("ยังไม่ได้เลือกงาน", "ติ๊กงานผลิตที่จะตัด – หรือเปลี่ยนที่มาเป็น Part List ปัจจุบัน")
                else:
                    self._clear_plan("ไม่มีงานที่ยังต้องตัด – ตัดครบ หรืออยู่ในคิวเลเซอร์แล้ว (เปิดงานผลิต หรือเลือก Part List)")
                return
            demand = laser.demand_from_jobs(self.state.jobs, self.state.flats, self.state.cut_queue.programs,
                                            self.state.xref_lookup, self.default_thk.value(), job_nos)
        else:
            demand = laser.demand_from_partlist(self.state.partlist, self._sets(), self.default_thk.value())
        if not demand.parts:
            self._clear_plan("")
            self.demand = demand
            self._show_checks()
            if demand.missing:
                self.summary.setText(f"ไม่มีชิ้นที่วางได้ · ยังไม่มีรูปคลี่ {len(demand.missing)} รายการ (ดูแท็บ ตรวจก่อนตัด)")
                self.tabs.setCurrentIndex(1)
                return
            if self.source.currentData() == SRC_JOBS:
                self.summary.setText("งานที่เลือกตัดครบ หรืออยู่ในคิวเลเซอร์แล้ว")
                return
            self.actions.error("ไม่มีชิ้นงานที่วางได้",
                               "ชิ้นส่วนต้องมีความหนา (เช่น t2.5) และขนาดรูปคลี่ – นำเข้าแบบ DWG/DXF ในหน้า แบบ 2D "
                               "หรือใส่ความหนาเมื่อแบบไม่ระบุ")
            return
        self.demand = demand
        self.groups = nesting.plan(demand.parts, self.state.stock, params.nest_params(), self.state.settings.densities)
        self.issues = laser.check_parts(demand.parts, params, self.groups)
        rows = nesting.plan_rows(self.groups)
        self._row_group = []
        for g in self.groups:
            self._row_group += [g] * max(1, len(g.sheet_counts()))
        fill(self.table, rows)
        sheets = sum(len(g.sheets) for g in self.groups)
        by_weight = sum(g.by_weight for g in self.groups)
        area = sum(g.sheet_area for g in self.groups)
        used = sum(g.parts_area for g in self.groups)
        minutes = 0.0
        for g in self.groups:
            for s in g.sheets:
                length = pierces = 0
                for pl in s.placements:
                    part = g.parts[pl.part]
                    lp, n = laser.cut_metrics(part.outline) if part.outline else (2 * (part.width + part.height), 1)
                    length += lp
                    pierces += n
                minutes += laser.cut_minutes(length, pierces, g.family, g.thickness, params) + params.sheet_minutes
        errors = sum(1 for i in self.issues if i.level == laser.ERROR) + len(demand.missing)
        warns = sum(1 for i in self.issues if i.level == laser.WARN)
        self.summary.setText(
            f"<b>{sheets} แผ่น</b> ({len(self.groups)} ความหนา) · ใช้เนื้อเหล็ก {used / area:.0%} "
            f"· เศษ {1 - used / area:.0%} · คิดจากน้ำหนักได้ {by_weight:.1f} แผ่น · เวลาเลเซอร์ประมาณ {minutes / 60:.1f} ชม."
            + (f" · <span style='color:#D64545'>ต้องแก้ {errors}</span>" if errors else "")
            + (f" · ควรตรวจ {warns} (แท็บ ตรวจก่อนตัด)" if warns else "")
            + (f" · ไม่ได้วาง {len(demand.skipped)} รายการ (ไม่มีความหนา/ขนาด หรือ ซื้อสำเร็จ)" if demand.skipped else ""))
        self._show_checks()
        self.make_btn.setEnabled(bool(self.groups))
        if rows:
            self.table.selectRow(0)
        self.state.notify(f"แผนตัด {sheets} แผ่น")

    def _show_checks(self) -> None:
        demand = self.demand or laser.Demand()
        job_of = {p.key: p.job for p in demand.parts}
        rows = [["ต้องแก้", code, name, job, f"{why} – {qty:g} ชิ้น"] for job, code, name, qty, why in demand.missing]
        rows += [["ต้องแก้" if i.level == laser.ERROR else "ควรตรวจ", i.code, i.name, job_of.get(i.key, ""), i.text]
                 for i in self.issues]
        fill(self.checks, rows, status_col=0)
        n = len(rows)
        self.tabs.setTabText(1, f"ตรวจก่อนตัด ({n})" if n else "ตรวจก่อนตัด")

    def _selected(self) -> None:
        rows = selected_rows(self.table)
        if rows and rows[0] < len(self._row_group):
            self.view.show_group(self._row_group[rows[0]])

    def make_programs(self) -> None:
        if not self.groups or self.demand is None:
            return
        progs = laser.make_programs(self.groups, self.state.cut_queue, self.laser_params(), self.demand.source)
        self.groups = []
        self.make_btn.setEnabled(False)
        self.state.save_laser()
        self._refresh_jobs()
        self.tabs.setCurrentIndex(2)
        self.state.notify(f"สร้างโปรแกรมตัด {len(progs)} โปรแกรม ({sum(p.repeat for p in progs)} แผ่น) เข้าคิวเลเซอร์")

    def export_excel(self) -> None:
        if not self.groups:
            self.run()
        if not self.groups:
            return
        path = self.actions.save_path("แผนตัดแผ่นเหล็ก", self.actions.default_name(".xlsx", "แผนตัดเหล็ก"), "Excel (*.xlsx)")
        if path:
            title = f"แผนตัดแผ่นเหล็ก {self.demand.source if self.demand else ''}"
            nesting.export_plan(self.groups, path, self.params(), title)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def export_dxf(self) -> None:
        if not self.groups:
            self.run()
        if not self.groups:
            return
        path = self.actions.save_path("แผนวางชิ้นงาน (DXF)", self.actions.default_name(".dxf", "แผนตัดเหล็ก"),
                                      "DXF (*.dxf)")
        if path:
            nesting.export_dxf(self.groups, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว – เปิดใน ZWCAD ได้")

    # ---- queue -----------------------------------------------------------------------------------------
    def _refresh_laser(self, *_args) -> None:
        q = self.state.cut_queue
        current = self._program()
        progs = [p for p in q.programs if self.show_done.isChecked() or p.status in laser.OPEN]
        self._programs = progs
        fill(self.programs, laser.program_rows(progs), status_col=14)
        if progs:
            nos = [p.no for p in progs]
            self.programs.selectRow(nos.index(current.no) if current and current.no in nos else 0)
        else:
            self.program_view.show_program(None)
        open_ = q.open_programs()
        self.queue_summary.setText(
            f"รอตัด {sum(1 for p in open_ if p.status == laser.ST_WAIT)} · กำลังตัด "
            f"{sum(1 for p in open_ if p.status == laser.ST_CUTTING)} โปรแกรม "
            f"· เหลือ {sum(p.left_sheets for p in open_)} แผ่น "
            f"· เวลาประมาณ {sum(p.minutes * p.left_sheets for p in open_) / 60:.1f} ชม.")
        self.tabs.setTabText(2, f"คิวเลเซอร์ ({len(open_)})" if open_ else "คิวเลเซอร์")
        self._refresh_flats()

    def _program(self) -> laser.CutProgram | None:
        rows = selected_rows(self.programs)
        if rows and rows[0] < len(self._programs):
            return self._programs[rows[0]]
        return None

    def _selected_programs(self) -> list[laser.CutProgram]:
        return [self._programs[r] for r in selected_rows(self.programs) if r < len(self._programs)]

    def _program_selected(self) -> None:
        self.program_view.show_program(self._program())

    def _package_parts(self, progs: list[laser.CutProgram]) -> list[nesting.NestPart]:
        """Each part of the programs once, with the pieces still to cut - for nesting in the laser software."""
        out: dict[str, nesting.NestPart] = {}
        for prog in progs:
            for key, n in prog.counts().items():
                part = out.get(key)
                if part is None:
                    part = prog.nest_part(key)
                    part.qty = 0
                    out[key] = part
                part.qty += n * prog.left_sheets
        return [p for p in out.values() if p.qty > 0]

    def export_package(self, selected_only: bool) -> None:
        progs = (self._selected_programs() if selected_only else []) or self.state.cut_queue.open_programs()
        if not progs:
            self.actions.error("ไม่มีโปรแกรมตัด", "คำนวณแผนตัด แล้วกด สร้างโปรแกรมตัด → คิวเลเซอร์ ก่อน")
            return
        base = QFileDialog.getExistingDirectory(self, "เลือกโฟลเดอร์ที่จะเก็บแพ็กเลเซอร์", self.actions._dir())
        if not base:
            return
        params = self.laser_params()
        folder = Path(base) / f"LaserPackage_{datetime.now():%Y%m%d-%H%M}"
        parts = self._package_parts(progs)
        issues = laser.check_parts(parts, params)
        out = laser.export_package(progs, folder, params, parts, issues,
                                   f"ใบสั่งตัดเลเซอร์ {', '.join(sorted({j for p in progs for j in p.jobs})) or ''}")
        self.state.save_laser()
        self.state.notify(f"แพ็กเลเซอร์: {out['programs']} โปรแกรม · {out['parts']} ชิ้น → {folder}")
        if QMessageBox.question(self, "แพ็กเลเซอร์", f"บันทึกแล้วที่\n{folder}\n\nเปิดโฟลเดอร์?") == QMessageBox.Yes:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))

    def export_order(self) -> None:
        progs = self._selected_programs() or self.state.cut_queue.open_programs()
        if not progs:
            return
        path = self.actions.save_path("ใบสั่งตัดเลเซอร์", self.actions.default_name(".xlsx", "ใบสั่งตัดเลเซอร์"),
                                      "Excel (*.xlsx)")
        if not path:
            return
        params = self.laser_params()
        with tempfile.TemporaryDirectory() as tmp:
            images = {p.no: str(laser.program_png(p, Path(tmp) / f"{p.no}.png")) for p in progs}
            laser.export_cut_order(progs, path, params, None, None, images)
        self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def start_cut(self) -> None:
        for prog in self._selected_programs():
            if prog.status == laser.ST_WAIT:
                prog.status = laser.ST_CUTTING
        self.state.save_laser()

    def record_cut(self) -> None:
        prog = self._program()
        if prog is None or prog.status not in laser.OPEN:
            self.actions.error("เลือกโปรแกรม", "เลือกโปรแกรมที่ยังไม่ตัดเสร็จในคิว")
            return
        dialog = CutDialog(prog, self.state.settings.get("laser/operator"), self)
        ok = dialog.exec()
        sheets, operator, remnant = dialog.sheets.value(), dialog.operator.text().strip(), dialog.remnant.text().strip()
        dialog.deleteLater()
        if not ok:
            return
        self.state.settings.set("laser/operator", operator)
        n, doc = laser.apply_cut(prog, sheets, self.state.jobs, self.state.ledger, operator, remnant)
        self.state.save_jobs()
        self.state.ledger_changed.emit()
        self.state.save_laser()
        self.state.notify(f"{prog.no} ตัดแล้ว {prog.cut_sheets}/{prog.repeat} แผ่น"
                          + (f" · ชิ้นงานผ่านขั้นตัด {n} ชิ้น" if n else "")
                          + (f" · ร่าง {doc.doc_no} จ่ายแผ่นเหล็ก (หน้า เบิก/รับ สต็อก)" if doc else ""))

    def cancel_program(self) -> None:
        progs = [p for p in self._selected_programs() if p.status in laser.OPEN]
        if not progs or QMessageBox.question(
                self, "ยกเลิกโปรแกรม", f"ยกเลิก {', '.join(p.no for p in progs)}? ชิ้นที่ยังไม่ตัดจะกลับไปวางแผนใหม่ได้") \
                != QMessageBox.Yes:
            return
        for p in progs:
            p.status = laser.ST_CANCELLED
        self.state.save_laser()
        self._refresh_jobs()

    def delete_program(self) -> None:
        progs = self._selected_programs()
        if not progs or QMessageBox.question(self, "ลบโปรแกรม", f"ลบ {', '.join(p.no for p in progs)} ออกจากคิว?") \
                != QMessageBox.Yes:
            return
        ids = {id(p) for p in progs}
        self.state.cut_queue.programs = [p for p in self.state.cut_queue.programs if id(p) not in ids]
        self.state.save_laser()
        self._refresh_jobs()

    # ---- flat pattern library ------------------------------------------------------------------
    def _refresh_flats(self, *_args) -> None:
        params = self.state.settings.laser
        text = self.flat_search.text().strip().lower()
        flats = [f for f in self.state.flats.items()
                 if not text or text in f.code.lower() or text in (f.name or "").lower()]
        self._flats = flats
        rows = []
        for f in flats:
            w, h = f.size
            length, pierces = laser.cut_metrics(f.outline)
            minutes = laser.cut_minutes(length, pierces, material_family(f.material), f.thickness, params)
            rows.append([f.code, f.name, f.material, f.thickness or "", f"{w:.0f} x {h:.0f}", f.holes,
                         round(length / 1000, 3), round(minutes, 2), f.drawing_no, f.revision, f.source, f.saved])
        fill(self.flats, rows)
        total = len(self.state.flats.flats)
        self.flat_summary.setText(f"{total} รหัส" + (f" · แสดง {len(flats)}" if text else ""))
        self.tabs.setTabText(3, f"คลังรูปคลี่ ({total})")

    def _flat_selected(self) -> None:
        rows = selected_rows(self.flats)
        self.flat_view.show_flat(self._flats[rows[0]] if rows and rows[0] < len(self._flats) else None)

    def save_flats_from_partlist(self) -> None:
        pl = self.state.partlist
        n = self.state.flats.add_parts(pl.parts, pl.info.drawing_no, pl.info.revision, Path(self.state.path).name)
        self.state.save_laser()
        self.state.notify(f"บันทึกรูปคลี่ {n} รหัสเข้าคลัง" if n else "Part List ไม่มีแถวที่มีทั้งรหัสและรูปคลี่")

    def remove_flats(self) -> None:
        codes = [self._flats[r].code for r in selected_rows(self.flats) if r < len(self._flats)]
        if codes and QMessageBox.question(self, "ลบรูปคลี่", f"ลบรูปคลี่ {len(codes)} รหัสออกจากคลัง?") == QMessageBox.Yes:
            self.state.flats.remove(codes)
            self.state.save_laser()
