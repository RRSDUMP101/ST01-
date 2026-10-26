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
    ("RRS-I-009-R", "กระดูกข้าง I (ขวา)", 9, "ชิ้น"),
    ("RRS-A-025", "หูบนตัวใน", 6, "ชิ้น"),
    ("RRS-A-026-L", "หูบนตัวนอก(ซ้าย)", 6, "ชิ้น"),
    ("RRS-A-026-R", "หูบนตัวนอก(ขวา)", 6, "ชิ้น"),
    ("RRS-A-020-161CM", "ฝาท้าย (161cm)", 3, "ชิ้น"),
    ("RRS-A-020-169CM", "ฝาท้าย (169cm)", 3, "ชิ้น"),
    ("RRS-A-037-PR", "บังโคลนพื้นเรียบ", 4, "ชิ้น"),
    ("RRS-A-039-NO1-PR", "เต้าพื้นเรียบเบอร์ 1", 8, "ชิ้น"),
    ("RRS-A-040-NO2-PR", "เต้าพื้นเรียบเบอร์ 2", 8, "ชิ้น"),
    ("RRS-A-041-NO3-PR", "เต้าพื้นเรียบเบอร์ 3", 8, "ชิ้น"),
    ("01-B00 -0005", "เหล็กแผ่นดำ 4 มม.4x8ฟุต", 14, "แผ่น"),
]


def _stock():
    return StockList(items=[StockItem(code=c, name=n, on_hand=q, unit=u) for c, n, q, u in STOCK])


def _drawing(*rows, drawing_no="toyota-4"):
    parts = [Part(part_no=code, name=name, drawing_no=drawing_no, qty=qty) for code, name, qty in rows]
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
    assert (m["RRS-T-003"].method, m["RRS-T-003"].item.code) == (pm.M_PART_NO, "RRS-A-003")  # 003, A = every brand
    assert m["RRS-T-001"].item.code == "RRS-A-001-250"  # body length from พื้น250 of the same drawing
    assert m["RRS-T-021"].item.code == "RRS-A-021-80"  # stall height from เสา80 of the same drawing
    assert m["RRS-T-050"].method == pm.M_NONE and not m["RRS-T-050"].items  # not in the stock file: not guessed


def test_left_and_right_items_share_an_unsided_part():
    m = _match(_drawing(("RRS-T-027", "หูช้าง", 2), ("RRS-T-034", "หูล็อคฝาท้าย", 2),
                        ("RRS-T-009", "กระดูกข้างเฟรมบน", 2)))
    assert [(i.code, s) for i, s in m["RRS-T-027"].items] == [("RRS-A-027-L", 0.5), ("RRS-A-027-R", 0.5)]
    assert m["RRS-T-027"].method == pm.M_PART_NO  # 027, A = every brand: the left and the right item
    # Express numbers the two sides differently (068 / 069): found by the name
    assert [i.code for i, _s in m["RRS-T-034"].items] == ["RRS-A-068-L", "RRS-A-069-R"]
    # same part number: the drawing's brand (T) before every brand (A, P4) and another brand (I)
    assert [i.code for i, _s in m["RRS-T-009"].items] == ["RRS-T-009-L", "RRS-T-009-R-"]
    assert m["RRS-T-009"].method == pm.M_PART_NO and m["RRS-T-009"].note == "เลขชิ้นส่วน 009 ตรงกัน · T (Toyota)"


