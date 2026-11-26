"""Add crop marks and PDF trim/bleed boxes to an A5 + 3 mm bleed PDF (154 x 216 mm per page) for a print shop.

usage: python3 cropmarks.py in-bleed-raw.pdf out-print.pdf
Each page goes on a 174 x 236 mm sheet (10 mm slug round the bleed); marks sit in the slug on the trim lines.
TrimBox = A5 (148 x 210 mm), BleedBox = trim + 3 mm.
"""
import sys
from pypdf import PdfReader, PdfWriter, Transformation, PageObject
from pypdf.generic import RectangleObject, StreamObject, NameObject, ArrayObject

MM = 72 / 25.4
BLEED, SLUG = 3 * MM, 10 * MM


def main(src, dst):
    r = PdfReader(src); w = PdfWriter()
    for p in r.pages:
        bw, bh = float(p.mediabox.width), float(p.mediabox.height)
        W, H = bw + 2 * SLUG, bh + 2 * SLUG
        sheet = PageObject.create_blank_page(width=W, height=H)
        sheet.merge_transformed_page(p, Transformation().translate(SLUG, SLUG))
        x0, y0, x1, y1 = SLUG + BLEED, SLUG + BLEED, W - SLUG - BLEED, H - SLUG - BLEED     # trim
        g, L = BLEED + 1 * MM, 6 * MM                                                  # gap from trim, mark length
        ops = ["q 0.25 w 0 0 0 1 K"]
        for x in (x0, x1):
            ops += [f"{x:.2f} {y0 - g:.2f} m {x:.2f} {y0 - g - L:.2f} l S", f"{x:.2f} {y1 + g:.2f} m {x:.2f} {y1 + g + L:.2f} l S"]
        for y in (y0, y1):
            ops += [f"{x0 - g:.2f} {y:.2f} m {x0 - g - L:.2f} {y:.2f} l S", f"{x1 + g:.2f} {y:.2f} m {x1 + g + L:.2f} {y:.2f} l S"]
        ops.append("Q")
        marks = StreamObject(); marks.set_data(" ".join(ops).encode())
        mark_page = PageObject.create_blank_page(width=W, height=H)
        mark_page[NameObject("/Contents")] = w._add_object(marks)
        sheet.merge_page(mark_page)
        sheet.trimbox = RectangleObject([x0, y0, x1, y1])
        sheet.bleedbox = RectangleObject([SLUG, SLUG, W - SLUG, H - SLUG])
        w.add_page(sheet)
    w.write(dst)
    print(f"{len(r.pages)} pages, sheet {W / MM:.0f} x {H / MM:.0f} mm, trim {(x1 - x0) / MM:.1f} x {(y1 - y0) / MM:.1f} mm")


if __name__ == "__main__":
    main(*sys.argv[1:3])
