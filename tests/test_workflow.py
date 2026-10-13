"""Work-flow functions: code rules, variants, stock documents, production jobs, nesting, Min/Max, Rev. compare."""

from datetime import date, timedelta

import pytest
from conftest import SAMPLES

from partlist_studio.core import code_rules, nesting, production, replenish, revision
from partlist_studio.core.company_files import ModelBOM, ModelRow, split_codes
from partlist_studio.core.express import read_express_file
from partlist_studio.core.express_codes import resolve_variant, resolved_to_parts, row_options, summary
from partlist_studio.core.models import Part, PartList
from partlist_studio.core.movements import DocLine, Ledger, StockDoc, export_doc, lines_from_parts
from partlist_studio.core.stock import StockItem, StockList


@pytest.fixture
def express():
    stock, _ = read_express_file(SAMPLES / "express_item_detail_STMASR0200.txt")
    return stock


def _row(no, code, name, qty_text="1"):
    qty = sum(float(x) for x in qty_text.split("+"))
    return ModelRow(item_no=no, raw_code=code, codes=split_codes(code), name=name, qty_text=qty_text, qty=qty)


# --------------------------------------------------------------------------
def test_canonical_and_parse():
    assert code_rules.canonical("RRS-T-024-80-L") == "RRS-T-024-L-80"
    assert code_rules.canonical("RRA-A-074-230-DOWN") == "RRS-A-074-230-DOWN"
    assert code_rules.canonical("RRS-T018") == "RRS-T-018"
    assert code_rules.canonical("RRS-A_102") == "RRS-A-102"
    p = code_rules.parse_code("RRS-T-024-L-84-CHAMP")
    assert (p.brand, p.number, p.side, p.sizes, p.variants) == ("T", "024", "L", ["84"], ["CHAMP"])


def test_audit_codes(express):
    stock = StockList(items=list(express.items) + [
        StockItem(code="RRA-A-074-230-DOWN", name="เหล็กซับคัดซี (230 ลงมา)"),
        StockItem(code="RRS-A-093-r-2", name="กระดูกกลางพื้นเรียบเบอร์ 2"),
        StockItem(code="RRS-A-024-80", name="บังอาย T80(ขวา)"),
        StockItem(code="RRS-T-102-R-84-CHAMP", name="เสาหน้า(ขวา) 84 T-CHAMP"),
        StockItem(code="RRS-T-102-L-84-CHAMP", name="เสาหลัง(ซ้าย) 84 T-CHAMP"),
        StockItem(code="RRS-T-103-L-84-CHAMP", name="เสาหลัง(ซ้าย) 84 T-CHAMP"),
    ])
    issues = code_rules.audit_codes(stock)
    by = {}
    for i in issues:
        by.setdefault(i.code, []).append(i.problem)
    assert any("RRA" in x for x in by["RRA-A-074-230-DOWN"])
    assert any("ตัวพิมพ์เล็ก" in x for x in by["RRS-A-093-r-2"])
    assert any("ไม่มี -R" in x for x in by["RRS-A-024-80"])
    assert any("ส่วนใหญ่เป็น เสาหลัง" in x for x in by["RRS-T-102-R-84-CHAMP"])
    assert any("ชื่อซ้ำ" in x for x in by["RRS-T-103-L-84-CHAMP"])
    assert any("คู่ข้างขวาเขียนต่างกัน" in x for x in by["RRS-T-024-L-84"])  # R side has -CHAMP, L does not
    assert issues[0].level == code_rules.LEVEL_ERROR


def test_new_code(express):
    made = code_rules.new_code(express, "บังอาย T90(ซ้าย)", brand="T")
    assert made.code == "RRS-T-024-L-90" and not made.exists
    assert "เลขเดิม" in made.number_source
    again = code_rules.new_code(express, "บังอาย Champ 84(ซ้าย)", brand="T", variants=[])
    assert again.code == "RRS-T-024-L-84-CHAMP"
    fresh = code_rules.new_code(express, "ราวบนหน้า", brand="A")
    assert fresh.code == "RRS-A-103" and "ถัดไป" in fresh.number_source  # 102 is the highest in the sample
    same_name = code_rules.new_code(express, "บังอาย 40", brand="A")
    assert same_name.code == "RRS-A-024-40" and "มีชื่อนี้แล้วที่รหัส RRS-A-024" in same_name.warnings
    taken = code_rules.new_code(express, "บังอาย Champ 84(ขวา)", brand="T")
    assert taken.code == "RRS-T-024-R-84-CHAMP" and taken.exists