def test_check_uses_the_matches_and_keeps_sure_codes():
    pl = _drawing(("RRS-T-027", "หูช้าง", 2), ("RRS-T-003", "ราง 4 คู่หน้าเฟรมบน", 1),
                  ("RRS-T-009", "กระดูกข้างเฟรมบน", 2), ("RRS-T-050", "ฟันปลากันสะบัดตัวล่าง", 1),
                  ("RRS-T-037", "ชิ้นที่ 5", 1))
    stock = _stock()
    lines = {line.code or line.name: line for line in check_requirements(pl, stock, build_qty=3)}
    left, right = lines["RRS-A-027-L"], lines["RRS-A-027-R"]
    assert (left.required, left.status, right.required, right.status) == (3, "พอ", 3, "ขาด")  # 2 × 3 cars ÷ 2 sides
    assert left.method == pm.M_PART_NO and "จากแบบ RRS-T-027 หูช้าง" in left.note and "ซ้าย/ขวา" in left.note
    assert "A = ทุกยี่ห้อ ใช้กับ T (Toyota)" in left.note
    assert lines["RRS-A-003"].required == 3 and lines["RRS-T-009-L"].method == pm.M_PART_NO
    assert lines["RRS-A-037-PR"].method == pm.M_PART_CLOSE  # same number, another name: a close result
    missing = next(line for line in lines.values() if line.status == "ไม่พบในสต็อก")
    assert missing.parts == ["RRS-T-050"] and missing.method == pm.M_NONE
    apply_status_to_parts(pl, stock, list(lines.values()))
    codes = {p.part_no: p.stock_code for p in pl.parts}
    assert codes["RRS-T-027"] == "RRS-A-027-L / RRS-A-027-R" and codes["RRS-T-003"] == "RRS-A-003"
    assert codes["RRS-T-009"] == "RRS-T-009-L / RRS-T-009-R-"
    assert codes["RRS-T-037"] == "RRS-A-037-PR"  # close results are matched all the same
    assert {p.part_no: p.status for p in pl.parts}["RRS-T-027"] == "ขาด"
    # next time the stock code is used as it is (both sides)
    again = _match(pl, stock)["RRS-T-027"]
    assert again.method == pm.M_STOCK_CODE and [s for _i, s in again.items] == [0.5, 0.5]


@pytest.mark.parametrize("name, lengths, heights", [("พื้น250", {"250"}, set()), ("ข้างเฟรมบน 2.30", {"230"}, set()),
                                                     ("บังอาย 84", set(), {"84"}), ("ฝาท้าย161", set(), set())])
def test_drawing_context_numbers(name, lengths, heights):
    ctx = pm.drawing_contexts(_drawing(("RRS-T-001", name, 1)))["toyota-4"]
    assert (ctx.lengths, ctx.heights) == (lengths, heights)


@pytest.mark.parametrize("code, parts", [
    ("RRS-A-039-NO01-PR", ("RRS", "A", "039", ("NO01", "PR"))), ("RRS-T-039", ("RRS", "T", "039", ())),
    ("RRS-A1-030-R", ("RRS", "A", "030", ("R",))), ("RRS-T-009-R-", ("RRS", "T", "009", ("R",))),
    ("rrs-f-002 ", ("RRS", "F", "002", ())), ("01-B00 -0005", None), ("RRS-T", None)])
def test_split_code(code, parts):
    found = pm.split_code(code)
    assert (found and (found.prefix, found.brand, found.number, found.rest)) == parts


def test_a_items_go_with_every_brand():
    """RRS-T-039 เต้า1 (T = Toyota) is RRS-A-039-NO1-PR เต้าพื้นเรียบเบอร์ 1 (A = every brand)."""
    m = _match(_drawing(("RRS-T-039", "เต้า1", 2), ("RRS-T-040", "เต้าที่ 2", 2), ("RRS-T-041", "เต้า3", 2),
                        ("RRS-T-042", "เต้า4", 2)))
    for code, item in (("RRS-T-039", "RRS-A-039-NO1-PR"), ("RRS-T-040", "RRS-A-040-NO2-PR"),
                       ("RRS-T-041", "RRS-A-041-NO3-PR")):
        assert (m[code].method, m[code].item.code) == (pm.M_PART_NO, item)
    assert m["RRS-T-039"].note == "เลขชิ้นส่วน 039 ตรงกัน · A = ทุกยี่ห้อ ใช้กับ T (Toyota)"
    assert m["RRS-T-042"].method == pm.M_NONE  # no 042 in the stock: not one of the other numbers
    # the letter of a Ford drawing; the user's own spelling NO01
    stock = _stock()
    stock.items.append(StockItem(code="RRS-A-043-NO01-PR", name="กันเป๋พื้นเรียบเบอร์ 1", on_hand=1))
    m = _match(_drawing(("RRS-F-027", "หูช้าง", 2), ("RRS-F-043", "กันเป๋ 1", 1), drawing_no="ranger"), stock)
    assert [i.code for i, _s in m["RRS-F-027"].items] == ["RRS-A-027-L", "RRS-A-027-R"]
    assert m["RRS-F-027"].note == "เลขชิ้นส่วน 027 ตรงกัน · A = ทุกยี่ห้อ ใช้กับ F (Ford)"
    assert (m["RRS-F-043"].method, m["RRS-F-043"].item.code) == (pm.M_PART_NO, "RRS-A-043-NO01-PR")


