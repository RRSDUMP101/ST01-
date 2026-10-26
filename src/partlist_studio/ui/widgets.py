"""Reusable widgets: page header, cards, KPI tiles, drawing preview, background worker."""

from __future__ import annotations

import traceback

from PySide6.QtCore import QObject, QPointF, QRectF, QRunnable, Qt, QThreadPool, Signal
from PySide6.QtGui import QBrush, QColor, QIntValidator, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QFrame, QGraphicsScene, QGraphicsView, QHBoxLayout,
                               QHeaderView, QLabel, QLineEdit, QPushButton, QStyle, QStyledItemDelegate, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from . import theme


def button(text: str, kind: str = "", tooltip: str = "") -> QPushButton:
    btn = QPushButton(text)
    if kind:
        btn.setProperty("kind", kind)
    if tooltip:
        btn.setToolTip(tooltip)
    btn.setCursor(Qt.PointingHandCursor)
    return btn


def table(headers: list[str], widths: list[int] | None = None, editable: bool = False) -> QTableWidget:
    t = QTableWidget(0, len(headers))
    t.setHorizontalHeaderLabels(headers)
    t.setAlternatingRowColors(True)
    t.setSelectionBehavior(QAbstractItemView.SelectRows)
    if not editable:
        t.setEditTriggers(QAbstractItemView.NoEditTriggers)
    t.verticalHeader().setVisible(False)
    t.verticalHeader().setDefaultSectionSize(28)
    t.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
    t.horizontalHeader().setStretchLastSection(True)
    for i, w in enumerate(widths or []):
        t.setColumnWidth(i, w)
    return t


def fill(t: QTableWidget, rows: list[list], status_col: int | None = None, data: list | None = None) -> None:
    """Rows of values; the status column is coloured; `data` is kept on column 0 (Qt.UserRole)."""
    t.blockSignals(True)
    t.setRowCount(len(rows))
    for r, values in enumerate(rows):
        for c, v in enumerate(values):
            text = "" if v is None else (f"{v:,.3f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v))
            item = QTableWidgetItem(text)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            if c == status_col and text:
                item.setForeground(QBrush(theme.status_color(text)))
                f = item.font()
                f.setBold(True)
                item.setFont(f)
            if c == 0 and data is not None:
                item.setData(Qt.UserRole, data[r])
            t.setItem(r, c, item)
    t.blockSignals(False)


def selected_rows(t: QTableWidget) -> list[int]:
    return sorted({i.row() for i in t.selectedIndexes()})


class Stepper(QWidget):
    """A whole number with − and + buttons beside it: [ − ] [ 3 ] คัน [ + ]. Type the number or step it.
    (A styled QSpinBox without its arrow buttons draws no text at all - a Qt quirk - so this is used instead.)"""

    valueChanged = Signal(int)

    def __init__(self, minimum: int = 1, maximum: int = 9999, suffix: str = "", parent=None):
        super().__init__(parent)
        self._min, self._max, self._value = minimum, maximum, minimum
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)
        self.minus = QPushButton("−")
        self.plus = QPushButton("+")
        for b, tip in ((self.minus, "ลด 1"), (self.plus, "เพิ่ม 1")):
            b.setFixedWidth(40)
            b.setToolTip(tip)
            b.setAutoRepeat(True)  # hold to keep stepping
            b.setObjectName("Stepper")
        self.edit = QLineEdit(str(minimum))
        self.edit.setValidator(QIntValidator(minimum, maximum, self))
        self.edit.setAlignment(Qt.AlignCenter)
        self.edit.setMinimumWidth(70)
        self.edit.setMaximumWidth(110)
        lay.addWidget(self.minus)
        lay.addWidget(self.edit)
        self.unit = QLabel(suffix.strip())
        lay.addWidget(self.unit)
        lay.addWidget(self.plus)
        lay.addStretch(1)
        self.minus.clicked.connect(lambda: self.setValue(self._value - 1, emit=True))
        self.plus.clicked.connect(lambda: self.setValue(self._value + 1, emit=True))
        self.edit.textEdited.connect(self._typed)
        self.edit.editingFinished.connect(lambda: self.edit.setText(str(self._value)))
        self._sync()

    def value(self) -> int:
        return self._value

    def setRange(self, minimum: int, maximum: int) -> None:  # noqa: N802 - like QSpinBox
        self._min, self._max = minimum, maximum
        self.edit.setValidator(QIntValidator(minimum, maximum, self))
        self.setValue(self._value)

    def setValue(self, value: int, emit: bool = True) -> None:  # noqa: N802 - like QSpinBox
        value = max(self._min, min(self._max, int(value)))
        changed = value != self._value
        self._value = value
        self._sync()
        if changed and emit and not self.signalsBlocked():
            self.valueChanged.emit(value)

    def setToolTip(self, text: str) -> None:  # noqa: N802
        super().setToolTip(text)
        self.edit.setToolTip(text)

    def _typed(self, text: str) -> None:
        if text.strip().isdigit():
            self.setValue(int(text), emit=True)

    def _sync(self) -> None:
        text = self.edit.text().strip()
        typing = self.edit.hasFocus() and text.isdigit() and int(text) == self._value  # leave what is being typed
        if not typing and text != str(self._value):
            self.edit.setText(str(self._value))
        self.minus.setEnabled(self._value > self._min)
        self.plus.setEnabled(self._value < self._max)


