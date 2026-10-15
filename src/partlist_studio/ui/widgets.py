"""Reusable widgets: page header, cards, KPI tiles, drawing preview, background worker."""

from __future__ import annotations

import traceback

from PySide6.QtCore import QObject, QPointF, QRectF, QRunnable, Qt, QThreadPool, Signal
from PySide6.QtGui import QBrush, QColor, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QFrame, QGraphicsScene, QGraphicsView, QHBoxLayout,
                               QHeaderView, QLabel, QPushButton, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget)

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

    def show_drawing(self, data, selected_profiles: set[int] | None = None) -> None:
        scene = self.scene()
        scene.clear()
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
            if prof.is_container:
                continue
            is_outer = prof.parent is None
            if is_outer and i not in selected:
                continue
            if not is_outer and prof.parent not in selected:
                continue
            poly = QPolygonF([QPointF(x, -y) for x, y in prof.points])
            brush = QBrush(QColor(242, 140, 40, 45)) if is_outer else QBrush(Qt.NoBrush)
            scene.addPolygon(poly, cut_pen if is_outer else hole_pen, brush)
        # cut lines that do not close into a loop: a laser cannot cut them as a part - mark where they start
        marks = getattr(data, "open_examples", None) or []
        if marks:
            rect = scene.itemsBoundingRect()
            size = max(rect.width(), rect.height()) * 0.006 or 5
            mark_pen = QPen(QColor("#FF4D4F"))
            mark_pen.setCosmetic(True)
            mark_pen.setWidthF(2.0)
            for x, y in marks:
                scene.addEllipse(x - size, -y - size, 2 * size, 2 * size, mark_pen)
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
