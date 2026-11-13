"""Reusable widgets: page header, cards, KPI tiles, drawing preview, background worker."""

from __future__ import annotations

import gc
import threading
import traceback

from PySide6.QtCore import QEvent, QObject, QPoint, QPointF, QRect, QRectF, QRunnable, QSize, Qt, QThreadPool, Signal
from PySide6.QtGui import QBrush, QColor, QGuiApplication, QIntValidator, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import (QAbstractButton, QAbstractItemView, QApplication, QBoxLayout, QDialog,
                               QDialogButtonBox, QFrame, QGraphicsScene, QGraphicsView, QHBoxLayout, QHeaderView, QLabel,
                               QLayout, QLineEdit, QProgressBar, QPushButton, QScrollArea, QStyle, QStyledItemDelegate,
                               QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget)

from . import theme


def button(text: str, kind: str = "", tooltip: str = "") -> QPushButton:
    btn = QPushButton(text)
    if kind:
        btn.setProperty("kind", kind)
    if tooltip:
        btn.setToolTip(tooltip)
    btn.setCursor(Qt.PointingHandCursor)
    return btn


def fit_to_screen(widget: QWidget, width: int, height: int) -> None:
    """Resize a window to width x height, smaller when the screen is (a 1366 x 768 laptop leaves ~728 px under the
    taskbar): the buttons at the bottom of a dialog stay on the screen."""
    screen = None
    parent = widget.parentWidget()
    if parent is not None and parent.window() is not None:
        screen = parent.window().screen()
    screen = screen or QGuiApplication.primaryScreen()
    if screen is not None and QGuiApplication.platformName() not in ("offscreen", "minimal"):
        avail = screen.availableGeometry()
        width = min(width, int(avail.width() * 0.96))
        height = min(height, int(avail.height() * 0.94))
    widget.resize(width, height)


# ---- every dialog fits the screen ---------------------------------------------------------------------------------
# A dialog whose content wants more than the screen (a laptop at 125-150 %: about 1280 x 680 left) had its bottom
# buttons off the screen - เริ่มคีย์เข้า Express could not be pressed. When a dialog is shown and wants more than the
# screen gives, its content goes in a scroll area and its last row of buttons stays under it, always on the screen.
FIT_SCREEN: QSize | None = None  # the space to fit in (the tests set it; None = the screen of the dialog)


def _available(widget: QWidget) -> QSize | None:
    if FIT_SCREEN is not None:
        return FIT_SCREEN
    if QGuiApplication.platformName() in ("offscreen", "minimal"):
        return None
    screen = widget.screen() or QGuiApplication.primaryScreen()
    return screen.availableGeometry().size() if screen is not None else None


def _is_button_row(item) -> bool:
    w = item.widget() if item is not None else None
    if w is not None:
        return isinstance(w, QDialogButtonBox)
    lay = item.layout() if item is not None else None
    if lay is None:
        return False
    widgets = [lay.itemAt(i).widget() for i in range(lay.count()) if lay.itemAt(i).widget() is not None]
    return bool(widgets) and any(isinstance(x, QAbstractButton) for x in widgets) \
        and all(isinstance(x, (QAbstractButton, QLabel, QDialogButtonBox, QProgressBar)) for x in widgets)


def scroll_dialog(dlg: QWidget) -> bool:
    """Put the content of a dialog (its box layout but the last row of buttons) in a scroll area. True when done."""
    lay = dlg.layout()
    if not isinstance(lay, QBoxLayout) or lay.count() < 2 or dlg.property("_scrolled"):
        return False
    keep = 1 if _is_button_row(lay.itemAt(lay.count() - 1)) else 0
    body = QWidget()
    body.setObjectName("DialogBody")
    inner = QVBoxLayout(body)
    inner.setContentsMargins(0, 0, 0, 0)
    inner.setSpacing(lay.spacing() if lay.spacing() >= 0 else 6)
    for _ in range(lay.count() - keep):
        stretch = lay.stretch(0)
        item = lay.takeAt(0)
        if item.widget() is not None:
            inner.addWidget(item.widget(), stretch)
        elif item.layout() is not None:
            sub = item.layout()
            sub.setParent(None)
            inner.addLayout(sub, stretch)
        else:
            inner.addItem(item)
    scroll = QScrollArea()
    scroll.setObjectName("DialogScroll")
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QFrame.NoFrame)
    scroll.setWidget(body)
    lay.insertWidget(0, scroll, 1)
    dlg.setProperty("_scrolled", True)
    return True


