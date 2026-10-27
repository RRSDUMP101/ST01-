"""ตัดเหล็ก / เลเซอร์ - cutting plan from the flat patterns, checks before cutting, the laser queue and the
library of flat patterns (คลังรูปคลี่) that links the drawings to the production jobs."""

from __future__ import annotations

import tempfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QPointF, Qt, QUrl
from PySide6.QtGui import QBrush, QColor, QDesktopServices, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFileDialog, QGroupBox,
                               QFormLayout, QFrame, QGraphicsScene, QGraphicsView, QGridLayout, QHBoxLayout, QLabel,
                               QLineEdit, QListWidget, QListWidgetItem, QMenu, QMessageBox, QScrollArea, QSpinBox,
                               QSplitter, QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from ...core import laser, nesting
from ...core.nesting import Placement
from ...core.stock import find_by_code, material_family
from .. import theme
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

    def show_layout(self, sheet: nesting.SheetLayout | None, parts: list, label: str = "", new_from: int | None = None,
                    params: nesting.NestParams | None = None) -> None:
        """One sheet; placements from index `new_from` on are drawn green (pieces being added), free space shaded."""
        self.scene().clear()
        if sheet is None:
            return
        sheet_pen, part_pen, hole_pen = self._pens()
        self._sheet(0, sheet.width, sheet.height, label or sheet.size, sheet_pen)
        if params is not None:  # the free rectangles the new pieces can go in
            free_pen = QPen(QColor("#2E9D5B"))
            free_pen.setCosmetic(True)
            free_pen.setStyle(Qt.DotLine)
            m = params.margin
            base = nesting.SheetLayout(sheet.width, sheet.height,
                                       placements=sheet.placements[:new_from] if new_from is not None else sheet.placements)
            for fx, fy, fw, fh in nesting.free_space(base, params).free:
                w, h = fw - params.gap, fh - params.gap
                if w > 1 and h > 1:
                    self.scene().addRect(fx + m, -(fy + m) - h, w, h, free_pen, QBrush(QColor(46, 157, 91, 25)))
        new_pen = QPen(QColor("#2ECC71"))
        new_pen.setCosmetic(True)
        new_pen.setWidthF(1.5)
        for i, pl in enumerate(sheet.placements):
            is_new = new_from is not None and i >= new_from
            self._part(parts[pl.part], pl, 0, new_pen if is_new else part_pen, hole_pen)
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
        self.resize(780, 720)
        self.params = params
        outer = QVBoxLayout(self)
        self.tabs = QTabWidget()
        outer.addWidget(self.tabs, 1)
        page = QWidget()
        lay = QVBoxLayout(page)
        self.tabs.addTab(page, "เครื่อง · ความเร็ว · ไฟล์")
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
        self.mark = QCheckBox("มาร์ครหัสชิ้นงานบนชิ้น")
        self.mark.setChecked(params.mark_codes)
        self.sheet = QCheckBox("วาดกรอบแผ่นในไฟล์ (เลเยอร์ SHEET – ระวังเครื่องตัดตามกรอบ)")
        self.sheet.setChecked(params.sheet_outline)
        form.addWidget(self.sheet, 6, 0, 1, 4)
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
        self.tabs.addTab(self._build_precut(params), "ก่อนส่งตัด (Mark · Nest · Gap)")
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        box.button(QDialogButtonBox.Ok).setText("บันทึก")
        box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        outer.addWidget(box)

    def _build_precut(self, params: laser.LaserParams) -> QWidget:
        """What goes into the laser files besides the cut lines: marks, how parts are laid out, joints."""
        page = QWidget()
        lay = QVBoxLayout(page)

        def spin(value: float, lo: float, hi: float, suffix: str, decimals: int = 1) -> QDoubleSpinBox:
            w = QDoubleSpinBox()
            w.setRange(lo, hi)
            w.setDecimals(decimals)
            w.setSuffix(suffix)
            w.setValue(float(value))
            w.setMaximumWidth(140)
            return w

        def hint(text: str) -> QLabel:
            label = QLabel(text)
            label.setObjectName("Hint")
            label.setWordWrap(True)
            return label

        mark = QGroupBox("Mark – มาร์คบนชิ้นงาน (เลเยอร์ MARK: เลเซอร์กำลังต่ำ ไม่ตัดขาด)")
        form = QFormLayout(mark)
        form.addRow(self.mark)
        self.mark_bends = QComboBox()
        for key, label in laser.MARK_BENDS.items():
            self.mark_bends.addItem(label, key)
        self.mark_bends.setCurrentIndex(max(0, self.mark_bends.findData(params.mark_bends)))
        form.addRow("เส้นพับ", self.mark_bends)
        self.mark_tick = spin(params.mark_tick, 1, 100, " มม.")
        form.addRow("ความยาวขีดที่ขอบ", self.mark_tick)
        form.addRow(hint("เส้นพับอ่านจากแบบ (เลเยอร์ BEND/พับ/CENTER หรือเส้นตรงที่ผ่าชิ้นจากขอบถึงขอบ) – "
                         "ช่างพับเห็นตำแหน่งพับบนชิ้น · ตั้งเลเยอร์ MARK ในซอฟต์แวร์ของเครื่องเป็นงานมาร์คก่อน "
                         "(ทดสอบด้วย ส่งออก ▾ → ไฟล์ทดสอบเลเยอร์) มิฉะนั้นเครื่องจะตัดตามเส้นมาร์ค"))
        lay.addWidget(mark)

        nest = QGroupBox("Nest – วางชิ้นงานบนแผ่น")
        form = QFormLayout(nest)
        self.gap_per_mm = spin(params.gap_per_mm, 0, 5, "", 2)
        self.gap_per_mm.setSpecialValueText("ไม่ใช้ (ระยะเท่ากันทุกความหนา)")
        form.addRow("ระยะห่างชิ้นงาน แผ่นหนา = ความหนา ×", self.gap_per_mm)
        self.align = QCheckBox("หมุนชิ้นที่วาดเอียงให้ได้แผ่นตั้งต้นเล็กที่สุดก่อนวาง")
        self.align.setChecked(params.align_parts)
        form.addRow(self.align)
        form.addRow(hint("ระยะห่างขั้นต่ำ ขอบแผ่น และหมุน 90° ตั้งที่หน้า วางแผนตัด – แผ่นหนาใช้ระยะที่มากกว่า "
                         "(เช่น หนา 12 มม. × 1 = 12 มม.) กันความร้อนทำชิ้นข้างเคียงเสียรูป"))
        lay.addWidget(nest)

        gap = QGroupBox("Gap / Micro-joint – เว้นไม่ตัดบางจุดให้ชิ้นติดแผ่น (ไม่กระดก/ไม่ตกร่องโต๊ะ)")
        form = QFormLayout(gap)
        self.joints = QComboBox()
        for key, label in laser.JOINTS.items():
            self.joints.addItem(label, key)
        self.joints.setCurrentIndex(max(0, self.joints.findData(params.joints)))
        form.addRow("ใส่ที่", self.joints)
        self.joint_small = spin(params.joint_small, 10, 2000, " มม.", 0)
        form.addRow("ชิ้นเล็ก = ด้านยาวน้อยกว่า", self.joint_small)
        self.joint_width = spin(params.joint_width, 0.1, 5, " มม.", 2)
        form.addRow("ความกว้างที่เว้น", self.joint_width)
        self.joint_count = QSpinBox()
        self.joint_count.setRange(0, 20)
        self.joint_count.setSpecialValueText("อัตโนมัติตามขนาด")
        self.joint_count.setValue(int(params.joint_count))
        self.joint_count.setMaximumWidth(160)
        form.addRow("จำนวนจุดต่อชิ้น", self.joint_count)
        form.addRow(hint("1 จุด = Gap ที่ปลายเส้นตัด · อัตโนมัติ: 2 จุดสำหรับชิ้นรอบไม่เกิน 600 มม. แล้วเพิ่ม 1 จุดทุก 600 มม. "
                         "(สูงสุด 8) วางกลางด้านที่ยาวที่สุด · เส้นรอบนอกจะเป็นเส้นเปิด – ปิดตัวเลือก "
                         "\u201cต่อเส้นอัตโนมัติ\u201d ตอนนำเข้าในซอฟต์แวร์ของเครื่อง หรือใส่ Gap ในเครื่องแทน"))
        lay.addWidget(gap)
        lay.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidget(page)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        return scroll

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
        p.mark_bends, p.mark_tick = self.mark_bends.currentData(), self.mark_tick.value()
        p.gap_per_mm, p.align_parts = self.gap_per_mm.value(), self.align.isChecked()
        p.joints, p.joint_small = self.joints.currentData(), self.joint_small.value()
        p.joint_width, p.joint_count = self.joint_width.value(), self.joint_count.value()
        p.machine = self.machine.currentText()
        for key, combo in self.colors.items():
            setattr(p, key, int(combo.currentData()))
        p.bed_w, p.bed_l = self.bed_w.value(), self.bed_l.value()
        return p