class BarDelegate(QStyledItemDelegate):
    """A table cell drawn as a progress bar: the value 0..1 is in BarDelegate.ROLE (green when complete)."""

    ROLE = Qt.UserRole + 7

    def paint(self, painter, option, index):  # Qt API
        value = index.data(self.ROLE)
        if value is None:
            super().paint(painter, option, index)
            return
        value = max(0.0, min(1.0, float(value)))
        painter.save()
        if option.state & QStyle.State_Selected:
            painter.fillRect(option.rect, option.palette.highlight())
        painter.setRenderHint(QPainter.Antialiasing, True)
        bar = QRectF(option.rect.adjusted(6, 6, -6, -6))
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor("#E6EAF0"))
        painter.drawRoundedRect(bar, 4, 4)
        if value > 0:
            done = QRectF(bar)
            done.setWidth(max(8.0, bar.width() * value))
            painter.setBrush(QColor("#2E9D5B" if value >= 1 else "#E08A1E"))
            painter.drawRoundedRect(done, 4, 4)
        painter.setPen(QColor("#FFFFFF" if value >= 0.55 else "#1B2430"))
        painter.drawText(bar, Qt.AlignCenter, f"{value:.0%}")
        painter.restore()


class StepBar(QFrame):
    """The work path on top of every work page: 1 แบบ 2D › 2 Part List › … with what waits in each step,
    the page you are on, and ONE button for the next thing to do."""

    def __init__(self, navigate, on_next, parent=None):
        super().__init__(parent)
        self.setObjectName("StepBar")
        self._navigate = navigate
        lay = QHBoxLayout(self)
        lay.setContentsMargins(20, 8, 20, 8)
        lay.setSpacing(4)
        self.buttons: dict[str, QPushButton] = {}
        self._row = lay
        self.next_label = QLabel("ขั้นต่อไป")
        self.next_label.setObjectName("Hint")
        self.next_btn = button("", "accent")
        self.next_btn.clicked.connect(on_next)

    def set_steps(self, steps, current: str, next_text: str) -> None:
        if not self.buttons:
            for i, st in enumerate(steps):
                if i:
                    arrow = QLabel("›")
                    arrow.setObjectName("StepArrow")
                    self._row.addWidget(arrow)
                b = QPushButton()
                b.setObjectName("Step")
                b.setCursor(Qt.PointingHandCursor)
                b.clicked.connect(lambda _=False, k=st.key: self._navigate(k))
                self.buttons[st.key] = b
                self._row.addWidget(b)
            self._row.addStretch(1)
            self._row.addWidget(self.next_label)
            self._row.addWidget(self.next_btn)
        for st in steps:
            b = self.buttons[st.key]
            b.setText(f"{st.num}  {st.title}\n{st.metric}")
            b.setToolTip(f"ขั้น {st.num}: {st.title} – {st.metric}")
            state = "current" if st.key == current else ("wait" if st.waiting else "")
            if b.property("step") != state:
                b.setProperty("step", state)
                b.style().unpolish(b)
                b.style().polish(b)
        self.next_btn.setText(next_text + "  ›")


