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


def main() -> int:
    OUT.mkdir(exist_ok=True)
    side_panel()
    assembly()
    zwcad_tableexport_csv()
    stock_csv()
    print("samples written to", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
