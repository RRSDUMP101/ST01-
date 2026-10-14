"""Generate sample files in samples/ that imitate what ZWCAD (ZW2D) and the store produce.

    python tools/make_samples.py
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "samples"


def _title_block(doc, msp, origin=(250, 0), values=None):
    """A frame + title block block with attributes, the way company templates are set up."""
    if "RRS_TITLE" not in doc.blocks:
        blk = doc.blocks.new("RRS_TITLE")
        blk.add_lwpolyline([(0, 0), (170, 0), (170, 40), (0, 40)], close=True, dxfattribs={"layer": "TITLE"})
        for y in (10, 20, 30):
            blk.add_line((0, y), (170, y), dxfattribs={"layer": "TITLE"})
        for i, (tag, label) in enumerate([("DWG_NO", "DWG NO"), ("TITLE", "TITLE"), ("MATERIAL", "MATERIAL"),
                                          ("THK", "THK"), ("QTY", "QTY"), ("REV", "REV")]):
            col, row = divmod(i, 3)
            x, y = 2 + col * 85, 32 - row * 10
            blk.add_text(label, height=2.5, dxfattribs={"layer": "TITLE"}).set_placement((x, y))
            blk.add_attdef(tag, insert=(x + 25, y), height=3, dxfattribs={"layer": "TITLE"})
    ref = msp.add_blockref("RRS_TITLE", origin, dxfattribs={"layer": "TITLE"})
    ref.add_auto_attribs(values or {})
    return ref


def _frame(msp, w=420, h=297):
    msp.add_lwpolyline([(0, 0), (w, 0), (w, h), (0, h)], close=True, dxfattribs={"layer": "FRAME"})


def side_panel():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    for name in ("CUT", "TITLE", "FRAME", "DIM"):
        doc.layers.add(name)
    msp = doc.modelspace()
    _frame(msp)
    _title_block(doc, msp, values={"DWG_NO": "RRS-TB-001", "TITLE": "แผ่นข้างตู้ ซ้าย", "MATERIAL": "SS400",
                                   "THK": "3.2", "QTY": "2", "REV": "A"})
    # Flat pattern 300 x 150 with chamfered corner made from LINE/ARC (not a polyline)
    x0, y0 = 40, 100
    msp.add_line((x0, y0), (x0 + 280, y0), dxfattribs={"layer": "CUT"})
    msp.add_arc((x0 + 280, y0 + 20), 20, 270, 360, dxfattribs={"layer": "CUT"})
    msp.add_line((x0 + 300, y0 + 20), (x0 + 300, y0 + 150), dxfattribs={"layer": "CUT"})
    msp.add_line((x0 + 300, y0 + 150), (x0, y0 + 150), dxfattribs={"layer": "CUT"})
    msp.add_line((x0, y0 + 150), (x0, y0), dxfattribs={"layer": "CUT"})
    for cx in (x0 + 40, x0 + 150, x0 + 260):
        msp.add_circle((cx, y0 + 75), 6.5, dxfattribs={"layer": "CUT"})
    # slot 60 x 12
    msp.add_lwpolyline([(x0 + 100, y0 + 110, 0), (x0 + 160, y0 + 110, 1), (x0 + 160, y0 + 122, 0),
                        (x0 + 100, y0 + 122, 1)], format="xyb", close=True, dxfattribs={"layer": "CUT"})
    msp.add_text("P1", height=5, dxfattribs={"layer": "CUT"}).set_placement((x0 + 20, y0 + 20))
    dim = msp.add_linear_dim(base=(x0, y0 - 15), p1=(x0, y0), p2=(x0 + 300, y0), dxfattribs={"layer": "DIM"})
    dim.render()
    doc.saveas(OUT / "RRS-TB-001_side_panel.dxf")


def frame_set():
    """Several flat patterns in one drawing, each labelled the way the drawing office writes it:
    code + name + thickness as separate texts, one combined text, a label block with attributes,
    a sheet-metal 'Thickness=' note - and one part with no thickness (takes THK of the title block)."""
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    for name in ("CUT", "TITLE", "FRAME", "TEXT"):
        doc.layers.add(name)
    msp = doc.modelspace()
    _frame(msp)
    _title_block(doc, msp, values={"DWG_NO": "RRS-T-SET", "TITLE": "ชุดเฟรมกระบะ", "MATERIAL": "SS400",
                                   "THK": "2.3", "QTY": "1", "REV": "A"})
    tag = doc.blocks.new("PART_TAG")
    for i, attr in enumerate(("PART_NO", "NAME", "THK")):
        tag.add_attdef(attr, insert=(0, -i * 8), height=4, dxfattribs={"layer": "TEXT"})

    def plate(x0, y0, w, h, holes=2):
        msp.add_lwpolyline([(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)], close=True,
                           dxfattribs={"layer": "CUT"})
        for k in range(holes):
            msp.add_circle((x0 + w * (k + 1) / (holes + 1), y0 + h / 2), 5, dxfattribs={"layer": "CUT"})

    def text(value, x, y, height=5):
        msp.add_text(value, height=height, dxfattribs={"layer": "TEXT"}).set_placement((x, y))

    plate(20, 200, 150, 60)  # 1: three texts under the part
    for i, value in enumerate(("RRS-T-001", "เฟรมบน", "t=3")):
        text(value, 20, 191 - i * 7)
    plate(200, 200, 180, 60, holes=3)  # 2: one text inside: code, name, thickness, quantity
    text("RRS-T-002 เฟรมล่าง t3.2 2 ชิ้น", 210, 226)
    plate(20, 60, 100, 80)  # 3: label block with PART_NO / NAME / THK attributes
    ref = msp.add_blockref("PART_TAG", (130, 130), dxfattribs={"layer": "TEXT"})
    ref.add_auto_attribs({"PART_NO": "RRS-T-003", "NAME": "แผ่นปิดข้าง", "THK": "4"})
    plate(200, 60, 100, 60, holes=1)  # 4: sheet-metal export note above the part
    text("RRS-T-004 ขาจับ", 200, 126)
    text("Thickness=2.00", 200, 134)
    plate(320, 60, 80, 60, holes=1)  # 5: no thickness written -> THK 2.3 of the title block
    text("RRS-T-005", 330, 100)
    text("ฝาปิดท้าย", 330, 90)
    doc.saveas(OUT / "RRS-T-SET_frame_parts.dxf")


def assembly():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    for name in ("PART", "TITLE", "FRAME", "BOM"):
        doc.layers.add(name)
    msp = doc.modelspace()
    _frame(msp)
    _title_block(doc, msp, values={"DWG_NO": "RRS-AS-100", "TITLE": "ชุดประตูท้าย ตู้แห้ง 6 ล้อ",
                                   "MATERIAL": "-", "THK": "-", "QTY": "1", "REV": "B"})
    bolt = doc.blocks.new("BOLT_M10x30")
    bolt.add_circle((0, 0), 5)
    bolt.add_line((-5, 0), (5, 0))
    for i in range(8):
        msp.add_blockref("BOLT_M10x30", (40 + i * 20, 60), dxfattribs={"layer": "PART"})
    hinge = doc.blocks.new("HINGE_SUS_120")
    hinge.add_lwpolyline([(0, 0), (12, 0), (12, 120), (0, 120)], close=True)
    for x in (60, 180):
        msp.add_blockref("HINGE_SUS_120", (x, 120), dxfattribs={"layer": "PART"})

    # BOM drawn with LINE + TEXT directly above the title block (header row at the bottom).
    header = ["ลำดับ", "รหัสชิ้นส่วน", "ชื่อชิ้นส่วน", "วัสดุ", "ขนาด/ความหนา", "จำนวน", "หน่วย"]
    widths = [12, 30, 48, 20, 30, 15, 15]
    rows = [
        ["1", "RRS-TB-001", "แผ่นข้างตู้ ซ้าย", "SS400", "t3.2", "1", "แผ่น"],
        ["2", "RRS-TB-002", "แผ่นข้างตู้ ขวา", "SS400", "t3.2", "1", "แผ่น"],
        ["3", "RRS-TB-010", "โครงประตู", "STKR400", "50x50x2.3", "4", "เส้น"],
        ["4", "RRS-TB-020", "บานพับสแตนเลส", "SUS304", "120 mm", "2", "ตัว"],
        ["5", "STD-M10-30", "สลักเกลียว M10x30", "SS400", "M10", "8", "ตัว"],
    ]
    bx, by, rh = 250, 40, 8
    table = [header] + rows
    total_w = sum(widths)
    for r in range(len(table) + 1):
        msp.add_line((bx, by + r * rh), (bx + total_w, by + r * rh), dxfattribs={"layer": "BOM"})
    x = bx
    for w in widths + [0]:
        msp.add_line((x, by), (x, by + len(table) * rh), dxfattribs={"layer": "BOM"})
        x += w
    for r, row in enumerate(table):  # r=0 header at the bottom, items go up
        y = by + r * rh + rh / 2
        x = bx
        for w, value in zip(widths, row):
            msp.add_text(value, height=3, dxfattribs={"layer": "BOM"}).set_placement(
                (x + w / 2, y), align=TextEntityAlignment.MIDDLE_CENTER)
            x += w
    doc.saveas(OUT / "RRS-AS-100_tailgate_assembly.dxf")


def zwcad_tableexport_csv():
    """What ZWCAD TABLEEXPORT / Data Extraction writes: a title line then the table."""
    rows = [
        ["BOM - RRS-AS-100"],
        ["Item", "Part Number", "Name", "Material", "Specification", "Quantity", "Unit", "Mass"],
        ["1", "RRS-TB-001", "แผ่นข้างตู้ ซ้าย", "SS400", "t3.2", "1", "แผ่น", "10.85"],
        ["2", "RRS-TB-002", "แผ่นข้างตู้ ขวา", "SS400", "t3.2", "1", "แผ่น", "10.85"],
        ["3", "RRS-TB-010", "โครงประตู", "STKR400", "50x50x2.3", "4", "เส้น", "3.36"],
        ["4", "RRS-TB-020", "บานพับสแตนเลส", "SUS304", "120 mm", "2", "ตัว", "0.4"],
        ["5", "STD-M10-30", "สลักเกลียว M10x30", "SS400", "M10", "8", "ตัว", "0.03"],
    ]
    with (OUT / "zwcad_tableexport_bom.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        csv.writer(fh).writerows(rows)


def stock_csv():
    """Store master (สต็อกสโตร์) as exported from Express / the store Google Sheet."""
    rows = [
        ["รหัสสินค้า", "ชื่อสินค้า", "วัสดุ", "ขนาด/ความหนา", "หน่วย", "คงเหลือ", "Min", "Max", "คลัง"],
        ["RM-PL-SS400-3.2", "เหล็กแผ่น SS400 3.2 mm", "SS400", "t3.2", "กก.", "180", "100", "500", "Store 1"],
        ["RM-TB-STKR-50", "เหล็กกล่อง 50x50x2.3", "STKR400", "50x50x2.3", "เส้น", "6", "10", "40", "Store 1"],
        ["PT-HINGE-SUS120", "บานพับสแตนเลส 120 mm", "SUS304", "120 mm", "ตัว", "1", "4", "20", "Store 2"],
        ["PT-BOLT-M10-30", "สลักเกลียว M10x30", "SS400", "M10", "ตัว", "350", "100", "1000", "Store 2"],
    ]
    with (OUT / "store_stock.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        csv.writer(fh).writerows(rows)


def company_parts_list():
    """Same layout as the company file "Parts List All Model" (one sheet per model + steel ledger)."""
    import openpyxl
    from openpyxl.drawing.image import Image as XLImage
    from PIL import Image, ImageDraw

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "กระบะคอกสูง3ราว"
    ws.append(["รายการชิ้นส่วนประกอบกระบะ ตัวอย่าง (คอกสูง 3 ราว)"])
    ws.append(["ลำดับ", "รหัส", "รายการ", "ภาพประกอบ", "ขนาด", "จำนวนที่ใช้", "หมายเหตุ"])
    rows = [("1", "RRS-A-107", "เฟรมล่าง", "1", "Lower frame"), ("2", "RRS-A-106", "เฟรมบน", "1", "Top frame"),
            ("3", "RRS-T018", "พื้น คอกสูง", "1+1", "ซ้าย - ขวา"), ("4", "RRS-T-022", "เสาหน้า 80", "1+1", ""),
            ("5", "RRS-T-028,029", "เหล็กซองเสา", "2+2+2", "ซ้าย 3 + ขวา 3"),
            ("6", "RRS-A-108-209-2-50", "2ราวข้าง(209)กระบะ2.50", "2", "")]
    pic_dir = OUT / "_pics"
    pic_dir.mkdir(exist_ok=True)
    for i, (no, code, name, qty, remark) in enumerate(rows):
        ws.append([no, code, name, None, None, qty, remark])
        img = Image.new("RGB", (240, 140), (205, 214, 226))
        ImageDraw.Draw(img).rectangle((20, 30, 220, 110), outline=(31, 78, 121), width=6)
        path = pic_dir / f"p{i}.png"
        img.save(path)
        ws.add_image(XLImage(str(path)), f"D{3 + i}")
        ws.row_dimensions[3 + i].height = 60
    st = wb.create_sheet("สต๊อกเหล็ก")
    st.append(["ลำดับ", "รายการ", "ยอดยกมา", "ยอดรับเข้า", "จ่ายออก", None, "รวมจ่าย", "คงเหลือ"])
    st.append([None, None, None, None, "2026-10-01", "2026-10-02", None, None])
    st.append([1, "เหล็กแผ่นดำ 3 มม.  5x10ฟุต", 14, 0, 2, None, 2, 12])
    st.append([2, "เหล็กแผ่นดำ 4 มม.  5x10 ฟุต", 3, 5, None, None, 0, 8])
    wb.save(OUT / "company_parts_list_all_model_sample.xlsx")
    for p in pic_dir.iterdir():
        p.unlink()
    pic_dir.rmdir()


def company_stock_count():
    """Same layout as "รายการ Stock ชิ้นส่วนกระบะดั้มพ์.นับสต๊อค" (STBALLL + Format Stock R1)."""
    import sys as _sys

    _sys.path.insert(0, str(ROOT / "src"))
    from partlist_studio.core.company_files import export_stock_count
    from partlist_studio.core.stock import StockItem, StockList

    items = [StockItem(code="01-0001-0006", name="หน้าโปร 60", on_hand=5, unit="ชุด"),
             StockItem(code="01-0003-0002", name="เสาหน้า(ขวา) 50", on_hand=10, unit="ต้น"),
             StockItem(code="01-0007-0004", name="2ราวข้าง(209)กระบะ2.50", on_hand=6, unit="ชิ้น", remark="รอพับ"),
             StockItem(code="01-0011-0049", name="ฉากยึดเฟรมพื้นเรียบ(ขวา)", on_hand=62, unit="ชิ้น", min_qty=20)]
    export_stock_count(StockList(items=items), OUT / "company_stock_count_sample.xlsx")


DETAIL_ITEMS = [
    # code, name, unit, remark
    ("01-B00 -0003", "เหล็กแผ่นดำ 2.5 มม.4x8ฟุต(ฝาข้าง+ฝาท้าย)1219x2440", "แผ่น", "ฝาข้าง"),
    ("RRS-A-019-188-5-2-30", "ฝาข้าง(188.5)กระบะ2.30", "ชิ้น", ""),
    ("RRS-A-020-161CM", "ฝาท้าย (161cm)", "ชิ้น", ""),
    ("RRS-A-024", "บังอาย 40", "ชิ้น", ""),
    ("RRS-A-033", "ตะขอเกี่ยวฝาท้าย", "ชิ้น", ""),
    ("RRS-A-092-L", "ซองเสา 2ราว(ซ้าย)", "ชิ้น", ""),
    ("RRS-A-102-L-40", "เสาหลัง(ซ้าย) 40", "ต้น", ""),
    ("RRS-A-102-L-80", "เสาหลัง(ซ้าย) 80", "ต้น", ""),
    ("RRS-A-102-R-40", "เสาหลัง(ขวา) 40", "ต้น", ""),
    ("RRS-A-102-R-80", "เสาหลัง(ขวา) 80", "ต้น", ""),
    ("RRS-T-024-L-40-CHAMP", "บังอาย Champ 40(ซ้าย)", "ชิ้น", ""),
    ("RRS-T-024-L-84", "บังอาย Champ 84(ซ้าย)", "ชิ้น", ""),
    ("RRS-T-024-R-40-CHAMP", "บังอาย Champ 40(ขวา)", "ชิ้น", ""),
    ("RRS-T-024-R-84-CHAMP", "บังอาย Champ 84(ขวา)", "ชิ้น", ""),
]


def express_item_detail_report() -> str:
    """Same layout as Express 6.รายงาน → รายงานรายละเอียดสินค้า (STMASR0200), cp874 with NBSP and quotes."""
    rule = "-" * 157
    lines = ["สต๊อค บริษัทตัวอย่าง จำกัด".ljust(130) + "หน้า   :        1",
             "  รายงานรายละเอียดสินค้า",
             f"รหัสสินค้า จาก  {DETAIL_ITEMS[0][0]}     ถึง  {DETAIL_ITEMS[-1][0]}".ljust(140) + "วันที่ : 13/10/69",
             rule,
             "  รหัส       รายละเอียด                                                   หน่วย  นับเป็น      ตัวคูณ  "
             "รหัสบ/ช   ราคามาตรฐาน   สินค้าทดแทน          ผู้จัดจำหน่าย",
             rule,
             "  21      รายการเหล็กสำหรับผลิตดั้มพ์"]
    pad = " " * 74
    for code, name, unit, remark in DETAIL_ITEMS:
        lines.append(f"  {code:<20} {name.replace(' ', chr(160)):<51}ย่อย  {unit:<20}ST01            0.000")
        lines.append(pad + "ใหญ่")
        lines.append(pad + f"ซื้อ  {unit:<8}{1:>8.2f}")
        left = f"             หมายเหตุ  {remark}".ljust(74) if remark else pad
        lines.append(left + f"ขาย   {unit:<8}{1:>8.2f}")
        lines.append(" " * 23 + "-" * 134)
    return "\r\n".join(f'"{line}"' for line in lines) + "\r\n"


def main() -> int:
    OUT.mkdir(exist_ok=True)
    side_panel()
    frame_set()
    assembly()
    zwcad_tableexport_csv()
    stock_csv()
    company_parts_list()
    company_stock_count()
    (OUT / "express_item_detail_STMASR0200.txt").write_bytes(express_item_detail_report().encode("cp874"))
    print("samples written to", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
