"""PDF of the job tickets (ใบงาน A6 แนวนอน: 1 per A6, or 2 / 4 / 8 per A4 with cut lines) and the shelf
labels (ป้ายชั้นวาง A4 3 × 8 ดวง 70 × 37 มม.).

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


def draw_outline(p: QPainter, rect: QRectF, loops: list, bends: list | None = None, dims: bool = False) -> None:
    """Flat pattern (mm, y up) fitted in rect: outline + holes, bend lines dashed, and with dims the overall
    width and height written along the bottom and the left side."""
    pts = [pt for loop in loops for pt in loop]
    if not pts:
        return
    xs, ys = [x for x, _y in pts], [y for _x, y in pts]
    w, h = max(xs) - min(xs) or 1, max(ys) - min(ys) or 1
    pad = min(rect.width(), rect.height()) * 0.12 if dims else 0
    area = rect.adjusted(pad, 0, 0, -pad)
    scale = min(area.width() / w, area.height() / h) * 0.9
    cx, cy = area.center().x(), area.center().y()
    mx, my = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2

    def at(x: float, y: float) -> QPointF:
        return QPointF(cx + (x - mx) * scale, cy - (y - my) * scale)

    path = QPainterPath()
    path.setFillRule(Qt.OddEvenFill)
    for loop in loops:
        if len(loop) < 2:
            continue
        path.moveTo(at(*loop[0]))
        for x, y in loop[1:]:
            path.lineTo(at(x, y))
        path.closeSubpath()
    line_w = max(1.0, rect.width() / 250)
    p.save()
    p.setRenderHint(QPainter.Antialiasing, True)
    p.setPen(QPen(QColor(theme.NAVY), line_w))
    p.setBrush(QColor("#E3EBF5"))
    p.drawPath(path)
    if bends:
        pen = QPen(QColor("#D64545"), line_w)
        pen.setStyle(Qt.DashLine)
        p.setPen(pen)
        for line in bends:
            if len(line) >= 2:
                p.drawLine(at(*line[0]), at(*line[-1]))
    if dims:
        left, right = at(min(xs), min(ys)).x(), at(max(xs), min(ys)).x()
        top, bottom = at(min(xs), max(ys)).y(), at(min(xs), min(ys)).y()
        p.setPen(QPen(MUTED, line_w * 0.6))
        y = bottom + pad * 0.3
        x = left - pad * 0.3
        tick = pad * 0.15
        p.drawLine(QPointF(left, y), QPointF(right, y))
        p.drawLine(QPointF(x, top), QPointF(x, bottom))
        for px in (left, right):
            p.drawLine(QPointF(px, y - tick), QPointF(px, y + tick))
        for py in (top, bottom):
            p.drawLine(QPointF(x - tick, py), QPointF(x + tick, py))
        _text(p, QRectF(left, y, right - left, pad * 0.7), _dim(w), 6, color=MUTED, flags=Qt.AlignHCenter | Qt.AlignTop)
        p.save()
        p.translate(x, (top + bottom) / 2)
        p.rotate(-90)
        _text(p, QRectF(-(bottom - top) / 2, -pad * 0.75, bottom - top, pad * 0.7), _dim(h), 6, color=MUTED,
              flags=Qt.AlignHCenter | Qt.AlignBottom)
        p.restore()
    p.restore()


def _dim(v: float) -> str:
    return f"{v:.0f}" if abs(v - round(v)) < 0.05 else f"{v:.1f}"


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


TICKET_ROWS = ["รหัสตามแบบ DWG", "รหัส Express", "ยี่ห้อ / รุ่นรถ", "รุ่นกระบะ", "ขนาด", "วัสดุ"]


def ticket_rows(t: Ticket) -> list[tuple[str, str]]:
    """The labelled lines of a ticket (the remark only when there is one)."""
    express = t.express_code + (f" ({t.express_note})" if t.express_code and t.express_note else "")
    material = " · ".join(x for x in (t.material, t.program) if x)
    rows = list(zip(TICKET_ROWS, [t.drawing_code, express or t.express_note, t.vehicle, t.body, t.size, material]))
    rows = [(label, value or "–") for label, value in rows]
    if t.remark:
        rows.append(("หมายเหตุ", t.remark))
    return rows


def _paint_ticket(p: QPainter, mm: _Mm, t: Ticket, printed: str) -> None:
    p.setPen(QPen(LINE, mm.v(0.3)))
    p.setBrush(Qt.NoBrush)
    p.drawRect(mm(3, 3, 142, 99))
    _text(p, mm(6, 5, 102, 8), f"ใบงาน  {t.no}", 14, True, fit=True)
    _text(p, mm(6, 13, 102, 5.5), " · ".join(x for x in (t.job_no, t.job_text) if x), 8, color=MUTED, fit=True)
    draw_qr(p, mm(110, 4, 34, 34), t.payload)
    _text(p, mm(108, 37.5, 38, 3.5), "สแกน: งาน · รหัส · วัสดุ · ขนาด", 5.5, color=MUTED, flags=Qt.AlignCenter,
          fit=True, min_pt=4.5)

    # 2D of the part from its drawing (else its picture)
    box = mm(6, 20, 50, 52)
    p.setPen(QPen(LINE, mm.v(0.25)))
    p.drawRect(box)
    inner = box.adjusted(mm.v(1), mm.v(1), -mm.v(1), -mm.v(1))
    if t.outline:
        draw_outline(p, inner, t.outline, t.bends, dims=True)
        caption = "รูป 2D จากแบบ DWG" + (f" {t.drawing}" if t.drawing else "")
    elif t.image and _draw_image(p, inner, t.image):
        caption = "รูปชิ้นงาน"
    else:
        _text(p, inner, "ไม่มีรูป", 8, color=MUTED, flags=Qt.AlignCenter)
        caption = ""
    if caption:
        _text(p, mm(6, 72.3, 50, 3.6), caption, 6, color=MUTED, fit=True, min_pt=4.5)

    _text(p, mm(59, 20, 49, 7), t.name or t.code or "(ไม่มีชื่อ)", 12, True, fit=True, min_pt=7)
    _text(p, mm(59, 27, 49, 7), f"จำนวน {t.qty:g} {t.unit}", 13, True, fit=True)
    if t.to:
        _text(p, mm(59, 34.3, 49, 6), "→ " + t.to, 9, True, color=QColor(theme.NAVY), fit=True)
    rows = ticket_rows(t)
    step = 36.0 / max(6, len(rows))
    for n, (label, value) in enumerate(rows):
        y = 41.5 + n * step
        if n:
            p.setPen(QPen(LINE, mm.v(0.15)))
            p.drawLine(QPointF(mm.v(59), mm.v(y)), QPointF(mm.v(144), mm.v(y)))
        _text(p, mm(59, y, 23, step), label, 6.5, color=MUTED)
        _text(p, mm(82, y, 62, step), value, 9 if n < 2 else 8.5, n < 2, fit=True, min_pt=5.5)

    steps = t.route or [("เสร็จ", 0, t.qty)]
    width = min(34.0, 136.0 / len(steps))
    for i, (step_name, done, need) in enumerate(steps):
        x = 6 + i * width
        cell = mm(x, 79, width - 2, 11)
        p.setPen(QPen(LINE, mm.v(0.25)))
        p.drawRect(cell)
        _checkbox(p, mm(x + 1.5, 81.5, 6, 6), need > 0 and done >= need, mm.v(0.3))
        _text(p, mm(x + 9, 79.3, width - 11.5, 5.5), step_name, 10, True, fit=True)
        _text(p, mm(x + 9, 84.5, width - 11.5, 5), f"{done:g} / {need:g}", 8, color=MUTED)
    if t.due:
        _text(p, mm(6, 92, 70, 7), f"กำหนดส่ง {t.due}", 10, True)
    _text(p, mm(76, 92, 68, 7), f"พิมพ์ {printed}", 7, color=MUTED, flags=Qt.AlignRight | Qt.AlignVCenter)


TICKET_W, TICKET_H = 148.0, 105.0  # A6 landscape
PRINT_MARGIN = 5.0  # mm the printers leave white at the edge of an A4 sheet
# per sheet -> (paper, landscape, columns, rows)
TICKET_LAYOUTS = {1: (QPageSize.A6, True, 1, 1), 2: (QPageSize.A4, False, 1, 2), 4: (QPageSize.A4, True, 2, 2),
                  8: (QPageSize.A4, False, 2, 4)}
TICKET_LAYOUT_TEXT = {1: "A6 · 1 ใบ/แผ่น", 2: "A4 · 2 ใบ/แผ่น", 4: "A4 · 4 ใบ/แผ่น", 8: "A4 · 8 ใบ/แผ่น (เล็ก)"}


def ticket_cells(per_page: int) -> tuple[float, list[tuple[float, float]]]:
    """(scale, [(x, y) mm of each ticket on the sheet]): A6 tickets in a grid inside the printable area of
    the paper, as large as they fit (4 per A4 = 95 %, 8 per A4 = 68 %)."""
    _size, landscape, cols, rows = TICKET_LAYOUTS[per_page]
    if per_page == 1:
        return 1.0, [(0.0, 0.0)]
    page_w, page_h = (297.0, 210.0) if landscape else (210.0, 297.0)
    cell_w, cell_h = (page_w - 2 * PRINT_MARGIN) / cols, (page_h - 2 * PRINT_MARGIN) / rows
    scale = min(1.0, cell_w / TICKET_W, cell_h / TICKET_H)
    w, h = TICKET_W * scale, TICKET_H * scale
    x0, y0 = (page_w - cols * w) / 2, (page_h - rows * h) / 2  # the grid in the middle of the sheet
    return scale, [(x0 + c * w, y0 + r * h) for r in range(rows) for c in range(cols)]


def _cut_lines(p: QPainter, mm: _Mm, per_page: int, scale: float, cells: list[tuple[float, float]]) -> None:
    """Dashed lines between the tickets of a sheet: cut along them."""
    _size, _landscape, cols, rows = TICKET_LAYOUTS[per_page]
    w, h = TICKET_W * scale, TICKET_H * scale
    x0, y0 = cells[0]
    pen = QPen(LINE, mm.v(0.2))
    pen.setStyle(Qt.DashLine)
    p.save()
    p.setPen(pen)
    for c in range(cols + 1):
        p.drawLine(QPointF(mm.v(x0 + c * w), mm.v(y0)), QPointF(mm.v(x0 + c * w), mm.v(y0 + rows * h)))
    for r in range(rows + 1):
        p.drawLine(QPointF(mm.v(x0), mm.v(y0 + r * h)), QPointF(mm.v(x0 + cols * w), mm.v(y0 + r * h)))
    p.restore()


def write_tickets_pdf(path: str | Path, tickets: list[Ticket], per_page: int = 1) -> int:
    """ใบงาน: per_page = 1 (A6 landscape paper or sticker), 2 / 4 / 8 on A4 with dashed cut lines.
    Returns the number of tickets."""
    if per_page not in TICKET_LAYOUTS:
        per_page = 1
    size, landscape, _cols, _rows = TICKET_LAYOUTS[per_page]
    writer = _writer(path, size, landscape)
    mm = _Mm(writer.resolution())
    scale, cells = ticket_cells(per_page)
    printed = _now_text()
    p = QPainter(writer)
    try:
        for i, t in enumerate(tickets):
            n = i % len(cells)
            if i and n == 0:
                writer.newPage()
            if n == 0 and per_page > 1:
                _cut_lines(p, mm, per_page, scale, cells)
            p.save()
            p.translate(mm.v(cells[n][0]), mm.v(cells[n][1]))
            p.scale(scale, scale)
            _paint_ticket(p, mm, t, printed)
            p.restore()
    finally:
        p.end()
    return len(tickets)


def tickets_page_image(tickets: list[Ticket], per_page: int, dpi: int = 60) -> QImage:
    """First sheet of the tickets as a picture (preview, documentation)."""
    _size, landscape, _cols, _rows = TICKET_LAYOUTS[per_page]
    w, h = (297.0, 210.0) if landscape else (210.0, 297.0)
    if per_page == 1:
        w, h = TICKET_W, TICKET_H
    k = dpi / 25.4
    image = QImage(round(w * k), round(h * k), QImage.Format_RGB32)
    image.setDotsPerMeterX(round(dpi / 0.0254))
    image.setDotsPerMeterY(round(dpi / 0.0254))
    image.fill(Qt.white)
    mm = _Mm(dpi)
    scale, cells = ticket_cells(per_page)
    p = QPainter(image)
    p.setRenderHint(QPainter.TextAntialiasing, True)
    try:
        if per_page > 1:
            _cut_lines(p, mm, per_page, scale, cells)
        for t, (x, y) in zip(tickets, cells):
            p.save()
            p.translate(mm.v(x), mm.v(y))
            p.scale(scale, scale)
            _paint_ticket(p, mm, t, _now_text())
            p.restore()
    finally:
        p.end()
    return image


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
