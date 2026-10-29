"""A fake camera for testing the AR of the mobile app in Chromium: a store shelf with QR labels, as MJPEG for
`--use-file-for-fake-video-capture`.

    python tools/mobile_fake_camera.py OUT.mjpeg [portrait|landscape] [noleft]
"""

from __future__ import annotations

import io
import math
import sys
from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

LATIN = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf"]
THAI = ["/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf", "/usr/share/fonts/truetype/tlwg/Garuda.ttf",
        "tahoma.ttf", "Thonburi.ttc"]

PORTRAIT = [(18, 365, "RRS1|I|RRS-T-022-R-84|P-POST-05", "P-POST-05", "เสาหลัง ขวา"),
            (372, 365, "RRS1|L|P-POST-06", "P-POST-06", "ชั้นเสา"),
            (18, 800, "RRS1|L|P-POST-03", "P-POST-03", "ชั้นเสา"),
            (372, 800, "RRS1|I|RRS-T-022-L-84|P-POST-04", "P-POST-04", "เสาหลัง ซ้าย"),
            (200, 1010, "RRS1|J|SO6910-016|1|RRS-T-001|32", "SO6910-016", "ใบงาน")]
LANDSCAPE = [(30, 175, "RRS1|L|P-POST-03", "P-POST-03", "ชั้นเสา"),
             (430, 175, "RRS1|I|RRS-T-022-L-84|P-POST-04", "P-POST-04", "เสาหลัง ซ้าย"),
             (830, 175, "RRS1|I|RRS-T-022-R-84|P-POST-05", "P-POST-05", "เสาหลัง ขวา"),
             (900, 450, "RRS1|J|SO6910-016|1|RRS-T-001|32", "SO6910-016", "ใบงาน")]


def _font(names: list[str], size: int):
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _qr(text: str, px: int) -> Image.Image:
    buf = io.BytesIO()
    segno.make(text, error="m").save(buf, kind="png", scale=8, border=2)
    buf.seek(0)
    return Image.open(buf).convert("RGB").resize((px, px), Image.NEAREST)


def scene(kind: str, labels, shift: int = 0) -> Image.Image:
    w, h = (720, 1280) if kind == "portrait" else (1280, 720)
    big, small = _font(LATIN, 30), _font(THAI, 22)
    im = Image.new("RGB", (w, h), (86, 92, 104))
    d = ImageDraw.Draw(im)
    beams = (330, 760, 1190) if kind == "portrait" else (150, 410, 670)
    pitch = 360 if kind == "portrait" else 320
    for y in beams:
        d.rectangle([0, y, w, y + 30], fill=(214, 120, 40))
    for x in range(0, w, pitch):
        d.rectangle([x, 0, x + 16, h], fill=(58, 62, 70))
    for k in range(4):
        for y0, y1 in ((beams[0] - 170, beams[0]), (beams[1] - 170, beams[1])):
            x0 = 50 + k * pitch
            d.rectangle([x0, y0, x0 + 250, y1], fill=(150, 156, 166))
    for x, y, text, title, sub in labels:
        x += shift
        d.rounded_rectangle([x, y, x + 330, y + 150], 10, fill=(255, 255, 255), outline=(30, 30, 30), width=2)
        im.paste(_qr(text, 126), (x + 12, y + 12))
        d.text((x + 150, y + 22), title, fill=(15, 28, 46), font=big)
        d.text((x + 150, y + 70), sub, fill=(70, 80, 95), font=small)
    return im


def write(out: str | Path, kind: str = "portrait", variant: str = "", frames: int = 24) -> Path:
    labels = PORTRAIT if kind == "portrait" else LANDSCAPE
    if variant == "noleft":
        labels = [lb for lb in labels if "022-L" not in lb[2]]
    out = Path(out)
    with out.open("wb") as fh:
        for i in range(frames):
            buf = io.BytesIO()
            scene(kind, labels, int(5 * math.sin(i / frames * 2 * math.pi))).save(buf, "JPEG", quality=88)
            fh.write(buf.getvalue())
    return out


if __name__ == "__main__":
    print(write(sys.argv[1], *(sys.argv[2:4])))
