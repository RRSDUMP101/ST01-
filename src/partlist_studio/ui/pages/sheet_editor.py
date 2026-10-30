"""จัดวางชิ้นงานบนแผ่น (แผ่นขนาดที่เพิ่มเอง) - add pieces to the free space automatically or one by one by hand, move
and turn every piece freely (any angle), and see at once what cannot be cut: off the sheet, on another piece, or
closer to another piece than the gap."""

from __future__ import annotations

import copy
from dataclasses import replace

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QBrush, QColor, QKeySequence, QPainter, QPainterPath, QPen, QShortcut
from PySide6.QtWidgets import (QAbstractItemView, QButtonGroup, QCheckBox, QComboBox, QDialog, QDialogButtonBox,
                               QDoubleSpinBox,
                               QGraphicsItem, QGraphicsPathItem, QGraphicsScene, QGraphicsSimpleTextItem,
                               QGraphicsView, QHBoxLayout, QLabel, QLineEdit, QRadioButton, QSplitter,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from ...core import laser, nesting
from ..widgets import button, fit_to_screen, table

PIECE = QColor("#F28C28")
EXTRA = QColor("#2ECC71")
BAD = QColor("#FF4D4F")
CLOSE = QColor("#FFD54F")


def is_custom(sheet_name: str) -> bool:
    """A sheet of a size added by hand (ขนาดแผ่นเพิ่มเอง) - the sheets laid out by hand."""
    return (sheet_name or "").startswith(nesting.CUSTOM)


class _Piece(QGraphicsPathItem):
    """One placed piece: drag to move it; its placement follows."""

    def __init__(self, editor: SheetEditor, index: int):
        super().__init__()
        self.editor, self.index = editor, index
        self.setFlags(QGraphicsItem.ItemIsMovable | QGraphicsItem.ItemIsSelectable |
                      QGraphicsItem.ItemSendsGeometryChanges)
        self.setCursor(Qt.OpenHandCursor)
        self.label = QGraphicsSimpleTextItem(self)
        self.label.setBrush(QColor("#E6EDF6"))
        self._moving = False

    def itemChange(self, change, value):  # noqa: N802 - Qt API
        if change == QGraphicsItem.ItemPositionHasChanged and not self.editor.building:
            pl = self.editor.sheet.placements[self.index]
            pl.x, pl.y = self.pos().x(), -self.pos().y() - pl.h
        return super().itemChange(change, value)

    def mousePressEvent(self, event):  # noqa: N802
        self.editor.remember()
        self._moving = True
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):  # noqa: N802
        super().mouseReleaseEvent(event)
        if self._moving:
            self._moving = False
            QTimer.singleShot(0, self.editor.moved)  # redrawn after this item's own event (it is replaced)


class _View(QGraphicsView):
    """The sheet: wheel = zoom, drag a piece = move it, drag the empty sheet = pan, click = put a piece down
    while placing by hand."""

    def __init__(self, editor: SheetEditor):
        super().__init__()
        self.editor = editor
        self.setScene(QGraphicsScene(self))
        self.setRenderHint(QPainter.Antialiasing)
        self.setBackgroundBrush(QColor("#0F1B2B"))
        self.setDragMode(QGraphicsView.RubberBandDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setMinimumHeight(240)

    def wheelEvent(self, event):  # noqa: N802
        factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
        self.scale(factor, factor)

    def mousePressEvent(self, event):  # noqa: N802
        if self.editor.pending and event.button() == Qt.LeftButton:
            p = self.mapToScene(event.position().toPoint())
            self.editor.drop_at(p.x(), -p.y())
            return
        if self.editor.pending and event.button() == Qt.RightButton:
            self.editor.stop_placing()
            return
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event):  # noqa: N802 - on the empty sheet: the whole sheet
        if self.itemAt(event.position().toPoint()) is None or not isinstance(
                self.itemAt(event.position().toPoint()), _Piece):
            self.fit()
            return
        super().mouseDoubleClickEvent(event)

    def keyPressEvent(self, event):  # noqa: N802
        if not self.editor.key(event):
            super().keyPressEvent(event)

    def fit(self) -> None:
        rect = self.scene().itemsBoundingRect()
        if not rect.isNull():
            m = max(rect.width(), rect.height()) * 0.03
            self.fitInView(rect.adjusted(-m, -m, m, m), Qt.KeepAspectRatio)