def fit_dialog(dlg: QWidget) -> None:
    """Fit a dialog being shown to the screen: scroll its content when it wants more, keep it on the screen."""
    avail = _available(dlg)
    if avail is None:
        return
    max_w, max_h = int(avail.width() * 0.96), int(avail.height() * 0.92)
    need = dlg.minimumSizeHint()
    if (need.height() > max_h or need.width() > max_w) and scroll_dialog(dlg):
        dlg.setMinimumSize(min(dlg.minimumWidth(), max_w), min(dlg.minimumHeight(), max_h))
    if dlg.width() > max_w or dlg.height() > max_h:
        dlg.resize(min(dlg.width(), max_w), min(dlg.height(), max_h))
    if FIT_SCREEN is None:
        screen = dlg.screen() or QGuiApplication.primaryScreen()
        if screen is not None:
            g = screen.availableGeometry()
            x = min(max(dlg.x(), g.left()), g.right() - dlg.width())
            y = min(max(dlg.y(), g.top()), g.bottom() - dlg.height())
            if (x, y) != (dlg.x(), dlg.y()):
                dlg.move(x, y)


_QDIALOG_SHOW = QDialog.showEvent


def _dialog_show(self, event) -> None:  # every dialog of this program (Python classes) passes here
    _QDIALOG_SHOW(self, event)
    try:
        fit_dialog(self)
    except RuntimeError:  # deleted while being shown
        pass


QDialog.showEvent = _dialog_show


def scroll_body(page: QWidget) -> QVBoxLayout:
    """Put the page in a scroll area (cards taller than a small screen scroll instead of being squeezed) and return
    the layout of its body."""
    outer = QVBoxLayout(page)
    outer.setContentsMargins(0, 0, 0, 0)
    scroll = QScrollArea()
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.NoFrame)
    body = QWidget()
    body.setObjectName("Content")
    scroll.setWidget(body)
    outer.addWidget(scroll)
    page.scroll_area = scroll
    lay = QVBoxLayout(body)
    lay.setContentsMargins(28, 24, 28, 16)
    return lay