class SheetSizesDialog(QDialog):
    """ขนาดแผ่นเพิ่มเอง: sheet sizes the plan may use besides the plates in stock (sizes the store can buy or has
    without a code), for every thickness or one thickness."""

    HEADERS = ("กว้าง (มม.)", "ยาว (มม.)", "หนา (มม.) – 0 = ทุกความหนา", "หมายเหตุ")
    PRESETS = (("4x8 ฟุต", 1219, 2440), ("4x10 ฟุต", 1219, 3048), ("5x10 ฟุต", 1524, 3048), ("5x20 ฟุต", 1524, 6096),
               ("1500x3000", 1500, 3000), ("1500x6000", 1500, 6000), ("2000x6000", 2000, 6000))

    def __init__(self, rows: list, bed: tuple[float, float], parent=None):
        super().__init__(parent)
        self.setWindowTitle("ขนาดแผ่นเหล็กเพิ่มเอง")
        self.resize(720, 420)
        self.bed = tuple(sorted(bed))
        lay = QVBoxLayout(self)
        hint = QLabel("ขนาดแผ่นที่แผนตัดเลือกใช้ได้ นอกจากแผ่นเหล็กที่มีในสต็อก (เช่น ขนาดที่สั่งซื้อได้ หรือแผ่นที่ยังไม่มีรหัส) "
                      "· หนา 0 = ใช้กับทุกความหนา · ใหญ่กว่าโต๊ะเครื่อง "
                      f"{bed[0]:.0f}x{bed[1]:.0f} มม. ขึ้นสีแดง (ตัดไม่ได้)")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self.table = QTableWidget(0, len(self.HEADERS))
        self.table.setHorizontalHeaderLabels(list(self.HEADERS))
        for i, w in enumerate([110, 110, 190, 220]):
            self.table.setColumnWidth(i, w)
        self.table.itemChanged.connect(self._mark)
        for row in rows:
            self._add(*row)
        lay.addWidget(self.table, 1)
        tools = QHBoxLayout()
        self.preset = QComboBox()
        self.preset.addItem("+ เพิ่มขนาด…", None)
        for name, w, h in self.PRESETS:
            self.preset.addItem(f"{name} ({w} x {h})", (w, h, name))
        self.preset.addItem("กำหนดเอง (พิมพ์ในตาราง)", (1219, 2440, ""))
        self.preset.activated.connect(self._preset)
        tools.addWidget(self.preset)
        remove = button("ลบแถวที่เลือก")
        remove.clicked.connect(self._remove)
        tools.addWidget(remove)
        tools.addStretch(1)
        lay.addLayout(tools)
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        box.button(QDialogButtonBox.Ok).setText("บันทึก")
        box.button(QDialogButtonBox.Ok).setProperty("kind", "primary")
        box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)

    def _add(self, w: float, h: float, thk: float = 0, note: str = "") -> None:
        r = self.table.rowCount()
        self.table.blockSignals(True)
        self.table.insertRow(r)
        for c, value in enumerate((f"{w:g}", f"{h:g}", f"{thk:g}", note)):
            self.table.setItem(r, c, QTableWidgetItem(value))
        self.table.blockSignals(False)
        self._mark()

    def _preset(self, index: int) -> None:
        data = self.preset.itemData(index)
        self.preset.setCurrentIndex(0)
        if data:
            self._add(data[0], data[1], 0, data[2])
            self.table.setCurrentCell(self.table.rowCount() - 1, 0)

    def _remove(self) -> None:
        for r in sorted({i.row() for i in self.table.selectedIndexes()}, reverse=True):
            self.table.removeRow(r)

    def _number(self, r: int, c: int) -> float:
        item = self.table.item(r, c)
        try:
            return float((item.text() if item else "").replace(",", "").strip() or 0)
        except ValueError:
            return 0.0

    def _mark(self, *args) -> None:
        self.table.blockSignals(True)
        for r in range(self.table.rowCount()):
            w, h = sorted((self._number(r, 0), self._number(r, 1)))
            too_big = self.bed[0] and (w > self.bed[0] or h > self.bed[1])
            bad = w <= 0 or h <= 0
            for c in range(2):
                item = self.table.item(r, c)
                if item:
                    item.setBackground(theme.ERROR_BG if bad or too_big else QBrush())
                    item.setToolTip("ใหญ่กว่าโต๊ะเครื่อง – ตัดไม่ได้" if too_big else "")
        self.table.blockSignals(False)

    def rows(self) -> list[tuple[float, float, float, str]]:
        out = []
        for r in range(self.table.rowCount()):
            w, h, thk = self._number(r, 0), self._number(r, 1), self._number(r, 2)
            note = self.table.item(r, 3).text().strip() if self.table.item(r, 3) else ""
            if w > 0 and h > 0:
                out.append((w, h, max(0.0, thk), note))
        return out