class SheetEditor(QDialog):
    """sheets: [(label, SheetLayout)] edited on copies, sharing one list of parts (placement.part = index in it);
    flats: the flat patterns of the same material and thickness that can be added (cut for stock / spare)."""

    def __init__(self, title: str, sheets: list[tuple[str, nesting.SheetLayout]], parts: list[nesting.NestPart],
                 flats: list, params: nesting.NestParams, align: bool = True, parent=None):
        super().__init__(parent)
        self.setWindowTitle("จัดวางชิ้นงานบนแผ่น (แผ่นขนาดที่เพิ่มเอง)")
        fit_to_screen(self, 1320, 820)
        self.params, self.align = params, align
        self.labels = [label for label, _s in sheets]
        self.layouts = [copy.deepcopy(s) for _label, s in sheets]  # the plan / program changes only on บันทึก
        self.parts = list(parts)
        self.flats = flats
        self.current = 0
        self.pending: list[int] = []  # pieces (part index) waiting to be put down by hand
        self.building = False
        self.undo: list[tuple[int, list, int]] = []
        self.items: list[_Piece] = []
        self.problems: dict[int, tuple[str, str]] = {}

        lay = QVBoxLayout(self)
        head = QLabel(f"<b>{title}</b> · ลากชิ้นงานเพื่อย้าย · หมุนได้ทุกมุม · เพิ่มชิ้นจากคลังรูปคลี่แบบวางอัตโนมัติในที่ว่าง หรือ "
                      "วางเองทีละชิ้น (คลิกบนแผ่น) · สีแดง = ตัดไม่ได้ (เกินขอบแผ่น / ทับกัน) · สีเหลือง = ชิดกัน หรือชิดขอบเกินระยะ")
        head.setWordWrap(True)
        lay.addWidget(head)
        split = QSplitter(Qt.Horizontal)
        split.setChildrenCollapsible(False)

        # ---- left: the pieces to add
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 6, 0)
        cap = QLabel("<b>เพิ่มชิ้นส่วนลงแผ่น</b> – ติ๊กชิ้นที่จะเพิ่ม แล้วใส่จำนวน")
        ll.addWidget(cap)
        self.search = QLineEdit()
        self.search.setPlaceholderText("ค้นหา รหัส / ชื่อ …")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self._fill_flats)
        ll.addWidget(self.search)
        ticks = QHBoxLayout()
        self.check_all = QCheckBox("เลือกทั้งหมด")
        self.check_all.setToolTip("ติ๊กทุกชิ้นที่แสดงในรายการ (ตามคำค้นหา) · กดอีกครั้ง = เอาติ๊กออกทั้งหมด "
                                  "· คลิกหัวคอลัมน์ เพิ่ม ก็ได้")
        self.check_all.clicked.connect(self._check_all_clicked)
        ticks.addWidget(self.check_all)
        ticks.addStretch(1)
        self.tick_count = QLabel()
        self.tick_count.setObjectName("Hint")
        ticks.addWidget(self.tick_count)
        ll.addLayout(ticks)
        self.flat_table = table(["เพิ่ม", "รหัส", "จำนวน", "ขนาด (มม.)", "ชิ้นส่วน"], [44, 115, 56, 84, 120], editable=True)
        self.flat_table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.flat_table.horizontalHeaderItem(0).setToolTip("คลิก = เลือกทั้งหมด / เอาออกทั้งหมด")
        self.flat_table.horizontalHeader().sectionClicked.connect(self._header_clicked)
        self.flat_table.itemChanged.connect(self._flat_edited)
        ll.addWidget(self.flat_table, 1)
        mode = QHBoxLayout()
        self.auto = QRadioButton("อัตโนมัติ – วางในที่ว่าง")
        self.auto.setToolTip("โปรแกรมหาที่ว่างบนแผ่นให้ (เว้นระยะห่างชิ้นและขอบแผ่น) · จำนวน 0 = เต็มที่ว่าง")
        self.manual = QRadioButton("วางเอง – คลิกบนแผ่น")
        self.manual.setToolTip("คลิกบนแผ่นทีละชิ้นตรงที่ต้องการวาง (กลางชิ้นอยู่ที่จุดคลิก) · Esc = เลิกวาง")
        self.auto.setChecked(True)
        self._modes = QButtonGroup(self)
        self._modes.addButton(self.auto)
        self._modes.addButton(self.manual)
        mode.addWidget(self.auto)
        mode.addWidget(self.manual)
        ll.addLayout(mode)
        self.add_btn = button("เพิ่มลงแผ่น", "primary", "เพิ่มชิ้นที่ติ๊กตามจำนวนที่ใส่ แบบที่เลือกด้านบน")
        self.add_btn.clicked.connect(self.add_checked)
        ll.addWidget(self.add_btn)
        split.addWidget(left)

        # ---- right: the sheet
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(6, 0, 0, 0)
        tools = QHBoxLayout()
        self.sheet_box = QComboBox()
        for label in self.labels:
            self.sheet_box.addItem(label)
        self.sheet_box.setVisible(len(self.labels) > 1)
        self.sheet_box.currentIndexChanged.connect(self._show_sheet)
        tools.addWidget(self.sheet_box)
        for text, tip, slot in (("↺ 90°", "หมุนชิ้นที่เลือกทวนเข็ม 90° (R)", lambda: self.rotate_by(90)),
                                ("↻ 90°", "หมุนชิ้นที่เลือกตามเข็ม 90° (Shift+R)", lambda: self.rotate_by(-90)),
                                ("−5°", "หมุนตามเข็ม 5° ( [ )", lambda: self.rotate_by(-5)),
                                ("+5°", "หมุนทวนเข็ม 5° ( ] )", lambda: self.rotate_by(5))):
            b = button(text, tooltip=tip)
            b.clicked.connect(slot)
            tools.addWidget(b)
        tools.addWidget(QLabel("มุม"))
        self.angle = QDoubleSpinBox()
        self.angle.setRange(-360, 360)
        self.angle.setDecimals(1)
        self.angle.setSingleStep(1)
        self.angle.setSuffix(" °")
        self.angle.setToolTip("มุมของชิ้นที่เลือก (ทวนเข็ม) – พิมพ์มุมอิสระแล้วกด Enter · ใช้กับชิ้นที่จะวางเองต่อไปด้วย")
        self.angle.editingFinished.connect(self._angle_typed)
        tools.addWidget(self.angle)
        self.remove_btn = button("เอาออก", tooltip="เอาชิ้นที่เลือกออกจากแผ่น (Delete) – ชิ้นของงานผลิตกลับไปรอวางแผนตัดครั้งต่อไป")
        self.remove_btn.clicked.connect(self.remove_selected)
        tools.addWidget(self.remove_btn)
        self.repack_btn = button("วางใหม่อัตโนมัติทั้งแผ่น", tooltip="จัดทุกชิ้นบนแผ่นนี้ใหม่ให้ชิดกันแบบอัตโนมัติ "
                                                                   "(กรอบสี่เหลี่ยม หมุน 90° ได้) – ทำได้เมื่อทุกชิ้นลงแผ่นเดียวได้")
        self.repack_btn.clicked.connect(self.repack)
        tools.addWidget(self.repack_btn)
        self.undo_btn = button("ย้อนกลับ", tooltip="ย้อนการแก้ล่าสุด (Ctrl+Z)")
        self.undo_btn.clicked.connect(self.undo_last)
        tools.addWidget(self.undo_btn)
        tools.addStretch(1)
        rl.addLayout(tools)
        self.view = _View(self)
        self.view.scene().selectionChanged.connect(self._selection)
        rl.addWidget(self.view, 1)
        keys = QLabel("ลาก = ย้าย · ลากพื้นว่างเป็นกรอบ = เลือกหลายชิ้น · R / Shift+R = หมุน 90° · [ ] = หมุน 5° "
                      "(Shift = 1°) · ลูกศร = ขยับ 1 มม. (Shift = 10 มม.) · Delete = เอาออก · Ctrl+Z = ย้อนกลับ · "
                      "ล้อเมาส์ = ซูม · ดับเบิลคลิกพื้นว่าง = ดูทั้งแผ่น")
        keys.setObjectName("Hint")
        keys.setWordWrap(True)
        rl.addWidget(keys)
        split.addWidget(right)
        split.setSizes([400, 900])
        lay.addWidget(split, 1)

        self.info = QLabel()
        self.info.setWordWrap(True)
        lay.addWidget(self.info)
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        self.ok = box.button(QDialogButtonBox.Ok)
        self.ok.setText("บันทึกการจัดวาง")
        self.ok.setProperty("kind", "primary")
        box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)
        QShortcut(QKeySequence.Undo, self, activated=self.undo_last)

        self._shown_flats: list = []
        self._ticked: set[str] = set()  # codes ticked to add - kept while the list is searched
        self._qty: dict[str, str] = {}  # pieces typed per code - kept the same way
        self._filling = False
        self._fill_flats()
        self._show_sheet(0)

    # ---- the sheet on screen ------------------------------------------------------------------------------------
    @property
    def sheet(self) -> nesting.SheetLayout:
        return self.layouts[self.current]

    def _show_sheet(self, index: int) -> None:
        self.current = max(0, index)
        self.pending.clear()
        self._draw(fit=True)

    def _draw(self, fit: bool = False) -> None:
        self.building = True
        scene = self.view.scene()
        selected = {it.index for it in self.items if it.isSelected()}
        scene.clear()
        self.items = []
        s, m = self.sheet, self.params.margin
        pen = QPen(QColor("#9FB3CC"))
        pen.setCosmetic(True)
        scene.addRect(0, -s.height, s.width, s.height, pen, QBrush(QColor("#16283E"))).setZValue(-2)
        edge = QPen(QColor("#5B7290"))
        edge.setCosmetic(True)
        edge.setStyle(Qt.DashLine)
        if s.width > 2 * m and s.height > 2 * m:
            scene.addRect(m, -s.height + m, s.width - 2 * m, s.height - 2 * m, edge).setZValue(-1)
        size = scene.addSimpleText(f"{s.width:g} x {s.height:g} มม. · ขอบ {m:g} · ระยะห่างชิ้น {self.params.gap:g} มม.")
        size.setBrush(QColor("#E6EDF6"))
        size.setScale(max(s.width, 300) / 900)
        size.setPos(0, 12)
        for i in range(len(s.placements)):
            item = _Piece(self, i)
            self._shape(item)
            scene.addItem(item)
            item.setSelected(i in selected)
            self.items.append(item)
        self.building = False
        self._check()
        if fit:
            self.view.fit()

    def _shape(self, item: _Piece) -> None:
        """The outline of the piece (holes cut out) in its own coordinates, placed at its corner."""
        pl = self.sheet.placements[item.index]
        part = self.parts[pl.part]
        path = QPainterPath()
        path.setFillRule(Qt.OddEvenFill)
        for loop in part.outline or [nesting._outer(part)]:
            pts = [nesting.place_point(pt, part, pl, 0, 0) for pt in loop]
            if len(pts) < 2:
                continue
            path.moveTo(pts[0][0] - pl.x, -(pts[0][1] - pl.y) + pl.h)
            for x, y in pts[1:]:
                path.lineTo(x - pl.x, -(y - pl.y) + pl.h)
            path.closeSubpath()
        item.setPath(path)
        item.setPos(pl.x, -pl.y - pl.h)
        item.label.setText((part.code or part.name)[:20])
        br = item.label.boundingRect()
        if br.width() > 0:
            scale = min(pl.w * 0.8 / br.width(), pl.h * 0.35 / max(br.height(), 1), 30 / max(br.height(), 1))
            item.label.setScale(max(scale, 0.01))
            item.label.setPos(pl.w / 2 - br.width() * scale / 2, pl.h / 2 - br.height() * scale / 2)

    def _paint(self, item: _Piece) -> None:
        pl = self.sheet.placements[item.index]
        problem = self.problems.get(item.index)
        color = PIECE if not self.parts[pl.part].key.startswith(laser.EXTRA_KEY) else EXTRA
        if problem:
            color = BAD if problem[0] in nesting.BLOCKING else CLOSE
        pen = QPen(color.lighter(130) if item.isSelected() else color)
        pen.setCosmetic(True)
        pen.setWidthF(3.0 if item.isSelected() else 1.6)
        item.setPen(pen)
        fill = QColor(color)
        fill.setAlpha(110 if item.isSelected() else 60)
        item.setBrush(QBrush(fill))
        item.setToolTip(f"{self.parts[pl.part].code} {self.parts[pl.part].name}".strip()
                        + f" · มุม {nesting.placement_angle(pl):g}° · X {pl.x:.1f} Y {pl.y:.1f} มม."
                        + (f"\n{problem[1]}" if problem else ""))

    def _check(self) -> None:
        self.problems = nesting.layout_problems(self.sheet, self.parts, self.params)
        for item in self.items:
            self._paint(item)
        bad = sum(1 for p in self.problems.values() if p[0] in nesting.BLOCKING)
        close = len(self.problems) - bad
        s = self.sheet
        area = sum(self.parts[pl.part].area for pl in s.placements)
        extra = sum(1 for pl in s.placements if self.parts[pl.part].key.startswith(laser.EXTRA_KEY))
        text = (f"{len(s.placements)} ชิ้นบนแผ่นนี้ (เพิ่มเอง {extra}) · ใช้เนื้อเหล็ก {area / (s.width * s.height):.0%}"
                if s.width and s.height else "")
        if self.pending:
            part = self.parts[self.pending[0]]
            text += (f" · <b>คลิกบนแผ่นเพื่อวาง {part.code or part.name}</b> (เหลือ {len(self.pending)} ชิ้น · "
                     "Esc = เลิกวาง)")
        if bad:
            text += f" · <span style='color:#D64545'><b>ตัดไม่ได้ {bad} ชิ้น</b> (แดง: เกินขอบ / ทับกัน) – ย้ายหรือเอาออกก่อนบันทึก</span>"
        if close:
            text += f" · <span style='color:#B4610F'>ชิดกัน / ชิดขอบเกินระยะ {close} ชิ้น (เหลือง – บันทึกได้)</span>"
        self.info.setText(text)
        self.ok.setEnabled(not any(p[0] in nesting.BLOCKING for lay in self.layouts
                                   for p in nesting.layout_problems(lay, self.parts, self.params).values()))
        self.view.viewport().setCursor(Qt.CrossCursor if self.pending else Qt.ArrowCursor)

    def _selection(self) -> None:
        if self.building:
            return
        chosen = self.selected()
        for item in self.items:
            self._paint(item)
        if len(chosen) == 1:
            self.angle.blockSignals(True)
            self.angle.setValue(nesting.placement_angle(self.sheet.placements[chosen[0]]))
            self.angle.blockSignals(False)

    def selected(self) -> list[int]:
        return [it.index for it in self.items if it.isSelected()]

    # ---- editing ------------------------------------------------------------------------------------------------
    def remember(self) -> None:
        self.undo.append((self.current, copy.deepcopy(self.sheet.placements), len(self.parts)))
        del self.undo[:-50]

    def undo_last(self) -> None:
        if not self.undo:
            return
        index, placements, _n = self.undo.pop()
        self.layouts[index].placements = placements
        if index != self.current:
            self.sheet_box.setCurrentIndex(index)
        self._draw()

    def moved(self) -> None:
        for pl in self.sheet.placements:  # tenths of a millimetre are enough for the laser
            pl.x, pl.y = round(pl.x, 1), round(pl.y, 1)
        if self.undo and self.undo[-1][0] == self.current and self.undo[-1][1] == self.sheet.placements:
            self.undo.pop()  # a click that only selected: nothing to undo
        self._draw()

    def stop_placing(self) -> None:
        self.pending.clear()
        self._check()

    def rotate_by(self, degrees: float) -> None:
        chosen = self.selected()
        if not chosen:
            return
        self.remember()
        for i in chosen:
            pl = self.sheet.placements[i]
            nesting.turn(pl, self.parts[pl.part], nesting.placement_angle(pl) + degrees)
        self._draw()

    def _angle_typed(self) -> None:
        chosen = self.selected()
        if not chosen:
            return
        self.remember()
        for i in chosen:
            pl = self.sheet.placements[i]
            nesting.turn(pl, self.parts[pl.part], self.angle.value())
        self._draw()

    def nudge(self, dx: float, dy: float) -> None:
        chosen = self.selected()
        if not chosen:
            return
        self.remember()
        for i in chosen:
            pl = self.sheet.placements[i]
            pl.x, pl.y = round(pl.x + dx, 1), round(pl.y + dy, 1)
        self._draw()

    def repack(self) -> None:
        """Every piece of this sheet nested again automatically (as the plan does) - when they all fit on it."""
        s = self.sheet
        counts: dict[int, int] = {}
        for pl in s.placements:
            counts[pl.part] = counts.get(pl.part, 0) + 1
        if not counts:
            return
        order = list(counts)
        subset = [replace(self.parts[i], qty=counts[i]) for i in order]
        sheets, too_big = nesting.pack(subset, s.width, s.height, self.params)
        if too_big or len(sheets) > 1:
            self.info.setText("วางใหม่อัตโนมัติไม่ได้: ชิ้นทั้งหมดลงแผ่นนี้แผ่นเดียวไม่พอ (จัดเองต่อ หรือเอาบางชิ้นออกก่อน)")
            return
        self.remember()
        s.placements = [replace(pl, part=order[pl.part]) for pl in (sheets[0].placements if sheets else [])]
        self._draw()

    def remove_selected(self) -> None:
        chosen = set(self.selected())
        if not chosen:
            return
        self.remember()
        self.sheet.placements = [pl for i, pl in enumerate(self.sheet.placements) if i not in chosen]
        self._draw()

    def key(self, event) -> bool:
        """Keys on the sheet; False = not handled here."""
        k, shift = event.key(), bool(event.modifiers() & Qt.ShiftModifier)
        step = 10.0 if shift else 1.0
        if k in (Qt.Key_Delete, Qt.Key_Backspace):
            self.remove_selected()
        elif k == Qt.Key_R:
            self.rotate_by(-90 if shift else 90)
        elif k == Qt.Key_BracketLeft:
            self.rotate_by(-1 if shift else -5)
        elif k == Qt.Key_BracketRight:
            self.rotate_by(1 if shift else 5)
        elif k == Qt.Key_Left:
            self.nudge(-step, 0)
        elif k == Qt.Key_Right:
            self.nudge(step, 0)
        elif k == Qt.Key_Up:
            self.nudge(0, step)
        elif k == Qt.Key_Down:
            self.nudge(0, -step)
        elif k == Qt.Key_Escape and self.pending:
            self.stop_placing()
        else:
            return False
        return True

    def keyPressEvent(self, event):  # noqa: N802 - Esc while placing stops placing, it does not close the window
        if event.key() == Qt.Key_Escape and self.pending:
            self.stop_placing()
            return
        super().keyPressEvent(event)

    # ---- adding pieces ------------------------------------------------------------------------------------------
    def _fill_flats(self, *_args) -> None:
        text = self.search.text().strip().lower()
        self._shown_flats = [f for f in self.flats if not text or text in f"{f.code} {f.name}".lower()]
        self._filling = True
        self.flat_table.setRowCount(len(self._shown_flats))
        for r, f in enumerate(self._shown_flats):
            tick = QTableWidgetItem()
            tick.setFlags(Qt.ItemIsUserCheckable | Qt.ItemIsEnabled)
            tick.setCheckState(Qt.Checked if f.code in self._ticked else Qt.Unchecked)
            self.flat_table.setItem(r, 0, tick)
            for c, value in ((1, f.code), (3, "{:.0f} x {:.0f}".format(*f.size)), (4, f.name)):
                cell = QTableWidgetItem(value)
                cell.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
                self.flat_table.setItem(r, c, cell)
            qty = QTableWidgetItem(self._qty.get(f.code, "1"))
            qty.setToolTip("จำนวนต่อแผ่น (ดับเบิลคลิกเพื่อแก้) · วางอัตโนมัติ: 0 = เต็มที่ว่าง")
            self.flat_table.setItem(r, 2, qty)
        self._filling = False
        self.add_btn.setEnabled(bool(self._shown_flats))
        self._update_check_all()

    # select / check all: every piece shown in the list (the search) is ticked, or none
    def _rows_ticked(self) -> list[int]:
        return [r for r in range(self.flat_table.rowCount()) if self.flat_table.item(r, 0).checkState() == Qt.Checked]

    def tick_all(self, on: bool) -> None:
        self._filling = True
        for r, f in enumerate(self._shown_flats):
            self.flat_table.item(r, 0).setCheckState(Qt.Checked if on else Qt.Unchecked)
            (self._ticked.add if on else self._ticked.discard)(f.code)
        self._filling = False
        self._update_check_all()

    def _check_all_clicked(self, *_args) -> None:
        rows = self.flat_table.rowCount()
        self.tick_all(not (rows and len(self._rows_ticked()) == rows))

    def _header_clicked(self, section: int) -> None:
        if section == 0:
            self._check_all_clicked()

    def _flat_edited(self, item: QTableWidgetItem) -> None:
        """A row ticked or unticked: with several rows selected, all of them follow it."""
        if self._filling or item.row() >= len(self._shown_flats):
            return
        if item.column() == 2:
            self._qty[self._shown_flats[item.row()].code] = item.text()
            return
        if item.column() != 0:
            return
        on = item.checkState() == Qt.Checked
        rows = {i.row() for i in self.flat_table.selectedIndexes()}
        rows = rows if item.row() in rows and len(rows) > 1 else {item.row()}
        self._filling = True
        for r in rows:
            self.flat_table.item(r, 0).setCheckState(Qt.Checked if on else Qt.Unchecked)
            (self._ticked.add if on else self._ticked.discard)(self._shown_flats[r].code)
        self._filling = False
        self._update_check_all()

    def _update_check_all(self) -> None:
        rows, ticked = self.flat_table.rowCount(), len(self._rows_ticked())
        self.check_all.setCheckState(Qt.Checked if rows and ticked == rows else
                                     Qt.PartiallyChecked if ticked else Qt.Unchecked)
        self.check_all.setEnabled(bool(rows))
        hidden = len(self._ticked) - ticked
        self.tick_count.setText(f"ติ๊ก {ticked} จาก {rows} ชิ้น" + (f" (+{hidden} ที่ซ่อนโดยคำค้น)" if hidden > 0 else ""))

    def checked(self) -> list[tuple[object, int]]:
        """(flat pattern, pieces) ticked to add - also the ones a search hides now (the selected rows when none
        is ticked)."""
        picks = [f for f in self.flats if f.code in self._ticked]
        if not picks:
            picks = [self._shown_flats[r] for r in sorted({i.row() for i in self.flat_table.selectedIndexes()})
                     if r < len(self._shown_flats)]
        out = []
        for f in picks:
            try:
                n = int(float(self._qty.get(f.code, "1") or 0))
            except ValueError:
                n = 1
            out.append((f, max(0, n)))
        return out

    def part_index(self, flat) -> int:
        """The flat pattern as a part of this layout (added once, then used for every piece of it)."""
        part = laser.extra_part(flat, self.align)
        found = next((i for i, p in enumerate(self.parts) if p.key == part.key), None)
        if found is None:
            self.parts.append(replace(part, qty=0))
            found = len(self.parts) - 1
        return found

    def add_checked(self) -> None:
        picks = self.checked()
        if not picks:
            self.info.setText("ติ๊กชิ้นส่วนที่จะเพิ่มก่อน (หรือเลือกแถว)")
            return
        if self.manual.isChecked():
            self.pending = [self.part_index(f) for f, n in picks for _ in range(max(1, n))]
            self.view.setFocus()
            self._check()
            return
        self.remember()
        placed = []
        for flat, n in picks:
            i = self.part_index(flat)
            got = nesting.fill_sheet(self.sheet, i, self.parts[i], n, self.params)
            placed.append(f"{flat.code} {got}")
        self._draw()
        self.info.setText(self.info.text() + " · วางอัตโนมัติ: " + ", ".join(placed))

    def drop_at(self, x: float, y: float) -> None:
        """Put the next piece waiting to be placed by hand down with its middle at (x, y)."""
        if not self.pending:
            return
        self.remember()
        i = self.pending.pop(0)
        nesting.place_piece(self.sheet, i, self.parts[i], round(x, 1), round(y, 1), self.angle.value())
        self._draw()

    # ---- the result -------------------------------------------------------------------------------------------
    def edited(self) -> tuple[list[nesting.SheetLayout], list[nesting.NestPart]]:
        """The sheets as laid out here (same order as given) and the parts they use (new ones at the end)."""
        return self.layouts, self.parts