class FlowLayout(QLayout):
    """Widgets in a row that wraps onto the next line when the window is narrow (one line on a wide screen,
    two on a 1366 px laptop) - nothing is cut off or squeezed."""

    def __init__(self, parent=None, h_spacing: int = 14, v_spacing: int = 6):
        super().__init__(parent)
        self._items = []
        self._h, self._v = h_spacing, v_spacing
        self.setContentsMargins(0, 0, 0, 0)

    def addItem(self, item):  # noqa: N802 - Qt API
        self._items.append(item)

    def count(self):
        return len(self._items)

    def itemAt(self, index):  # noqa: N802
        return self._items[index] if 0 <= index < len(self._items) else None

    def takeAt(self, index):  # noqa: N802
        return self._items.pop(index) if 0 <= index < len(self._items) else None

    def expandingDirections(self):  # noqa: N802
        return Qt.Orientation(0)

    def hasHeightForWidth(self):  # noqa: N802
        return True

    def heightForWidth(self, width):  # noqa: N802
        return self._place(QRect(0, 0, width, 0), apply=False)

    def setGeometry(self, rect):  # noqa: N802
        super().setGeometry(rect)
        self._place(rect, apply=True)

    def sizeHint(self):  # noqa: N802
        return self.minimumSize()

    def minimumSize(self):  # noqa: N802
        size = QSize()
        for item in self._items:
            if not item.isEmpty():
                size = size.expandedTo(item.minimumSize())
        m = self.contentsMargins()
        return size + QSize(m.left() + m.right(), m.top() + m.bottom())

    def _place(self, rect: QRect, apply: bool) -> int:
        m = self.contentsMargins()
        area = rect.adjusted(m.left(), m.top(), -m.right(), -m.bottom())
        lines: list[list] = [[]]
        x = area.x()
        for item in self._items:
            if item.isEmpty():  # a hidden widget
                continue
            w = item.sizeHint().width()
            if lines[-1] and x + w > area.right() + 1:
                lines.append([])
                x = area.x()
            lines[-1].append(item)
            x += w + self._h
        y = area.y()
        for line in lines:
            if not line:
                continue
            height = max(it.sizeHint().height() for it in line)
            if apply:
                x = area.x()
                for it in line:
                    hint = it.sizeHint()
                    it.setGeometry(QRect(QPoint(x, y + (height - hint.height()) // 2), hint))
                    x += hint.width() + self._h
            y += height + self._v
        return max(0, y - self._v - rect.y() + m.bottom())


class EmptyHint(QObject):
    """What to do first, written in an empty table or list ("ยังไม่มี… – กด …") instead of a blank box.
    text: the words, or a function giving them (e.g. "ไม่พบ …" while a search hides every row)."""

    def __init__(self, view: QAbstractItemView, text):
        super().__init__(view)
        self.view = view
        self.text = text
        self.label = QLabel("", view.viewport())
        self.label.setObjectName("EmptyHint")
        self.label.setAlignment(Qt.AlignCenter)
        self.label.setWordWrap(True)
        self.label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.label.setStyleSheet("background: transparent;")
        view.viewport().installEventFilter(self)
        model = view.model()
        for signal in (model.rowsInserted, model.rowsRemoved, model.modelReset, model.layoutChanged):
            signal.connect(self.update)
        self.update()

    def set_text(self, text) -> None:
        self.text = text
        self.update()

    def update(self, *_args) -> None:
        try:
            model = self.view.model()
        except RuntimeError:  # the table is being deleted (its model goes after it)
            return
        empty = model is not None and model.rowCount() == 0
        if empty:
            self.label.setText(self.text() if callable(self.text) else self.text)
        self.label.setVisible(empty and bool(self.label.text()))
        self._place()

    def _place(self) -> None:
        rect = self.view.viewport().rect().adjusted(24, 8, -24, -8)
        self.label.setGeometry(rect)

    def eventFilter(self, obj, event):  # noqa: N802 - Qt API
        if event.type() == QEvent.Resize:
            self._place()
        return False


def empty_hint(view: QAbstractItemView, text) -> EmptyHint:
    view._empty_hint = EmptyHint(view, text)
    return view._empty_hint


def labeled(text: str, widget: QWidget, tooltip: str = "") -> QWidget:
    """A label and its field kept together (they wrap as one in a FlowLayout)."""
    box = QWidget()
    lay = QHBoxLayout(box)
    lay.setContentsMargins(0, 0, 0, 0)
    lay.setSpacing(6)
    if text:
        label = QLabel(text)
        if tooltip:
            label.setToolTip(tooltip)
        lay.addWidget(label)
    lay.addWidget(widget)
    return box


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
        self.setMinimumHeight(180)  # the import dialog and the drawing page fit a 768 px screen
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
        _hold_gc(True)
        try:
            result = self.fn(*self.args, **self.kwargs)
        except Exception as exc:  # noqa: BLE001 - reported in the UI
            traceback.print_exc()
            self.signals.failed.emit(str(exc))
        else:
            self.signals.done.emit(result)
        finally:
            _hold_gc(False)


_ACTIVE: set[Worker] = set()
# Python's garbage collector runs in whatever thread happens to allocate: inside a worker (reading a DXF makes
# many objects) it could free widgets left over from the UI thread, and Qt objects freed off their thread crash
# the program (seen in CI: a segfault "Garbage-collecting" in the DXF reader). So the UI thread collects before a
# worker starts, and automatic collection waits while workers run (it is the same for the whole program).
_GC = {"held": 0, "was_on": True}
_GC_LOCK = threading.Lock()


def _hold_gc(hold: bool) -> None:
    with _GC_LOCK:
        if hold:
            if not _GC["held"]:
                _GC["was_on"] = gc.isenabled()
                gc.disable()
            _GC["held"] += 1
        else:
            _GC["held"] = max(0, _GC["held"] - 1)
            if not _GC["held"] and _GC["was_on"]:
                gc.enable()


def run_async(fn, on_done, on_error, *args, **kwargs) -> None:
    gc.collect()  # leftovers of the UI thread freed here, on the UI thread
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