class FillDialog(QDialog):
    """เพิ่มชิ้นลงที่ว่าง: pick a flat pattern of the same material and thickness and nest it by hand in the free
    space of a sheet (as many as asked, or as many as fit). The parts already there do not move."""

    HEADERS = ["รหัส", "ชิ้นส่วน", "ขนาด (มม.)", "พื้นที่ (ม²)"]

    def __init__(self, title: str, flats: list, sheets: list[tuple[str, nesting.SheetLayout, list]],
                 params: nesting.NestParams, align: bool = True, parent=None):
        super().__init__(parent)
        self.setWindowTitle("เพิ่มชิ้นลงที่ว่างบนแผ่น")
        self.resize(1100, 720)
        self.flats, self.sheets, self.params, self.align = flats, sheets, params, align
        lay = QVBoxLayout(self)
        head = QLabel(f"<b>{title}</b> · เลือกชิ้นจากคลังรูปคลี่ที่วัสดุ/ความหนาเดียวกับแผ่น แล้วใส่จำนวน "
                      "– โปรแกรมวางในที่ว่าง (กรอบเขียว) โดยเว้นระยะห่างชิ้นและขอบแผ่น ชิ้นเดิมไม่ขยับ")
        head.setWordWrap(True)
        lay.addWidget(head)
        row = QHBoxLayout()
        self.sheet = QComboBox()
        for label, _sheet, _parts in sheets:
            self.sheet.addItem(label)
        self.sheet.setVisible(len(sheets) > 1)
        self.sheet.currentIndexChanged.connect(self._trial)
        if len(sheets) > 1:
            row.addWidget(QLabel("แผ่น"))
            row.addWidget(self.sheet)
        self.search = QLineEdit()
        self.search.setPlaceholderText("ค้นหา รหัส / ชื่อ …")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self._fill)
        row.addWidget(self.search, 1)
        row.addWidget(QLabel("จำนวนต่อแผ่น"))
        self.qty = QSpinBox()
        self.qty.setRange(0, 9999)
        self.qty.setSpecialValueText("เต็มที่ว่าง")
        self.qty.setValue(0)
        self.qty.valueChanged.connect(self._trial)
        row.addWidget(self.qty)
        lay.addLayout(row)
        split = QSplitter(Qt.Horizontal)
        self.list = table(self.HEADERS, [140, 200, 110, 80])
        self.list.itemSelectionChanged.connect(self._trial)
        split.addWidget(self.list)
        self.view = SheetView()
        split.addWidget(self.view)
        split.setSizes([480, 620])
        lay.addWidget(split, 1)
        self.info = QLabel()
        self.info.setObjectName("Hint")
        lay.addWidget(self.info)
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        self.ok = box.button(QDialogButtonBox.Ok)
        self.ok.setText("เพิ่มลงแผ่น")
        self.ok.setProperty("kind", "primary")
        box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)
        self.placed = 0
        self._shown: list = []
        self._fill()

    def _fill(self) -> None:
        text = self.search.text().strip().lower()
        self._shown = [f for f in self.flats if not text or text in f"{f.code} {f.name}".lower()]
        fill(self.list, [[f.code, f.name, "{:.0f} x {:.0f}".format(*f.size), round(f.net_area / 1e6, 4)]
                         for f in self._shown])
        if self._shown:
            self.list.selectRow(0)
        else:
            self._trial()

    def flat(self):
        rows = selected_rows(self.list)
        return self._shown[rows[0]] if rows and rows[0] < len(self._shown) else None

    def part(self) -> nesting.NestPart | None:
        flat = self.flat()
        return laser.extra_part(flat, self.align) if flat is not None else None

    def sheet_index(self) -> int:
        return max(0, self.sheet.currentIndex())

    def _trial(self, *_args) -> None:
        label, sheet, parts = self.sheets[self.sheet_index()]
        part = self.part()
        trial = nesting.SheetLayout(sheet.width, sheet.height, list(sheet.placements), sheet.code, sheet.name)
        self.placed = nesting.fill_sheet(trial, len(parts), part, self.qty.value(), self.params) if part else 0
        self.view.show_layout(trial, list(parts) + ([part] if part else []), label, len(sheet.placements), self.params)
        free = nesting.free_pct(trial, self.params)
        if part is None:
            self.info.setText("ไม่มีรูปคลี่ที่วัสดุ/ความหนาเดียวกับแผ่นนี้ในคลังรูปคลี่" if not self.flats else "เลือกชิ้นส่วน")
        elif self.placed == 0:
            self.info.setText(f"{part.code} ({part.width:.0f} x {part.height:.0f} มม.) ไม่มีที่ว่างพอบนแผ่นนี้")
        else:
            want = self.qty.value()
            self.info.setText(f"วาง {part.code} ได้ {self.placed} ชิ้น/แผ่น"
                              + (f" (ขอ {want} – ที่ว่างพอแค่ {self.placed})" if want and self.placed < want else "")
                              + f" · ที่ว่างเหลือประมาณ {free:.0%} ของแผ่น · ชิ้นที่เพิ่มไม่มีงานผลิต (ตัดเก็บสต็อก/สำรอง)")
        self.ok.setEnabled(self.placed > 0)


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
        self.sheet_chosen: dict[tuple[str, float], tuple[float, float]] = {}  # (family, thk) -> (w, l) picked by hand
        self.sheet_overflow: dict[tuple[str, float], list[tuple]] = {}  # sheets picked for the parts too big for it
        self._nest_params = nesting.NestParams()
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
        plan_tools = QHBoxLayout()
        self.fill_plan_btn = button("เพิ่มชิ้นลงที่ว่าง…", tooltip="เลือกชิ้นจากคลังรูปคลี่ (วัสดุ/ความหนาเดียวกัน) "
                                                                 "วางเพิ่มในที่ว่างของแผ่นในแผนที่เลือก")
        self.fill_plan_btn.clicked.connect(self.fill_plan)
        self.fill_plan_btn.setEnabled(False)
        plan_tools.addWidget(self.fill_plan_btn)
        plan_tools.addSpacing(16)
        plan_tools.addWidget(QLabel("ขนาดแผ่นของแถวที่เลือก"))
        self.sheet_choice = QComboBox()
        self.sheet_choice.setMinimumWidth(380)
        self.sheet_choice.setToolTip("เปลี่ยนขนาดแผ่นเหล็กที่ใช้ตัดวัสดุ/ความหนานี้ – อัตโนมัติ = ขนาดที่ใช้เหล็กน้อยที่สุด · "
                                     "รายการมาจากแผ่นเหล็กในสต็อก และขนาดที่เพิ่มเอง")
        self.sheet_choice.setEnabled(False)
        self.sheet_choice.activated.connect(self._sheet_chosen)
        plan_tools.addWidget(self.sheet_choice)
        self.sizes_btn = button("ขนาดแผ่นเพิ่มเอง…", tooltip="เพิ่มขนาดแผ่นเหล็กที่ใช้วางแผนได้ นอกจากที่มีในสต็อก")
        self.sizes_btn.clicked.connect(self.edit_sheet_sizes)
        plan_tools.addWidget(self.sizes_btn)
        plan_tools.addStretch(1)
        lay.addLayout(plan_tools)
        split = QSplitter(Qt.Vertical)
        self.table = table(nesting.PLAN_HEADERS, [120, 70, 330, 110, 110, 80, 90, 70, 80, 60, 90, 300])
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
                ("เพิ่มชิ้นลงที่ว่าง…", self.fill_program, "",
                 "โปรแกรมที่ยังรอตัด: เลือกชิ้นจากคลังรูปคลี่ วางเพิ่มในที่ว่างของแผ่น (ทุกแผ่นของโปรแกรม)"),
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
        self._drop_sheet_boxes()
        fill(self.table, [])
        self.view.show_group(None)
        self.make_btn.setEnabled(False)
        self.fill_plan_btn.setEnabled(False)
        self._show_sheet_choice(None)
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
        self._lay_out(params)
        self.state.notify(f"แผนตัด {sum(len(g.sheets) for g in self.groups)} แผ่น")

    def _lay_out(self, params: laser.LaserParams, select: tuple[str, float] | None = None) -> None:
        """Nest the parts of the demand on the sheets (the sizes chosen per material/thickness, or the ones with
        the least steel) and show the plan."""
        demand = self.demand
        self._nest_params = params.nest_params()
        self.groups = nesting.plan(demand.parts, self.state.stock, self._nest_params, self.state.settings.densities,
                                   self.state.settings.custom_sheets, self.sheet_chosen, self.sheet_overflow)
        self.issues = laser.check_parts(demand.parts, params, self.groups)
        rows = nesting.plan_rows(self.groups)
        self._row_group = []
        for g in self.groups:
            self._row_group += [g] * max(1, len(g.sheet_counts()))
        fill(self.table, rows)
        self._sheet_boxes()
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
            at = next((self._row_group.index(g) for g in self.groups if g.key == select), 0) if select else 0
            self.table.clearSelection()  # the same row again is still a new plan: show it
            self.table.selectRow(at)

    def _show_checks(self) -> None:
        demand = self.demand or laser.Demand()
        job_of = {p.key: p.job for p in demand.parts}
        rows = [["ต้องแก้", code, name, job, f"{why} – {qty:g} ชิ้น"] for job, code, name, qty, why in demand.missing]
        rows += [[laser.LEVEL_TEXT.get(i.level, i.level), i.code, i.name, job_of.get(i.key, ""), i.text]
                 for i in sorted(self.issues, key=lambda i: [laser.ERROR, laser.WARN, laser.INFO].index(i.level))]
        fill(self.checks, rows, status_col=0)
        n = sum(1 for r in rows if r[0] != laser.LEVEL_TEXT[laser.INFO])
        self.tabs.setTabText(1, f"ตรวจก่อนตัด ({n})" if n else "ตรวจก่อนตัด")

    def _selected(self) -> None:
        rows = selected_rows(self.table)
        group = self._row_group[rows[0]] if rows and rows[0] < len(self._row_group) else None
        if group is not None:
            self.view.show_group(group)
        self.fill_plan_btn.setEnabled(bool(rows))
        self._show_sheet_choice(group)

    def _sheet_label(self, option: tuple) -> str:
        """'01-B00 -0003 เหล็กแผ่นดำ 2.5 มม.4x8ฟุต · 1219 x 2440 · คงเหลือ 6 แผ่น'."""
        w, h, code, name = option
        item = find_by_code(code, self.state.stock) if code else None
        where = (f"คงเหลือ {item.on_hand:g} {item.unit_name or 'แผ่น'}" if item is not None
                 else "เพิ่มเอง" if name.startswith(nesting.CUSTOM) else "ขนาดมาตรฐาน (ไม่มีในสต็อก)")
        label = " ".join(x for x in (code, name.split(": ", 1)[-1]) if x)
        return f"{label} · {w:.0f} x {h:.0f} มม. · {where}"

    def _fill_sheet_box(self, box: QComboBox, group: nesting.NestGroup | None, in_table: bool = False) -> None:
        """The sheets the material/thickness can be cut from - each plate of the steel stock (with its balance),
        the sizes added by hand and the standard sizes; the one in use is selected."""
        box.blockSignals(True)
        box.clear()
        if group is not None:
            used = next((o for o in group.options if o[2] and o[2] == group.sheet_code), None) or next(
                (o for o in group.options if nesting.same_size(o, (group.sheet_w, group.sheet_h))), None)
            auto = "อัตโนมัติ – ใช้เหล็กน้อยที่สุด"
            if in_table and not group.chosen and used is not None:
                auto = f"{used[3].split(': ', 1)[-1]} (อัตโนมัติ)"
            box.addItem(auto, None)
            for option in group.options:
                box.addItem(self._sheet_label(option), (option[0], option[1], option[2]))
            if group.chosen and used is not None:
                at = next((n for n in range(1, box.count()) if box.itemData(n)[2] == used[2]
                           and nesting.same_size(box.itemData(n), used)), 0)
                box.setCurrentIndex(at)
            box.setToolTip("เลือกแผ่นเหล็กที่ใช้ตัดวัสดุ/ความหนานี้ – รายการจากสต็อกเหล็ก (รหัส · ขนาด · คงเหลือ) "
                           "ขนาดที่เพิ่มเอง และขนาดมาตรฐาน · อัตโนมัติ = แผ่นที่ใช้เหล็กน้อยที่สุด")
        box.setEnabled(group is not None)
        box.blockSignals(False)

    @staticmethod
    def _row_option(group: nesting.NestGroup, size: str, code: str) -> tuple | None:
        """The option of the group a row of the plan is cut from (its stock code, else its size)."""
        w, h = (float(v) for v in size.split("x"))
        return next((o for o in group.options if code and o[2] == code), None) or next(
            (o for o in group.options if nesting.same_size(o, (w, h))), None)

    def _fill_overflow_box(self, box: QComboBox, group: nesting.NestGroup, k: int) -> None:
        """Row k (> 0) of a material/thickness: the sheets the parts too big for the main sheet are cut from -
        only the sizes all of them fit on."""
        size, code, name, _n = group.sheet_counts()[k]
        used = self._row_option(group, size, code)
        picked = used is not None and any(o[2] == used[2] and nesting.same_size(o, used) for o in group.overflow)
        box.blockSignals(True)
        box.clear()
        box.addItem("อัตโนมัติ – แผ่นเล็กสุดที่ชิ้นใหญ่วางได้" if picked else
                    f"{name.split(': ', 1)[-1]} (อัตโนมัติ – ชิ้นใหญ่เกินแผ่นหลัก)", None)
        for option in nesting.overflow_options(group, size, self._nest_params):
            box.addItem(self._sheet_label(option), (option[0], option[1], option[2]))
            if picked and option[2] == used[2] and nesting.same_size(option, used):
                box.setCurrentIndex(box.count() - 1)
        box.setToolTip("ชิ้นงานที่ใหญ่เกินแผ่นหลักของความหนานี้ ตัดจากแผ่นนี้ – เลือกแผ่นอื่นที่ชิ้นเหล่านี้วางได้ "
                       "(รหัส · ขนาด · คงเหลือจากสต็อกเหล็ก) · อัตโนมัติ = แผ่นเล็กสุดที่วางได้")
        box.blockSignals(False)

    def _sheet_boxes(self) -> None:
        """A drop-down in the แผ่นที่ใช้ column of every row: the first row of a material/thickness picks its
        main sheet, the next rows the sheets of the parts too big for it."""
        col = self._drop_sheet_boxes()
        row = 0
        for group in self.groups:
            for k in range(max(1, len(group.sheet_counts()))):
                box = QComboBox()
                box.setSizeAdjustPolicy(QComboBox.AdjustToMinimumContentsLengthWithIcon)
                box.view().setMinimumWidth(560)
                if k == 0:
                    self._fill_sheet_box(box, group, in_table=True)
                    box.activated.connect(lambda i, b=box, key=group.key: self._sheet_picked(key, b.itemData(i)))
                else:
                    self._fill_overflow_box(box, group, k)
                    box.activated.connect(lambda i, b=box, g=group, k=k: self._overflow_picked(g, k, b.itemData(i)))
                self.table.setCellWidget(row + k, col, box)
            row += max(1, len(group.sheet_counts()))

    def _drop_sheet_boxes(self) -> int:
        """Take the drop-downs of the last plan out of the table (hidden at once: Qt deletes them later)."""
        col = nesting.PLAN_HEADERS.index("แผ่นที่ใช้")
        for r in range(self.table.rowCount()):
            box = self.table.cellWidget(r, col)
            if box is not None:
                box.hide()
                self.table.removeCellWidget(r, col)
        return col

    def _show_sheet_choice(self, group: nesting.NestGroup | None) -> None:
        self._fill_sheet_box(self.sheet_choice, group)

    def _sheet_chosen(self, index: int) -> None:
        group = self._group()
        if group is not None:
            self._sheet_picked(group.key, self.sheet_choice.itemData(index))

    def _sheet_picked(self, key: tuple[str, float], sheet: tuple | None) -> None:
        """A sheet picked for one material/thickness (None = automatic): lay out that plan again."""
        if self.demand is None:
            return
        if sheet is None:
            self.sheet_chosen.pop(key, None)
        else:
            self.sheet_chosen[key] = tuple(sheet)
        self._lay_out(self.laser_params(), key)
        new = next((g for g in self.groups if g.key == key), None)
        if new is not None:
            name = " ".join(x for x in (new.sheet_code, new.sheet_name.split(": ", 1)[-1]) if x)
            self.state.notify(f"{new.family} หนา {new.thickness:g} มม.: ใช้ {name} ({new.sheet_w:.0f}x{new.sheet_h:.0f}) "
                              f"{len(new.sheets)} แผ่น · ใช้เนื้อเหล็ก {new.utilization:.0%}"
                              + (" (เลือกเอง)" if new.chosen else " (อัตโนมัติ)"))

    def _overflow_picked(self, group: nesting.NestGroup, k: int, sheet: tuple | None) -> None:
        """A sheet picked on row k of a material/thickness for the parts too big for its main sheet (None =
        automatic): the picks of the other rows stay."""
        if self.demand is None:
            return
        picks = []
        for j, (size, code, _name, _n) in enumerate(group.sheet_counts()[1:], start=1):
            if j == k:
                if sheet is not None:
                    picks.append(tuple(sheet))
                continue
            used = self._row_option(group, size, code)
            if used is not None and any(o[2] == used[2] and nesting.same_size(o, used) for o in group.overflow):
                picks.append((used[0], used[1], used[2]))
        if picks:
            self.sheet_overflow[group.key] = picks
            # for the parts too big for this main sheet: it stays, the plan does not move to another size
            self.sheet_chosen.setdefault(group.key, (group.sheet_w, group.sheet_h, group.sheet_code))
        else:
            self.sheet_overflow.pop(group.key, None)
        self._lay_out(self.laser_params(), group.key)
        new = next((g for g in self.groups if g.key == group.key), None)
        if new is not None:
            counts = new.sheet_counts()[1:]
            used = ", ".join(f"{(c + ' ') if c else ''}{s} {n} แผ่น" for s, c, _name, n in counts)
            self.state.notify(f"{new.family} หนา {new.thickness:g} มม.: ชิ้นใหญ่เกินแผ่นหลัก ตัดจาก {used or '-'}"
                              + (" (เลือกเอง)" if new.overflow else " (อัตโนมัติ)"))

    def edit_sheet_sizes(self) -> None:
        p = self.laser_params()
        dialog = SheetSizesDialog(self.state.settings.custom_sheets, (p.bed_w, p.bed_l), self)
        if dialog.exec():
            self.state.settings.custom_sheets = dialog.rows()
            self.state.notify(f"บันทึกขนาดแผ่นเพิ่มเอง {len(dialog.rows())} ขนาด")
            if self.demand is not None and self.groups:
                group = self._group()
                self._lay_out(p, group.key if group else None)
        dialog.deleteLater()

    def _group(self) -> nesting.NestGroup | None:
        rows = selected_rows(self.table)
        return self._row_group[rows[0]] if rows and rows[0] < len(self._row_group) else None

    def fill_plan(self) -> None:
        group = self._group()
        if group is None or not group.sheets:
            return
        params = self.laser_params()
        nest = replace(params.nest_params(), gap=group.gap or params.nest_params().gap_for(group.thickness))
        sheets = [(f"แผ่นที่ {n} · {s.size} · ที่ว่าง {nesting.free_pct(s, nest):.0%}", s, group.parts)
                  for n, s in enumerate(group.sheets, start=1)]
        dialog = FillDialog(f"แผน {group.family} หนา {group.thickness:g} มม.",
                            laser.flats_for(self.state.flats, group.family, group.thickness), sheets, nest,
                            params.align_parts, self)
        if dialog.exec() and dialog.part() is not None:
            n = nesting.add_to_group(group, dialog.sheet_index(), dialog.part(), dialog.qty.value(), params.nest_params())
            rows = nesting.plan_rows(self.groups)
            fill(self.table, rows)
            self.table.selectRow(self._row_group.index(group))
            self.view.show_group(group)
            self.state.notify(f"เพิ่ม {dialog.part().code} {n} ชิ้นลงแผ่นที่ {dialog.sheet_index() + 1}")
        dialog.deleteLater()

    def fill_program(self) -> None:
        prog = self._program()
        if prog is None:
            return
        if prog.status != laser.ST_WAIT or prog.cut_sheets:
            self.actions.error("เพิ่มชิ้นไม่ได้", "เพิ่มชิ้นได้เฉพาะโปรแกรมที่ยังรอตัด")
            return
        params = self.laser_params()
        nest = replace(params.nest_params(), gap=params.nest_params().gap_for(prog.thickness))
        sheet, keys = laser.program_sheet(prog)
        parts = [prog.nest_part(k) for k in keys]
        label = f"{prog.no} · {prog.label} · {prog.sheet_size} × {prog.repeat} แผ่น · ที่ว่าง {nesting.free_pct(sheet, nest):.0%}"
        dialog = FillDialog(f"โปรแกรม {prog.no} (เพิ่มทุกแผ่น × {prog.repeat})",
                            laser.flats_for(self.state.flats, prog.family, prog.thickness), [(label, sheet, parts)],
                            nest, params.align_parts, self)
        if dialog.exec() and dialog.part() is not None:
            try:
                n = laser.add_to_program(prog, dialog.part(), dialog.qty.value(), params)
            except ValueError as exc:
                self.actions.error("เพิ่มชิ้นไม่ได้", str(exc))
                n = 0
            if n:
                self.state.save_laser()
                self._refresh_laser()
                self.state.notify(f"เพิ่ม {dialog.part().code} {n} ชิ้น/แผ่น × {prog.repeat} แผ่น ลงโปรแกรม {prog.no}")
        dialog.deleteLater()

    def make_programs(self) -> None:
        if not self.groups or self.demand is None:
            return
        progs = laser.make_programs(self.groups, self.state.cut_queue, self.laser_params(), self.demand.source)
        self.groups = []
        self.make_btn.setEnabled(False)
        self.fill_plan_btn.setEnabled(False)
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
            images = {p.no: str(laser.program_png(p, Path(tmp) / f"{p.no}.png", params=params)) for p in progs}
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