def test_brand_from_the_dashboard():
    pl = _drawing(("RRS-T-009", "กระดูกข้างเฟรมบน", 2))
    assert pm.drawing_contexts(pl)["toyota-4"].brand == "T"  # read from the codes of the drawing
    pl.info.vehicle_brand = "I"  # chosen on the dashboard: Isuzu items (and A), not the drawing's T
    ctx = pm.drawing_contexts(pl)["toyota-4"]
    assert (ctx.brand, ctx.brand_from) == ("I", pm.FROM_DASHBOARD)
    m = _match(pl)["RRS-T-009"]
    assert [i.code for i, _s in m.items] == ["RRS-I-009-L", "RRS-I-009-R"] and m.method == pm.M_PART_NO
    assert m.note == "เลขชิ้นส่วน 009 ตรงกัน · I (Isuzu)"
    # no letter in the codes: the brand written in the drawing
    assert pm.drawing_contexts(_drawing(("", "หูช้าง", 1), drawing_no="ISUZU D-MAX"))["ISUZU D-MAX"].brand == "I"


def test_same_number_but_another_part_or_size():
    m = _match(_drawing(("RRS-T-025", "หูบนตัวนอก", 2), ("RRS-T-026", "หูบนตัวใน", 1), ("RRS-T-020", "ฝาท้าย161", 1),
                        ("RRS-T-040", "เต้า3", 1)))
    # Express numbers หูบนตัวใน 025 and หูบนตัวนอก 026, the drawing the other way round: found by the name
    assert [i.code for i, _s in m["RRS-T-025"].items] == ["RRS-A-026-L", "RRS-A-026-R"]
    assert m["RRS-T-025"].method == pm.M_NAME and m["RRS-T-026"].item.code == "RRS-A-025"
    assert (m["RRS-T-020"].method, m["RRS-T-020"].item.code) == (pm.M_PART_NO, "RRS-A-020-161CM")  # not 169 cm
    assert m["RRS-T-040"].method == pm.M_PART_CLOSE and m["RRS-T-040"].note.endswith("· เบอร์ 2 ≠ 3")  # by the code
    part = Part(part_no="RRS-T-040", name="เต้า3")
    no2 = next(i for i in _stock().items if i.code == "RRS-A-040-NO2-PR")
    assert pm.variant_conflict(part, no2, pm.DrawingContext()) == "เบอร์ 2 ≠ 3"


def test_close_results_are_matched():
    """Close variants, the same code with another name, a name spelt another way: matched, marked ใกล้เคียง."""
    m = _match(_drawing(("RRS-T-021", "เหล็กฉากฝาข้าง", 1), ("RRS-T-038", "ขาบังโครน", 1),
                        ("RRS-T-037", "ชิ้นที่ 5", 1), drawing_no="T-SET"))
    side = m["RRS-T-021"]  # no stall height in this drawing: 40 or 80, the first one and the other listed
    assert side.method == pm.M_PART_CLOSE and side.sure and side.close
    assert side.item.code in ("RRS-A-021-40", "RRS-A-021-80") and side.alternatives[0].startswith("RRS-A-021-")
    rows = {p.name: x for p, x in pm.match_parts(_drawing(("", "บังโครน", 1), ("", "เต้า4", 1)), _stock())}
    mud = rows["บังโครน"]
    assert (mud.method, mud.item.code) == (pm.M_NAME_CLOSE, "RRS-A-037-PR")  # บังโครน = บังโคลน
    assert mud.note == "ชื่อใกล้เคียง: บังโครน ≈ บังโคลนพื้นเรียบ"
    assert not rows["เต้า4"].items  # the same word, another number: not เต้าเบอร์ 1
    assert not m["RRS-T-038"].items  # ขาบังโครน is the bracket, not the mudguard
    assert m["RRS-T-037"].item.code == "RRS-A-037-PR"
    assert "ชื่อในแบบ ชิ้นที่ 5 ≠ บังโคลนพื้นเรียบ" in m["RRS-T-037"].note
    lines = {line.code: line for line in check_requirements(_drawing(("RRS-T-021", "เหล็กฉากฝาข้าง", 2)), _stock())}
    line = next(x for x in lines.values() if x.code.startswith("RRS-A-021-"))
    assert line.required == 2 and "ตัวเลือกอื่น: RRS-A-021-" in line.note  # in the check, with the other choice