class PageHeader(QWidget):
    def __init__(self, title: str, subtitle: str = "", parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 6)
        text = QVBoxLayout()
        t = QLabel(title)
        t.setObjectName("PageTitle")
        text.addWidget(t)
        if subtitle:
            s = QLabel(subtitle)
            s.setObjectName("PageSub")
            s.setWordWrap(True)
            text.addWidget(s)
        lay.addLayout(text, 1)
        self.actions = QHBoxLayout()
        self.actions.setSpacing(8)
        lay.addLayout(self.actions)

    def add_action(self, widget: QWidget) -> QWidget:
        self.actions.addWidget(widget)
        return widget


class Card(QFrame):
    def __init__(self, title: str = "", parent=None):
        super().__init__(parent)
        self.setObjectName("Card")
        self.body = QVBoxLayout(self)
        self.body.setContentsMargins(16, 14, 16, 14)
        self.body.setSpacing(8)
        if title:
            label = QLabel(title)
            label.setObjectName("CardTitle")
            self.body.addWidget(label)


class KpiCard(Card):
    def __init__(self, label: str, value: str = "-", accent: str = theme.NAVY, parent=None):
        super().__init__(parent=parent)
        self.setMinimumWidth(150)
        bar = QFrame()
        bar.setFixedHeight(3)
        bar.setStyleSheet(f"background:{accent}; border-radius:1px;")
        self.body.addWidget(bar)
        self.value = QLabel(value)
        self.value.setObjectName("KpiValue")
        caption = QLabel(label)
        caption.setObjectName("KpiLabel")
        self.body.addWidget(self.value)
        self.body.addWidget(caption)

    def set_value(self, text: str) -> None:
        self.value.setText(text)


class StatusChip(QLabel):
    def __init__(self, status: str, count: int = 0, parent=None):
        super().__init__(parent)
        self.status = status
        self.setObjectName("StatusChip")
        self.setStyleSheet(f"QLabel#StatusChip {{ background: {theme.status_color(status).name()}; }}")
        self.set_count(count)

    def set_count(self, count: int) -> None:
        self.setText(f"{self.status}  {count}")


class StatusChipRow(QHBoxLayout):
    """A fixed row of chips; chips with a zero count can be hidden."""

    def __init__(self, statuses: list[str], hide_zero: bool = False):
        super().__init__()
        self.setSpacing(6)
        self.hide_zero = hide_zero
        self.chips = {s: StatusChip(s) for s in statuses}
        for chip in self.chips.values():
            self.addWidget(chip)
        self.addStretch(1)

    def set_counts(self, counts: dict[str, int]) -> None:
        for status, chip in self.chips.items():
            n = counts.get(status, 0)
            chip.set_count(n)
            chip.setVisible(bool(n) or not self.hide_zero)


# --------------------------------------------------------------------------
REMOVED_STYLE = {"bend": ("#2ECC71", Qt.DashLine), "stray": ("#FF8A80", Qt.DashLine),
                 "glyph": ("#FF8A80", Qt.DotLine), "overshoot": ("#FF8A80", Qt.SolidLine),
                 "open": ("#FF4D4F", Qt.SolidLine), "open_in_part": ("#FF4D4F", Qt.SolidLine)}


