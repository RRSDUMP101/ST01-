"""Draw the app icon and write PNG / ICO (Windows) / ICNS (macOS).

    QT_QPA_PLATFORM=offscreen python tools/make_icon.py      (needs Pillow)
"""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QGuiApplication, QImage, QPainter, QPainterPath, QPen

ROOT = Path(__file__).resolve().parents[1]


def draw(size: int = 1024) -> QImage:
    img = QImage(size, size, QImage.Format_ARGB32)
    img.fill(Qt.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    s = size / 100
    bg = QPainterPath()
    bg.addRoundedRect(QRectF(4 * s, 4 * s, 92 * s, 92 * s), 20 * s, 20 * s)
    p.fillPath(bg, QColor("#1F4E79"))
    # drawing sheet with a flat pattern
    p.setPen(QPen(QColor("#9FC3E7"), 2.2 * s))
    p.drawRect(QRectF(18 * s, 20 * s, 42 * s, 34 * s))
    p.setPen(QPen(QColor("#F28C28"), 3.2 * s))
    outline = QPainterPath()
    outline.moveTo(24 * s, 28 * s)
    outline.lineTo(48 * s, 28 * s)
    outline.quadTo(54 * s, 28 * s, 54 * s, 34 * s)
    outline.lineTo(54 * s, 47 * s)
    outline.lineTo(24 * s, 47 * s)
    outline.closeSubpath()
    p.drawPath(outline)
    p.setPen(QPen(QColor("#4FC3F7"), 2.2 * s))
    for cx in (31, 39, 47):
        p.drawEllipse(QRectF((cx - 2.2) * s, 35.3 * s, 4.4 * s, 4.4 * s))
    # list rows
    p.setPen(Qt.NoPen)
    for i, w in enumerate((40, 32, 36)):
        y = 62 + i * 9
        p.setBrush(QColor("#F28C28") if i == 0 else QColor("#FFFFFF"))
        p.drawRoundedRect(QRectF(18 * s, y * s, 5 * s, 5 * s), 1.2 * s, 1.2 * s)
        p.setBrush(QColor("#DCE8F5"))
        p.drawRoundedRect(QRectF(27 * s, (y + 0.8) * s, w * s, 3.4 * s), 1.7 * s, 1.7 * s)
    # sync arrows
    p.setPen(QPen(QColor("#FFFFFF"), 3.4 * s, Qt.SolidLine, Qt.RoundCap))
    p.drawArc(QRectF(64 * s, 22 * s, 22 * s, 22 * s), 30 * 16, 220 * 16)
    p.drawLine(int(84 * s), int(27 * s), int(85.5 * s), int(21 * s))
    p.drawLine(int(84 * s), int(27 * s), int(78 * s), int(25.5 * s))
    p.end()
    return img


def main() -> int:
    QGuiApplication(sys.argv)
    from PIL import Image

    img = draw()
    pkg = ROOT / "packaging"
    res = ROOT / "src" / "partlist_studio" / "resources"
    res.mkdir(exist_ok=True)
    png = pkg / "app.png"
    img.save(str(png))
    img.scaled(256, 256, Qt.KeepAspectRatio, Qt.SmoothTransformation).save(str(res / "app.png"))
    pil = Image.open(png)
    pil.save(pkg / "app.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    pil.save(pkg / "app.icns")
    print("icons written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