# --------------------------------------------------------------------------
def test_variant_changes_codes(express):
    model = ModelBOM("กระบะคอกสูง3ราว", "รายการชิ้นส่วนประกอบกระบะ Toyota (คอกสูง 3 ราว)",
                     [_row("1", "RRS-T-023", "เสาหลัง 80", "1+1"), _row("2", "RRS-T-024", "บังอาย", "1+1")])
    as_sheet = resolve_variant(model, express)
    assert [r.code for r in as_sheet[:2]] == ["RRS-A-102-L-80", "RRS-A-102-R-80"]
    low = resolve_variant(model, express, height="40 (คอกเตี้ย)")
    assert [r.code for r in low[:2]] == ["RRS-A-102-L-40", "RRS-A-102-R-40"]
    champ = resolve_variant(model, express, brand="Toyota Champ", height="84 (คอกสูง 4 ราว)")
    assert [r.code for r in champ if r.name == "บังอาย"] == ["RRS-T-024-L-84", "RRS-T-024-R-84-CHAMP"]
    assert sum(summary({"x": champ}).values()) == 4
    opts = [c for c, _n in row_options(champ[2], express)]
    assert opts[0] == "RRS-T-024-L-84" and "RRS-T-024-L-40-CHAMP" in opts
    parts = resolved_to_parts(model, champ, 1, express)
    assert parts[2].part_no == "RRS-T-024-L-84" and parts[2].name == "บังอาย Champ 84(ซ้าย)" and parts[2].qty == 1


# --------------------------------------------------------------------------
def test_ledger_post_cancel_history(tmp_path):
    stock = StockList(items=[StockItem(code="01-B00 -0003", name="เหล็กแผ่น 2.5", unit="แผ่น", on_hand=10, unit_cost=1500)])
    ledger = Ledger()
    doc = ledger.new_doc("PD", [DocLine("01-B00 -0003", "เหล็กแผ่น 2.5", 4, "แผ่น", unit_cost=1500)],
                         date="2026-10-13", job="SO1")
    assert doc.doc_no == "PD6910-0001" and ledger.next_no("PD", "2026-10-20") == "PD6910-0002"
    assert ledger.post(doc, stock) == []
    assert stock.items[0].on_hand == 6 and doc.total == 6000
    rr = ledger.new_doc("FR", [DocLine("RRS-A-033", "ตะขอ", 5, "ชิ้น")], date="2026-10-14")
    added = StockList()
    warnings = ledger.post(rr, stock, added)
    assert added.items[0].code == "RRS-A-033" and added.items[0].on_hand == 5 and warnings
    assert ledger.daily_out() == {"01-B00 -0003": {"2026-10-13": 4}}
    ledger.cancel(doc, stock)
    assert stock.items[0].on_hand == 10 and ledger.daily_out() == {}
    assert [m.qty for m in ledger.history("01-B00 -0003")] == [-4, 4]
    back = Ledger.from_dict(ledger.to_dict())
    assert back.docs[0].status == "ยกเลิก" and len(back.movements) == 3 and back.counters == ledger.counters
    out = tmp_path / "pd.xlsx"
    export_doc(back.docs[0], out)
    assert out.is_file()


def test_issue_of_unknown_code_is_not_added():
    ledger, stock, added = Ledger(), StockList(), StockList()
    doc = ledger.new_doc("PD", [DocLine("RRS-X-999", "ไม่มีในสต็อก", 2)])
    warnings = ledger.post(doc, stock, added)
    assert not added.items and "ไม่ได้ตัดยอด" in warnings[0]