class DrawingPreview(QGraphicsView):
    """Read-only 2D viewer for the geometry extracted from a DWG/DXF (wheel = zoom, drag = pan)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setScene(QGraphicsScene(self))
        self.setRenderHint(QPainter.Antialiasing)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setBackgroundBrush(QColor("#0F1B2B"))
        self.setMinimumHeight(260)
        self.setStyleSheet("border-radius: 8px; border: 1px solid #22344C;")
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._auto_fit = True
        self._focus_item = None
        self._mark_size = 5.0

    def show_drawing(self, data, selected_profiles: set[int] | None = None,
                     sides: dict[int, str] | None = None) -> None:
        """sides: profile index -> L / R, written over the piece (ซ้าย L / ขวา R)."""
        scene = self.scene()
        scene.clear()
        self._focus_item = None
        self._auto_fit = True
        if data is None:
            return
        pen = QPen(QColor("#9FB3CC"))
        pen.setCosmetic(True)
        pen.setWidthF(1.0)
        path = QPainterPath()
        for pts in data.preview:
            path.moveTo(pts[0][0], -pts[0][1])
            for x, y in pts[1:]:
                path.lineTo(x, -y)
        scene.addPath(path, pen)
        cut_pen = QPen(QColor(theme.ACCENT))
        cut_pen.setCosmetic(True)
        cut_pen.setWidthF(2.0)
        hole_pen = QPen(QColor("#4FC3F7"))
        hole_pen.setCosmetic(True)
        hole_pen.setWidthF(1.5)
        selected = selected_profiles if selected_profiles is not None else {
            i for i, p in enumerate(data.profiles) if p.is_outer}
        for i, prof in enumerate(data.profiles):
            if prof.is_container or getattr(prof, "is_glyph", False):
                continue
            is_outer = prof.parent is None
            if is_outer and i not in selected:
                continue
            if not is_outer and prof.parent not in selected:
                continue
            poly = QPolygonF([QPointF(x, -y) for x, y in prof.points])
            brush = QBrush(QColor(242, 140, 40, 45)) if is_outer else QBrush(Qt.NoBrush)
            scene.addPolygon(poly, cut_pen if is_outer else hole_pen, brush)
        # what the check before cutting took out: bend lines (green dashes), loose lines and letters (red dashes),
        # lines that do not close (red)
        for kind, pts in getattr(data, "removed", None) or []:
            if len(pts) < 2:
                continue
            color, style = REMOVED_STYLE.get(kind, ("#FF8A80", Qt.DashLine))
            pen = QPen(QColor(color))
            pen.setCosmetic(True)
            pen.setWidthF(1.6)
            pen.setStyle(style)
            line = QPainterPath()
            line.moveTo(pts[0][0], -pts[0][1])
            for x, y in pts[1:]:
                line.lineTo(x, -y)
            scene.addPath(line, pen)
        rect = scene.itemsBoundingRect()
        size = max(rect.width(), rect.height()) * 0.006 or 5
        self._mark_size = size
        # cut lines that do not close into a loop: a laser cannot cut them as a part - mark where they start
        marks = getattr(data, "open_examples", None) or []
        if marks:
            mark_pen = QPen(QColor("#FF4D4F"))
            mark_pen.setCosmetic(True)
            mark_pen.setWidthF(2.0)
            for x, y in marks:
                scene.addEllipse(x - size, -y - size, 2 * size, 2 * size, mark_pen)
        fixed_pen = QPen(QColor("#2ECC71"))  # joined gaps, overshoots cut off
        fixed_pen.setCosmetic(True)
        fixed_pen.setWidthF(2.0)
        for f in getattr(data, "fixes", None) or []:
            if f.kind in ("gap", "overshoot", "duplicate", "dup_loop"):
                scene.addEllipse(f.x - size, -f.y - size, 2 * size, 2 * size, fixed_pen)
        side_color = QColor("#FFD54F")
        for i, side in (sides or {}).items():
            if i >= len(data.profiles) or side not in ("L", "R"):
                continue
            x0, y0, x1, y1 = data.profiles[i].bbox
            t = scene.addSimpleText(("ซ้าย L", "ขวา R")[side == "R"])
            t.setBrush(side_color)
            br = t.boundingRect()
            if br.height() > 0:
                s = max(min(y1 - y0, x1 - x0) * 0.3, size * 2.5) / br.height()
                t.setScale(s)
                t.setPos((x0 + x1) / 2 - br.width() * s / 2, -y1 - br.height() * s * 1.1)
        text_color = QColor("#E6EDF6")
        for item in data.texts[:600]:
            t = scene.addSimpleText(item.text)
            t.setBrush(text_color)
            br = t.boundingRect()
            if br.height() > 0:
                s = item.height / br.height() * 1.35
                t.setScale(s)
                t.setPos(item.x - br.width() * s / 2, -item.y - br.height() * s / 2)
        self.fit()

    def focus(self, x: float, y: float) -> None:
        """Zoom to one place of the drawing (a fix of the check before cutting) and ring it."""
        scene = self.scene()
        if self._focus_item is not None and self._focus_item.scene() is scene:
            scene.removeItem(self._focus_item)
        rect = scene.itemsBoundingRect()
        r = max(max(rect.width(), rect.height()) * 0.06, 20.0)
        size = self._mark_size * 2.5
        pen = QPen(QColor("#FFD54F"))
        pen.setCosmetic(True)
        pen.setWidthF(2.5)
        self._focus_item = scene.addEllipse(x - size, -y - size, 2 * size, 2 * size, pen)
        self._auto_fit = False
        self.fitInView(QRectF(x - r, -y - r, 2 * r, 2 * r), Qt.KeepAspectRatio)

    def mouseDoubleClickEvent(self, event):  # noqa: N802 - double click = fit whole drawing
        self._auto_fit = True
        self.fit()

    def fit(self) -> None:
        rect = self.scene().itemsBoundingRect()
        if not rect.isNull():
            margin = max(rect.width(), rect.height()) * 0.03
            self.fitInView(rect.adjusted(-margin, -margin, margin, margin), Qt.KeepAspectRatio)

    def wheelEvent(self, event):  # noqa: N802 - Qt API
        factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
        self._auto_fit = False
        self.scale(factor, factor)

    def resizeEvent(self, event):  # noqa: N802
        super().resizeEvent(event)
        if self._auto_fit and self.scene().items():
            self.fit()

    def drawForeground(self, painter, rect: QRectF):  # noqa: N802
        if not self.scene().items():
            painter.save()
            painter.resetTransform()
            painter.setPen(QColor("#6F87A5"))
            painter.drawText(self.viewport().rect(), Qt.AlignCenter, "เลือกไฟล์แบบ 2D (DWG/DXF) เพื่อแสดงตัวอย่าง")
            painter.restore()


# --------------------------------------------------------------------------
class _Signals(QObject):
    done = Signal(object)
    failed = Signal(str)


class Worker(QRunnable):
    """Run a slow call (DWG conversion, Google API) off the UI thread."""

    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self.setAutoDelete(False)  # kept alive in _ACTIVE until its signal has been handled
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.signals = _Signals()

    def run(self):
        try:
            result = self.fn(*self.args, **self.kwargs)
        except Exception as exc:  # noqa: BLE001 - reported in the UI
            traceback.print_exc()
            self.signals.failed.emit(str(exc))
        else:
            self.signals.done.emit(result)


_ACTIVE: set[Worker] = set()


def run_async(fn, on_done, on_error, *args, **kwargs) -> None:
    worker = Worker(fn, *args, **kwargs)
    _ACTIVE.add(worker)
    QApplication.setOverrideCursor(Qt.BusyCursor)

    def finish(callback, value):
        QApplication.restoreOverrideCursor()
        _ACTIVE.discard(worker)
        callback(value)

    worker.signals.done.connect(lambda r: finish(on_done, r))
    worker.signals.failed.connect(lambda e: finish(on_error, e))
    QThreadPool.globalInstance().start(worker)
