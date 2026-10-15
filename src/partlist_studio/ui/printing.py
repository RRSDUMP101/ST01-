"""PDF of the job tickets (ใบงาน A6 แนวนอน) and the shelf labels (ป้ายชั้นวาง A4 3 × 8 ดวง 70 × 37 มม.).

Drawn with Qt so the Thai text uses the program's font and the QR is sharp vector squares.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QMarginsF, QPointF, QRectF, Qt
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetricsF,
    QImage,
    QPageLayout,
    QPageSize,
    QPainter,
    QPainterPath,
    QPdfWriter,
    QPen,
)

from ..core.catalog import ShelfLabel, Ticket
from ..core.qr import qr_matrix
from . import theme

DPI = 300
LABEL_W, LABEL_H, LABEL_COLS, LABEL_ROWS = 70.0, 297.0 / 8, 3, 8
INK, MUTED, LINE = QColor("#1B2430"), QColor("#6B7686"), QColor("#B8C2CF")


def _writer(path: str | Path, size: QPageSize.PageSizeId, landscape: bool) -> QPdfWriter:
    writer = QPdfWriter(str(path))
    writer.setResolution(DPI)
    writer.setPageLayout(QPageLayout(QPageSize(size), QPageLayout.Landscape if landscape else QPageLayout.Portrait,
                                     QMarginsF(0, 0, 0, 0)))
    writer.setCreator("RRS Part List Studio")
    return writer


class _Mm:
    """Millimetres to device units (dots per inch of the PDF writer or the image)."""

    def __init__(self, dpi: float):
        self.k = dpi / 25.4

    def __call__(self, x: float, y: float, w: float, h: float) -> QRectF:
        return QRectF(x * self.k, y * self.k, w * self.k, h * self.k)

    def v(self, mm: float) -> float:
        return mm * self.k


def _font(pt: float, bold: bool = False) -> QFont:
    font = QFont(theme.app_font())
    font.setPointSizeF(pt)
    font.setBold(bold)
    return font


def _text(p: QPainter, rect: QRectF, text: str, pt: float, bold: bool = False, color: QColor = INK,
          flags=Qt.AlignLeft | Qt.AlignVCenter, fit: bool = False, wrap: bool = False, min_pt: float = 6) -> None:
    """Draw text in rect; fit = make the font smaller until one line fits, else cut it with …"""
    font = _font(pt, bold)
    if fit:
        while pt > min_pt and QFontMetricsF(font, p.device()).horizontalAdvance(text) > rect.width():
            pt -= 0.5
            font = _font(pt, bold)
    p.setFont(font)
    p.setPen(color)
    if wrap:
        p.drawText(rect, int(flags) | Qt.TextWordWrap, text)
    else:
        p.drawText(rect, int(flags), QFontMetricsF(font, p.device()).elidedText(text, Qt.ElideRight, rect.width()))


def draw_qr(p: QPainter, rect: QRectF, text: str) -> None:
    """QR code centred in rect, with a quiet zone of 2 modules."""
    matrix = qr_matrix(text)
    if not matrix:
        return
    size = min(rect.width(), rect.height())
    cell = size / (len(matrix) + 4)
    x0 = rect.x() + (rect.width() - size) / 2 + 2 * cell
    y0 = rect.y() + (rect.height() - size) / 2 + 2 * cell
    p.save()
    p.setRenderHint(QPainter.Antialiasing, False)
    p.fillRect(QRectF(x0 - 2 * cell, y0 - 2 * cell, size, size), Qt.white)
    for r, row in enumerate(matrix):
        c = 0
        while c < len(row):
            if not row[c]:
                c += 1
                continue
            start = c
            while c < len(row) and row[c]:
                c += 1
            # a little overlap: no thin white lines between the squares in PDF viewers
            p.fillRect(QRectF(x0 + start * cell, y0 + r * cell, (c - start) * cell + 0.6, cell + 0.6), Qt.black)
    p.restore()


def draw_outline(p: QPainter, rect: QRectF, loops: list) -> None:
    """Flat pattern (mm, y up) fitted in rect: outline + holes."""
    pts = [pt for loop in loops for pt in loop]
    if not pts:
        return
    xs, ys = [x for x, _y in pts], [y for _x, y in pts]
    w, h = max(xs) - min(xs) or 1, max(ys) - min(ys) or 1
    scale = min(rect.width() / w, rect.height() / h) * 0.9
    cx, cy = rect.center().x(), rect.center().y()
    mx, my = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    path = QPainterPath()
    path.setFillRule(Qt.OddEvenFill)
    for loop in loops:
        if len(loop) < 2:
            continue
        path.moveTo(QPointF(cx + (loop[0][0] - mx) * scale, cy - (loop[0][1] - my) * scale))
        for x, y in loop[1:]:
            path.lineTo(QPointF(cx + (x - mx) * scale, cy - (y - my) * scale))
        path.closeSubpath()
    p.save()
    p.setRenderHint(QPainter.Antialiasing, True)
    p.setPen(QPen(QColor(theme.NAVY), max(1.0, rect.width() / 250)))
    p.setBrush(QColor("#E3EBF5"))
    p.drawPath(path)
    p.restore()


def _draw_image(p: QPainter, rect: QRectF, path: str) -> bool:
    image = QImage(path)
    if image.isNull():
        return False
    scaled = image.size().scaled(int(rect.width()), int(rect.height()), Qt.KeepAspectRatio)
    target = QRectF(rect.x() + (rect.width() - scaled.width()) / 2, rect.y() + (rect.height() - scaled.height()) / 2,
                    scaled.width(), scaled.height())
    p.drawImage(target, image)
    return True


def _checkbox(p: QPainter, rect: QRectF, done: bool, pen_w: float) -> None:
    p.save()
    p.setPen(QPen(INK, pen_w))
    p.setBrush(Qt.NoBrush)
    p.drawRect(rect)
    if done:
        p.setPen(QPen(QColor("#2E9D5B"), pen_w * 2))
        p.drawLine(QPointF(rect.left() + rect.width() * 0.2, rect.top() + rect.height() * 0.55),
                   QPointF(rect.left() + rect.width() * 0.42, rect.bottom() - rect.height() * 0.2))
        p.drawLine(QPointF(rect.left() + rect.width() * 0.42, rect.bottom() - rect.height() * 0.2),
                   QPointF(rect.right() - rect.width() * 0.15, rect.top() + rect.height() * 0.2))
    p.restore()


def _paint_ticket(p: QPainter, mm: _Mm, t: Ticket, printed: str) -> None:
    p.setPen(QPen(LINE, mm.v(0.3)))
    p.setBrush(Qt.NoBrush)
    p.drawRect(mm(3, 3, 142, 99))
    _text(p, mm(6, 5, 104, 8), f"ใบงาน  {t.no}", 14, True, fit=True)
    _text(p, mm(6, 13, 104, 12), " · ".join(x for x in (t.job_no, t.job_text) if x), 9, color=MUTED, wrap=True,
          flags=Qt.AlignLeft | Qt.AlignTop)
    draw_qr(p, mm(112, 4, 32, 32), t.payload)
    _text(p, mm(110, 35.5, 36, 4), "สแกนเพื่อบันทึก/ค้นหา", 6, color=MUTED, flags=Qt.AlignCenter)

    box = mm(6, 27, 46, 46)
    p.setPen(QPen(LINE, mm.v(0.25)))
    p.drawRect(box)
    inner = box.adjusted(mm.v(1), mm.v(1), -mm.v(1), -mm.v(1))
    if not (t.image and _draw_image(p, inner, t.image)):
        if t.outline:
            draw_outline(p, inner, t.outline)
        else:
            _text(p, inner, "ไม่มีรูป", 8, color=MUTED, flags=Qt.AlignCenter)

    _text(p, mm(56, 27, 54, 7), t.code or "(ไม่มีรหัส)", 12, True, fit=True)
    _text(p, mm(56, 34, 54, 8), t.name, 11, fit=True, min_pt=7)
    _text(p, mm(56, 42, 88, 9), f"จำนวน {t.qty:g} {t.unit}", 15, True)
    info = " · ".join(x for x in (t.material, t.program) if x)
    if info:
        _text(p, mm(56, 51, 88, 6), info, 9, color=MUTED, fit=True)
    if t.to:
        _text(p, mm(56, 57.5, 88, 6.5), "→ " + t.to, 10, True, color=QColor(theme.NAVY), fit=True)
    if t.remark:
        _text(p, mm(56, 64, 88, 9), t.remark, 8, color=MUTED, wrap=True, flags=Qt.AlignLeft | Qt.AlignTop)

    steps = t.route or [("เสร็จ", 0, t.qty)]
    width = min(34.0, 136.0 / len(steps))
    for i, (step, done, need) in enumerate(steps):
        x = 6 + i * width
        cell = mm(x, 76, width - 2, 12)
        p.setPen(QPen(LINE, mm.v(0.25)))
        p.drawRect(cell)
        _checkbox(p, mm(x + 1.5, 79, 6, 6), need > 0 and done >= need, mm.v(0.3))
        _text(p, mm(x + 9, 76.5, width - 11.5, 6), step, 10, True, fit=True)
        _text(p, mm(x + 9, 82, width - 11.5, 5.5), f"{done:g} / {need:g}", 8, color=MUTED)
    if t.due:
        _text(p, mm(6, 91, 70, 7), f"กำหนดส่ง {t.due}", 10, True)
    _text(p, mm(76, 91, 68, 7), f"พิมพ์ {printed}", 7, color=MUTED, flags=Qt.AlignRight | Qt.AlignVCenter)


def write_tickets_pdf(path: str | Path, tickets: list[Ticket]) -> int:
    """ใบงาน: one A6 landscape page per ticket (print on A6 paper/sticker, or 4 per A4 with the printer's
    'pages per sheet')."""
    writer = _writer(path, QPageSize.A6, True)
    mm = _Mm(writer.resolution())
    printed = _now_text()
    p = QPainter(writer)
    try:
        for i, t in enumerate(tickets):
            if i:
                writer.newPage()
            _paint_ticket(p, mm, t, printed)
    finally:
        p.end()
    return len(tickets)


def ticket_image(t: Ticket, dpi: int = 150) -> QImage:
    """The ticket as a picture (preview, documentation)."""
    k = dpi / 25.4
    image = QImage(round(148 * k), round(105 * k), QImage.Format_RGB32)
    image.setDotsPerMeterX(round(dpi / 0.0254))
    image.setDotsPerMeterY(round(dpi / 0.0254))
    image.fill(Qt.white)
    p = QPainter(image)
    p.setRenderHint(QPainter.TextAntialiasing, True)
    try:
        _paint_ticket(p, _Mm(dpi), t, _now_text())
    finally:
        p.end()
    return image


def _paint_label(p: QPainter, mm: _Mm, x: float, y: float, lb: ShelfLabel) -> None:
    pen = QPen(LINE, mm.v(0.2))
    pen.setStyle(Qt.DashLine)
    p.setPen(pen)
    p.setBrush(Qt.NoBrush)
    p.drawRect(mm(x + 0.5, y + 0.5, LABEL_W - 1, LABEL_H - 1))
    draw_qr(p, mm(x + 2, y + 4, 29, 29), lb.payload)
    _text(p, mm(x + 32, y + 3, LABEL_W - 34, 6), lb.code, 10, True, fit=True)
    _text(p, mm(x + 32, y + 9, LABEL_W - 34, 10), lb.name, 8, wrap=True, flags=Qt.AlignLeft | Qt.AlignTop)
    tags = " · ".join(t for t in (lb.group, lb.brand, lb.side) if t)
    _text(p, mm(x + 32, y + 19.5, LABEL_W - 34, 5), tags, 7, color=MUTED, fit=True)
    _text(p, mm(x + 32, y + 25, LABEL_W - 34, 8), lb.location or "ตำแหน่ง ________", 12 if lb.location else 9,
          bool(lb.location), color=QColor(theme.NAVY) if lb.location else MUTED, fit=True)


def write_labels_pdf(path: str | Path, labels: list[ShelfLabel]) -> int:
    """ป้ายชั้นวาง: A4, 3 × 8 labels of 70 × 37 mm (label sheets, or plain paper cut along the dashes)."""
    writer = _writer(path, QPageSize.A4, False)
    mm = _Mm(writer.resolution())
    per_page = LABEL_COLS * LABEL_ROWS
    p = QPainter(writer)
    try:
        for i, lb in enumerate(labels):
            if i and i % per_page == 0:
                writer.newPage()
            n = i % per_page
            _paint_label(p, mm, (n % LABEL_COLS) * LABEL_W, (n // LABEL_COLS) * LABEL_H, lb)
    finally:
        p.end()
    return len(labels)


def _now_text() -> str:
    now = datetime.now()
    return f"{now.day:02d}/{now.month:02d}/{now.year + 543} {now:%H:%M}"


def open_document(path: str | Path) -> None:
    """Open the PDF in the default viewer, ready to print (not in the headless tests)."""
    from PySide6.QtCore import QUrl
    from PySide6.QtGui import QDesktopServices, QGuiApplication

    if QGuiApplication.platformName() in ("offscreen", "minimal"):
        return
    QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))