# --------------------------------------------------------------------------
def test_job_steps_and_documents():
    stock = StockList(items=[StockItem(code="RRS-A-019", name="ฝาข้าง", unit="ชิ้น", on_hand=1),
                             StockItem(code="01-B00 -0003", name="เหล็กแผ่นดำ 2.5 มม.4x8ฟุต(ฝาข้าง+ฝาท้าย)1219x2440",
                                       unit="แผ่น", on_hand=20)])
    parts = [Part(item_no="1", part_no="RRS-A-019", name="ฝาข้าง", qty=2),
             Part(item_no="2", part_no="RRS-A-066", name="บานพับ", qty=3, process="ซื้อสำเร็จ")]
    job = production.job_from_parts("SO6910-1", parts, 2, stock, model="แบบ A")
    side, hinge = job.parts
    assert (side.required, side.from_stock, side.to_make) == (4, 1, 3)
    assert side.route == ["ตัด", "พับ", "เชื่อม"] and side.status == "รอตัด"
    assert job.record(side, "พับ", 2) == 0  # nothing cut yet
    job.record(side, "ตัด", 3)
    job.record(side, "พับ", 2)
    assert side.waiting() == {"พับ": 1, "เชื่อม": 2} and side.status_text == "รอพับ 1 · รอเชื่อม 2"
    job.record(side, production.DONE, 0)
    assert side.status == production.DONE and job.unreceived() == [(side, 3)]
    assert hinge.route == [] and hinge.status == "รอรับเข้า"
    # a second job cannot take the stock the first one reserved
    other = production.job_from_parts("SO6910-2", parts[:1], 1, stock, other_jobs=[job])
    assert other.parts[0].from_stock == 0
    uses = production.suggest_raw_uses(job.parts, stock)
    assert [(u.part_code, u.raw_code) for u in uses] == [("RRS-A-019", "01-B00 -0003")]
    uses[0].qty = 0.5
    ledger = Ledger()
    docs = production.job_documents(job, stock, ledger, uses)
    assert [(d.doc_type, d.remark.split(" ")[0]) for d in docs] == [("PD", "วัตถุดิบ"), ("PD", "จ่ายชิ้นส่วนประกอบกระบะ"),
                                                                   ("FR", "ชิ้นงานผลิตเสร็จ")]
    assert docs[0].lines[0].qty == 2  # 0.5 sheet x 3 to make, rounded up
    for d in docs:
        d.doc_no = ledger.next_no(d.doc_type)
        ledger.docs.append(d)
        ledger.post(d, stock, StockList())
        production.mark_document(job, d)
    assert side.received == 3 and side.issued == 4 and not job.unreceived()
    back = production.Job.from_dict(job.to_dict())
    assert back.parts[0].done == side.done and back.log[-1].step == production.DONE


@pytest.mark.parametrize("remark, parsed", [
    ("รอพับ5ชิ้น", ("พับ", 5.0, "")), ("รอตัดฝาหน้า 20ชิ้น", ("ตัด", 20.0, "ฝาหน้า")),
    ("รอเหยียบปิด", ("เหยียบปิด", None, "")), ("โรงกลึง", ("กลึง", None, "ส่งโรงกลึง")),
    ("พร้อมใช้งาน", ("เสร็จ", None, "")), ("", None)])
def test_wip_remarks(remark, parsed):
    assert production.parse_wip_remark(remark) == parsed


# --------------------------------------------------------------------------
def test_pack_and_plan(tmp_path):
    params = nesting.NestParams(gap=10, margin=10)
    four = [nesting.NestPart("a", "P1", "แผ่น", "SS400", 2.5, 500, 1000, 4)]
    sheets, big = nesting.pack(four, 1219, 2440, params)
    assert len(sheets) == 1 and len(sheets[0].placements) == 4 and not big
    for pl in sheets[0].placements:
        assert pl.x >= 10 and pl.y >= 10 and pl.x + pl.w <= 1209 and pl.y + pl.h <= 2430
    stock = StockList(items=[StockItem(code="01-B00 -0003", name="เหล็กแผ่นดำ 2.5 มม.4x8ฟุต 1219x2440", unit="แผ่น",
                                       spec="t2.5", material="เหล็กแผ่นดำ"),
                             StockItem(code="01-B00 -0011", name="เหล็กแผ่นดำ 2.5มม. 5x10ฟุต 1524x3050", unit="แผ่น",
                                       spec="t2.5", material="เหล็กแผ่นดำ")])
    parts = four + [nesting.NestPart("b", "P2", "ฝายาว", "SS400", 2.5, 1400, 2900, 1)]
    groups = nesting.plan(parts, stock, params)
    g = groups[0]
    assert {s.size: 0 for s in g.sheets} and sorted(s.code for s in g.sheets) == ["01-B00 -0003", "01-B00 -0011"]
    assert 0 < g.utilization < 1 and abs(g.scrap_pct - 100 * (1 - g.utilization)) < 1e-9
    assert nesting.plan_rows(groups)[0][5] == 1
    nesting.export_plan(groups, tmp_path / "plan.xlsx", params)
    nesting.export_dxf(groups, tmp_path / "plan.dxf")
    assert (tmp_path / "plan.dxf").stat().st_size > 1000


def test_nest_parts_from_drawing():
    from partlist_studio.core import dwg_io

    data = dwg_io.read_drawing(SAMPLES / "RRS-TB-001_side_panel.dxf")
    pl = PartList(parts=[c.part for c in dwg_io.drawing_to_candidates(data)])
    pl.info.build_qty = 5
    assert pl.parts[0].outline and len(pl.parts[0].outline) == 1 + len(data.profiles[0].holes or [])
    parts, skipped = nesting.nest_parts_from(pl)
    assert parts[0].thickness == 3.2 and parts[0].qty == 10 and not skipped
    assert nesting.spec_thickness("2501 x 996") == 0 and nesting.spec_thickness("3 x 100 x 200") == 3
    back = Part.from_dict(pl.parts[0].__dict__)
    assert back.outline == pl.parts[0].outline


