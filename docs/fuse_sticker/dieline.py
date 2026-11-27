"""Die-cut files for the 145 x 55 mm sticker.

usage: python3 dieline.py artwork-bleed-raw.pdf
writes
  RRS-Fuse-Sticker-PRINT-layered.pdf   one page 151 x 61 mm, two PDF layers (OCG): "Artwork" (with 3 mm bleed) and
                                       "CutContour" (spot colour CutContour = 100 % magenta, 0.25 pt, not printed as ink)
  RRS-Fuse-Sticker-Artwork-bleed.pdf   artwork only, 151 x 61 mm, TrimBox 145 x 55
  RRS-Fuse-Sticker-CutContour.pdf      cut line only, same page size and position
  RRS-Fuse-Sticker-CutContour.svg      cut line only, true size in mm (cutting plotters)
Cut line: rounded rectangle 145 x 55 mm, corner radius R, centred on the 3 mm bleed.
"""
import sys, math
from pypdf import PdfReader, PdfWriter, PageObject
from pypdf.generic import (NameObject, DictionaryObject, ArrayObject, FloatObject, NumberObject, StreamObject,
                           TextStringObject, RectangleObject, BooleanObject)

MM = 72 / 25.4
W, H, BL, R = 145, 55, 3, 3.0
PW, PH = (W + 2 * BL) * MM, (H + 2 * BL) * MM
K = 0.5523


def path_ops(x, y, w, h, r):
    """rounded rectangle, PDF user space (origin bottom-left)"""
    k = r * K
    return (f"{x + r:.3f} {y:.3f} m {x + w - r:.3f} {y:.3f} l "
            f"{x + w - r + k:.3f} {y:.3f} {x + w:.3f} {y + r - k:.3f} {x + w:.3f} {y + r:.3f} c "
            f"{x + w:.3f} {y + h - r:.3f} l {x + w:.3f} {y + h - r + k:.3f} {x + w - r + k:.3f} {y + h:.3f} {x + w - r:.3f} {y + h:.3f} c "
            f"{x + r:.3f} {y + h:.3f} l {x + r - k:.3f} {y + h:.3f} {x:.3f} {y + h - r + k:.3f} {x:.3f} {y + h - r:.3f} c "
            f"{x:.3f} {y + r:.3f} l {x:.3f} {y + r - k:.3f} {x + r - k:.3f} {y:.3f} {x + r:.3f} {y:.3f} c h")


CUT = path_ops(BL * MM, BL * MM, W * MM, H * MM, R * MM)


def separation(w):
    """/Separation /CutContour /DeviceCMYK <0 1 0 0>"""
    fn = DictionaryObject({NameObject("/FunctionType"): NumberObject(2), NameObject("/Domain"): ArrayObject([FloatObject(0), FloatObject(1)]),
                           NameObject("/C0"): ArrayObject([FloatObject(0)] * 4),
                           NameObject("/C1"): ArrayObject([FloatObject(0), FloatObject(1), FloatObject(0), FloatObject(0)]),
                           NameObject("/N"): NumberObject(1)})
    return ArrayObject([NameObject("/Separation"), NameObject("/CutContour"), NameObject("/DeviceCMYK"), w._add_object(fn)])


def boxes(page):
    page.trimbox = RectangleObject([BL * MM, BL * MM, BL * MM + W * MM, BL * MM + H * MM])
    page.bleedbox = RectangleObject([0, 0, PW, PH])


def ocg(w, name, show=True):
    d = DictionaryObject({NameObject("/Type"): NameObject("/OCG"), NameObject("/Name"): TextStringObject(name)})
    if not show:   # never printed, never shown unless switched on; cutter software still reads the layer
        st = lambda v: DictionaryObject({NameObject("/PrintState" if v == "p" else "/ViewState"): NameObject("/OFF")})
        d[NameObject("/Usage")] = DictionaryObject({NameObject("/Print"): st("p"), NameObject("/View"): st("v")})
    return w._add_object(d)


def page_with(w, ops, res):
    pg = PageObject.create_blank_page(width=PW, height=PH)
    st = StreamObject(); st.set_data(ops.encode())
    pg[NameObject("/Contents")] = w._add_object(st)
    pg[NameObject("/Resources")] = res
    boxes(pg)
    return pg


def main(src):
    art = PdfReader(src).pages[0]
    assert abs(float(art.mediabox.width) - PW) < 2 and abs(float(art.mediabox.height) - PH) < 2, "artwork must be 151 x 61 mm"

    # 1. layered: the artwork page itself (cloned with its fonts), its content wrapped in layer L0, the cut path in L1
    w = PdfWriter()
    pg = w.add_page(art)
    l_art, l_cut = ocg(w, "Artwork"), ocg(w, "CutContour", show=False)
    body = pg.get_contents().get_data()
    st = StreamObject(); st.set_data(b"/OC /L0 BDC q\n" + body + f"\nQ EMC /OC /L1 BDC q /CS0 CS 1 SCN 0.25 w {CUT} S Q EMC".encode())
    pg[NameObject("/Contents")] = w._add_object(st)
    res = pg["/Resources"]
    cs = res.get("/ColorSpace", DictionaryObject()); cs[NameObject("/CS0")] = separation(w); res[NameObject("/ColorSpace")] = cs
    res[NameObject("/Properties")] = DictionaryObject({NameObject("/L0"): l_art, NameObject("/L1"): l_cut})
    boxes(pg)
    w._root_object[NameObject("/OCProperties")] = DictionaryObject({
        NameObject("/OCGs"): ArrayObject([l_art, l_cut]),
        NameObject("/D"): DictionaryObject({NameObject("/Order"): ArrayObject([l_art, l_cut]), NameObject("/ON"): ArrayObject([l_art]),
                                            NameObject("/OFF"): ArrayObject([l_cut]),           # cut line hidden on screen / print
                                            NameObject("/Name"): TextStringObject("Layers")})})
    w.add_metadata({"/Title": "RRS fuse/relay sticker 145x55 mm – Artwork + CutContour"})
    w.write("RRS-Fuse-Sticker-PRINT-layered.pdf")

    # 2. artwork only
    w = PdfWriter(); a = w.add_page(art); boxes(a); w.write("RRS-Fuse-Sticker-Artwork-bleed.pdf")

    # 3. cut line only
    w = PdfWriter()
    res = DictionaryObject({NameObject("/ColorSpace"): DictionaryObject({NameObject("/CS0"): separation(w)})})
    w.add_page(page_with(w, f"q /CS0 CS 1 SCN 0.25 w {CUT} S Q", res)); w.write("RRS-Fuse-Sticker-CutContour.pdf")

    # 4. SVG, mm
    x, y = BL, BL
    open("RRS-Fuse-Sticker-CutContour.svg", "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W + 2 * BL}mm" height="{H + 2 * BL}mm" viewBox="0 0 {W + 2 * BL} {H + 2 * BL}">'
        f'<g id="CutContour"><rect x="{x}" y="{y}" width="{W}" height="{H}" rx="{R}" ry="{R}" fill="none" stroke="#EC008C" stroke-width="0.1"/></g></svg>')
    print(f"cut {W} x {H} mm R{R} · page {W + 2 * BL} x {H + 2 * BL} mm")


if __name__ == "__main__":
    main(sys.argv[1])