def test_not_found_takes_the_nearest_result(monkeypatch):
    """match_parts(nearest=True), as the material check does: a part not found takes the closest item."""
    from partlist_studio.core import stock as stock_mod

    monkeypatch.setattr(stock_mod, "XREF_LOOKUP", None)
    monkeypatch.setattr(stock_mod, "XREF_ENTRIES", None)
    pl = _drawing(("RRS-T-045", "กระดูกหมาชิ้นที่1", 2), ("RRS-T-042", "เต้า4", 1))
    assert all(not m.items for _p, m in pm.match_parts(pl, _stock()))  # not by default (job tickets)
    m = {p.part_no: x for p, x in pm.match_parts(pl, _stock(), nearest=True)}
    dog = m["RRS-T-045"]
    assert dog.method == pm.M_NEAREST and dog.sure and dog.close
    assert [i.code for i, _s in dog.items] == ["RRS-T-009-L", "RRS-T-009-R-"]  # the drawing's brand, both sides
    assert dog.note.startswith("ไม่พบรหัสตรง – ใช้รายการใกล้เคียงที่สุด: กระดูกข้าง T(ซ้าย) (ชื่อคล้าย")
    assert not m["RRS-T-042"].items  # only other numbers near it: still not found
    lines = check_requirements(pl, _stock(), matches=[(p, m[p.part_no]) for p in pl.parts])
    assert next(x for x in lines if x.code == "RRS-T-009-L").method == pm.M_NEAREST


def test_code_cross_reference_table(monkeypatch):
    """ตารางเทียบรหัส: a stock-count code is read by its Express code, and a close row is used when not found."""
    from partlist_studio.core import stock as stock_mod
    from partlist_studio.core.xref import CodeXref, XrefEntry

    xref = CodeXref([XrefEntry("RRS-A-042-NO4-PR", "01-0007-0042", "เต้าพื้นเรียบเบอร์ 4", "ชื่อตรงกัน"),
                     XrefEntry("RRS-A-201", "01-0009-0001", "ขามอเตอร์", "ชื่อคล้าย 91%")])
    monkeypatch.setattr(stock_mod, "XREF_LOOKUP", xref.lookup)
    monkeypatch.setattr(stock_mod, "XREF_ENTRIES", lambda: xref.entries)
    stock = _stock()
    stock.items += [StockItem(code="01-0007-0042", name="เต้า เบอร์ 4 (นับ)", on_hand=6),
                    StockItem(code="01-0009-0001", name="ขาจับมอเตอร์ไฟฟ้า", on_hand=3)]
    pl = _drawing(("RRS-T-042", "เต้า4", 1), ("RRS-T-053", "ขามอเตอร์1", 1))
    m = {p.part_no: x for p, x in pm.match_parts(pl, stock, nearest=True)}
    four = m["RRS-T-042"]  # the count code 01-0007-0042 is RRS-A-042-NO4-PR: same part number 042
    assert (four.method, four.item.code) == (pm.M_PART_NO, "01-0007-0042")
    assert four.note.endswith("01-0007-0042 = RRS-A-042-NO4-PR ตามตารางเทียบรหัส")
    motor = m["RRS-T-053"]  # nothing by code or name in the stock: the close row of the table
    assert (motor.method, motor.item.code) == (pm.M_XREF_CLOSE, "01-0009-0001")
    assert motor.note == "ตารางเทียบรหัส: RRS-A-201 ↔ 01-0009-0001 (ชื่อคล้าย 91%)"