# --------------------------------------------------------------------------
def test_min_max_from_usage_and_default():
    today = date(2026, 10, 13)
    stock = StockList(items=[StockItem(code="01-B00 -0003", name="เหล็กแผ่น", unit="แผ่น", on_hand=3),
                             StockItem(code="RRS-A-033", name="ตะขอ", unit="ชิ้น", on_hand=20),
                             StockItem(code="X-1", name="ไม่เคยใช้", unit="ชิ้น", on_hand=1)])
    usage = {"01-B00 -0003": {(today - timedelta(days=i)).isoformat(): 2 for i in range(30)}}  # 2 per day, steady
    models = [ModelBOM("แบบ", "", [_row("1", "RRS-A-033", "ตะขอ", "6")])]
    p = replenish.ReplenishParams(lead_days=7, review_days=14, history_days=90, default_beds=2, batch_beds=3)
    lines = {x.code: x for x in replenish.compute(stock, p, usage, models=models, today=today)}
    sheet = lines["01-B00 -0003"]
    avg = 60 / 90
    assert sheet.source == replenish.SRC_HISTORY and abs(sheet.avg_day - avg) < 1e-9
    assert sheet.min_new >= round(avg * 7) and sheet.max_new > sheet.min_new
    assert sheet.status == replenish.RS_ORDER and sheet.order_qty == sheet.max_new - 3
    hook = lines["RRS-A-033"]
    assert (hook.source, hook.min_new, hook.max_new, hook.status) == (replenish.SRC_DEFAULT, 12, 30, replenish.RS_OK)
    assert lines["X-1"].status == replenish.RS_NO_DATA
    assert replenish.apply_min_max(list(lines.values())) == 2 and stock.items[1].min_qty == 12
    steel = StockItem(name="เหล็กแผ่นดำ 2 มม.", unit="แผ่น", on_hand=10,
                      extra={"issues": {"2025-07-01": 1}, "issue_period": ["2025-07-01", "2025-07-31"]})
    old = replenish.compute(StockList(items=[steel]), p, today=today)[0]
    assert old.source == replenish.SRC_HISTORY and abs(old.avg_day - 1 / 31) < 1e-9


# --------------------------------------------------------------------------
def test_compare_revisions(tmp_path):
    old = revision.partlist_from_file(SAMPLES / "RRS-AS-100_tailgate_assembly.dxf")
    new = PartList.from_dict(old.to_dict())
    new.parts[0].qty += 2
    new.parts[1].material = "SUS304"
    removed = new.parts.pop(2)
    new.parts.append(Part(part_no="RRS-NEW-1", name="ชิ้นใหม่", qty=1))
    changes = revision.compare_parts(old.parts, new.parts)
    kinds = {c.code: c.kind for c in changes}
    assert kinds[new.parts[0].part_no] == revision.CH_QTY
    assert kinds[new.parts[1].part_no] == revision.CH_CHANGED
    assert kinds[removed.part_no] == revision.CH_REMOVED and kinds["RRS-NEW-1"] == revision.CH_ADDED
    assert "วัสดุ: SS400 → SUS304" in next(c.detail for c in changes if c.kind == revision.CH_CHANGED)
    revision.export_compare(changes, tmp_path / "cmp.xlsx", "A", "B")
    assert (tmp_path / "cmp.xlsx").is_file()
    # parts without a code keep their pairing when the import renumbers them
    a = [Part(name="ชิ้นที่ 1", spec="t2 x 10 x 20", outline=[[(0, 0), (10, 0), (10, 20)]]),
         Part(name="ชิ้นที่ 2", spec="t2 x 30 x 40", outline=[[(0, 0), (30, 0), (30, 40)]])]
    b = [Part(name="ชิ้นที่ 1", spec="t2 x 30 x 40", outline=[[(0, 0), (30, 0), (30, 40)]])]
    ch = revision.compare_parts(a, b)
    assert revision.summary(ch) == {revision.CH_REMOVED: 1, revision.CH_SAME: 1}


def test_lines_from_parts_merges_codes():
    stock = StockList(items=[StockItem(code="RRS-A-033", name="ตะขอเกี่ยวฝาท้าย", unit="ชิ้น", unit_cost=30)])
    lines = lines_from_parts([Part(part_no="RRS-A-033", qty=2), Part(part_no="RRS-A-033", qty=4),
                              Part(name="ไม่มีรหัส", qty=1)], stock, sets=2)
    assert [(ln.code, ln.name, ln.qty, ln.unit_cost) for ln in lines] == [
        ("RRS-A-033", "ตะขอเกี่ยวฝาท้าย", 12, 30), ("", "ไม่มีรหัส", 2, 0)]
    assert StockDoc("OU").sign == -1 and StockDoc("FR").sign == 1
