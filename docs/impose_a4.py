"""Impose an A5 booklet PDF on A4 landscape sheets for saddle-stitch printing (A4 folded in half = A5).

usage: python3 impose_a4.py in-A5.pdf out-A4.pdf
Page count is padded with blank pages to a multiple of 4. Print duplex, flip on the SHORT edge, 100 % (no fit-to-page),
stack the sheets in order, fold in half and staple on the fold. Sheet k front = [n-2k, 2k+1], back = [2k+2, n-2k-1].
"""
import sys
from pypdf import PdfReader, PdfWriter, Transformation, PageObject

A4W, A4H = 841.89, 595.28


def main(src, dst):
    r = PdfReader(src)
    pages = list(r.pages)
    pw, ph = float(pages[0].mediabox.width), float(pages[0].mediabox.height)
    n = (len(pages) + 3) // 4 * 4
    get = lambda i: pages[i - 1] if i <= len(pages) else None
    sx = min(A4W / 2 / pw, A4H / ph)                     # A5 on half-A4 is 1.0
    order = []
    for k in range(n // 4):
        order += [(n - 2 * k, 2 * k + 1), (2 * k + 2, n - 2 * k - 1)]
    w = PdfWriter()
    for left, right in order:
        sheet = PageObject.create_blank_page(width=A4W, height=A4H)
        for slot, num in ((0, left), (1, right)):
            p = get(num)
            if p is None:
                continue
            dx = slot * A4W / 2 + (A4W / 2 - pw * sx) / 2
            dy = (A4H - ph * sx) / 2
            sheet.merge_transformed_page(p, Transformation().scale(sx).translate(dx, dy))
        w.add_page(sheet)
    w.add_metadata({"/Title": (r.metadata or {}).get("/Title", "") + " – A4 imposed (saddle stitch)"})
    w.write(dst)
    print(f"{len(pages)} pages → {len(order)} A4 sides ({len(order) // 2} sheets): {order}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
