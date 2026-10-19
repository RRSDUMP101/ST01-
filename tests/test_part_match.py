"""A drawing's part codes (RRS-T-001 ... in drawing order) against the codes of the stock file (Express)."""

import pytest

from partlist_studio.core import part_match as pm
from partlist_studio.core.models import Part, PartList
from partlist_studio.core.stock import StockItem, StockList, apply_status_to_parts, check_requirements

STOCK = [
    ("RRS-T-002", "หน้าเฟรมบน T", 3, "ชิ้น"),
    ("RRS-A-003", "ราง 4 คู่หน้าเฟรม(ใช้กับทุกรุ่น)", 10, "ชิ้น"),
    ("RRS-A-001-220", "ข้างเฟรมบน 220", 4, "ชิ้น"),
    ("RRS-A-001-240", "ข้างเฟรมบน 240", 4, "ชิ้น"),
    ("RRS-A-001-250", "ข้างเฟรมบน 250", 6, "ชิ้น"),
    ("RRS-A-027-L", "หูช้าง(ซ้าย)", 5, "ชิ้น"),
    ("RRS-A-027-R", "หูช้าง(ขวา)", 0, "ชิ้น"),
    ("RRS-A-078", "บู๊ชหูช้าง", 20, "ชิ้น"),
    ("RRS-T-009-L", "กระดูกข้าง T(ซ้าย)", 2, "ชิ้น"),
    ("RRS-T-009-R-", "กระดูกข้าง T(ขวา)", 2, "ชิ้น"),
    ("RRS-I-009-L", "กระดูกข้าง I (ซ้าย)", 9, "ชิ้น"),
    ("RRS-A-009-L-P4", "กระดูกข้าง(ซ้าย)", 9, "ชิ้น"),
    ("RRS-A-021-40", "เหล็กฉากฝาข้าง 40", 8, "ชิ้น"),
    ("RRS-A-021-80", "เหล็กฉากฝาข้าง 80", 8, "ชิ้น"),
    ("RRS-A-068-L", "หูล็อกฝาท้าย ซ้าย", 4, "ชิ้น"),
    ("RRS-A-069-R", "หูล็อกฝาท้าย ขวา", 4, "ชิ้น"),
    ("01-B00 -0005", "เหล็กแผ่นดำ 4 มม.4x8ฟุต", 14, "แผ่น"),
]


def _stock():
    return StockList(items=[StockItem(code=c, name=n, on_hand=q, unit=u) for c, n, q, u in STOCK])


def _drawing(*rows):
    parts = [Part(part_no=code, name=name, drawing_no="toyota-4", qty=qty) for code, name, qty in rows]
    return PartList(parts=parts)


def _match(pl, stock=None):
    return {p.part_no: m for p, m in pm.match_parts(pl, stock or _stock())}


def test_code_first_then_name_with_the_drawing_context():
    pl = _drawing(("RRS-T-002", "หน้าเฟรมบน", 1), ("RRS-T-003", "ราง 4 คู่หน้าเฟรมบน", 1),
                  ("RRS-T-001", "ข้างเฟรมบน", 2), ("RRS-T-018", "พื้น250", 1), ("RRS-T-022", "เสา80", 2),
                  ("RRS-T-021", "เหล็กฉากฝาข้าง", 2), ("RRS-T-050", "ฟันปลากันสะบัดตัวล่าง", 1))
    ctx = pm.drawing_contexts(pl)["toyota-4"]
    assert ctx.heights == {"80"} and ctx.lengths == {"250"} and "toyota" in ctx.text.lower()
    m = _match(pl)
    assert (m["RRS-T-002"].method, m["RRS-T-002"].item.code) == (pm.M_CODE, "RRS-T-002")  # the same code
    assert (m["RRS-T-003"].method, m["RRS-T-003"].item.code) == (pm.M_NAME, "RRS-A-003")  # same number, by name
    assert m["RRS-T-001"].item.code == "RRS-A-001-250"  # body length from พื้น250 of the same drawing
    assert m["RRS-T-021"].item.code == "RRS-A-021-80"  # stall height from เสา80 of the same drawing
    assert m["RRS-T-050"].method == pm.M_NONE and not m["RRS-T-050"].items  # not in the stock file: not guessed


def test_left_and_right_items_share_an_unsided_part():
    m = _match(_drawing(("RRS-T-027", "หูช้าง", 2), ("RRS-T-034", "หูล็อคฝาท้าย", 2),
                        ("RRS-T-009", "กระดูกข้างเฟรมบน", 2)))
    assert [(i.code, s) for i, s in m["RRS-T-027"].items] == [("RRS-A-027-L", 0.5), ("RRS-A-027-R", 0.5)]
    assert m["RRS-T-027"].method == pm.M_NAME  # the only close candidate was the other side
    # Express numbers the two sides differently (068 / 069): found by the name
    assert [i.code for i, _s in m["RRS-T-034"].items] == ["RRS-A-068-L", "RRS-A-069-R"]
    # same part number, Express name inside the drawing name, the drawing's model (T) before I and every model
    assert [i.code for i, _s in m["RRS-T-009"].items] == ["RRS-T-009-L", "RRS-T-009-R-"]
    assert m["RRS-T-009"].method == pm.M_CHECK


def test_check_uses_the_matches_and_keeps_sure_codes():
    pl = _drawing(("RRS-T-027", "หูช้าง", 2), ("RRS-T-003", "ราง 4 คู่หน้าเฟรมบน", 1),
                  ("RRS-T-009", "กระดูกข้างเฟรมบน", 2), ("RRS-T-050", "ฟันปลากันสะบัดตัวล่าง", 1))
    stock = _stock()
    lines = {line.code or line.name: line for line in check_requirements(pl, stock, build_qty=3)}
    left, right = lines["RRS-A-027-L"], lines["RRS-A-027-R"]
    assert (left.required, left.status, right.required, right.status) == (3, "พอ", 3, "ขาด")  # 2 × 3 cars ÷ 2 sides
    assert left.method == pm.M_NAME and "จากแบบ RRS-T-027 หูช้าง" in left.note and "ซ้าย/ขวา" in left.note
    assert lines["RRS-A-003"].required == 3 and lines["RRS-T-009-L"].method == pm.M_CHECK
    missing = next(line for line in lines.values() if line.status == "ไม่พบในสต็อก")
    assert missing.parts == ["RRS-T-050"] and missing.method == pm.M_NONE
    apply_status_to_parts(pl, stock, list(lines.values()))
    codes = {p.part_no: p.stock_code for p in pl.parts}
    assert codes["RRS-T-027"] == "RRS-A-027-L / RRS-A-027-R" and codes["RRS-T-003"] == "RRS-A-003"
    assert codes["RRS-T-009"] == ""  # to check: left for a person
    assert {p.part_no: p.status for p in pl.parts}["RRS-T-027"] == "ขาด"
    # next time the stock code is used as it is (both sides)
    again = _match(pl, stock)["RRS-T-027"]
    assert again.method == pm.M_STOCK_CODE and [s for _i, s in again.items] == [0.5, 0.5]


@pytest.mark.parametrize("name, lengths, heights", [("พื้น250", {"250"}, set()), ("ข้างเฟรมบน 2.30", {"230"}, set()),
                                                     ("บังอาย 84", set(), {"84"}), ("ฝาท้าย161", set(), set())])
def test_drawing_context_numbers(name, lengths, heights):
    ctx = pm.drawing_contexts(_drawing(("RRS-T-001", name, 1)))["toyota-4"]
    assert (ctx.lengths, ctx.heights) == (lengths, heights)
