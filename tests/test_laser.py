"""Laser cutting: flat pattern library, what to cut from the jobs, checks, programs, laser files, recording a cut."""

import math

import pytest

from conftest import SAMPLES
from partlist_studio.core import cad_fix, dwg_io, laser, nesting, production
from partlist_studio.core.models import Part, PartList
from partlist_studio.core.movements import Ledger

SET = SAMPLES / "RRS-T-SET_frame_parts.dxf"


@pytest.fixture(scope="module")
def set_parts():
    data = dwg_io.read_drawing(SET)
    return [c.part for c in dwg_io.drawing_to_candidates(data)]


def _job(parts, beds=3, job_no="SO6910-015"):
    return production.job_from_parts(job_no, parts, beds, None, False)


def test_flat_library_keeps_coded_parts_and_round_trips(set_parts):
    lib = laser.FlatLibrary()
    extra = Part(name="ไม่มีรหัส", outline=[[(0, 0), (10, 0), (10, 10), (0, 10)]])
    assert lib.add_parts(set_parts + [extra], drawing_no="RRS-T-SET", revision="A") == 5  # parts without a code
    flat = lib.get("rrs t 001")  # same normalisation as the stock codes
    assert flat.thickness == 3 and flat.size == pytest.approx((150, 60)) and flat.holes == 2
    assert flat.cut_length == pytest.approx(2 * (150 + 60) + 2 * (2 * math.pi * 5), rel=0.01)  # 2 holes Ø10
    back = laser.FlatLibrary.from_dict(lib.to_dict())
    assert back.get("RRS-T-003").outline == lib.get("RRS-T-003").outline
    assert lib.get("X-1", xref_lookup=lambda c: ["RRS-T-002"]).code == "RRS-T-002"  # via the code table


def test_demand_from_jobs_counts_what_is_left(set_parts):
    lib = laser.FlatLibrary()
    lib.add_parts(set_parts[:4])  # RRS-T-005 has no flat pattern
    job = _job(set_parts)
    job.parts[0].done["ตัด"] = 8  # 8 of 48 already cut
    d = laser.demand_from_jobs([job], lib)
    got = {p.code: p.qty for p in d.parts}
    assert got == {"RRS-T-001": 40, "RRS-T-002": 6, "RRS-T-003": 12, "RRS-T-004": 3}
    assert [(m[1], m[3]) for m in d.missing] == [("RRS-T-005", 3)]
    assert all(p.job == "SO6910-015" for p in d.parts)
    # planned in a program: not offered again
    queue = laser.CutQueue()
    groups = nesting.plan(d.parts, None, laser.LaserParams().nest_params())
    laser.make_programs(groups, queue, laser.LaserParams())
    assert laser.demand_from_jobs([job], lib, queue.programs).parts == []


def test_checks_before_cutting():
    params = laser.LaserParams()
    square = [(0, 0), (200, 0), (200, 100), (0, 100)]
    tiny_hole = [(50 + 1.5 * math.cos(a), 50 + 1.5 * math.sin(a)) for a in [i * math.tau / 24 for i in range(24)]]
    near_edge = [(192 + 4 * math.cos(a), 50 + 4 * math.sin(a)) for a in [i * math.tau / 24 for i in range(24)]]
    part = nesting.NestPart("k", "RRS-X-001", "แผ่นทดสอบ", "SS400", 6, 200, 100, 1,
                            outline=[square, tiny_hole, near_edge, list(tiny_hole)])
    texts = [i.text for i in laser.check_part(part, params)]
    assert any("เล็กกว่าความหนา" in t for t in texts)  # Ø3 hole in 6 mm plate
    assert any("ห่างขอบ" in t for t in texts)  # 4 mm web < 6 mm thickness
    assert any("ซ้อนกัน" in t for t in texts)  # the Ø3 hole drawn twice
    small = nesting.NestPart("s", "RRS-X-002", "แหวน", "SS400", 3, 20, 20, 1, outline=[square])
    assert any("ชิ้นเล็ก" in i.text for i in laser.check_part(small, params))
    ok = nesting.NestPart("o", "RRS-X-003", "ดี", "SS400", 3, 200, 100, 1, outline=[square])
    assert laser.check_part(ok, params) == []


def test_cut_time_and_params_round_trip():
    params = laser.LaserParams()  # HSG 12,000W, the company's machine
    assert params.machine == "HSG 12,000W" and (params.bed_w, params.bed_l) == (2500, 8000)
    assert params.speed("STEEL", 3) == 26000 and params.speed("STEEL", 3.5) == pytest.approx(23000)
    minutes = laser.cut_minutes(26000, 10, "STEEL", 3, params)  # 1 min cutting + 10 × 0.2 s
    assert minutes == pytest.approx((1 + 10 * 0.2 / 60) * 1.15)
    params.speeds["STEEL"][3] = 3000
    params.mark_codes = True
    back = laser.LaserParams.from_dict(params.to_dict())
    assert back.speed("STEEL", 3) == 3000 and back.mark_codes is True and back.gap == params.gap


def test_programs_merge_identical_sheets():
    square = [[(0, 0), (500, 0), (500, 400), (0, 400)]]
    part = nesting.NestPart("pl:0", "RRS-X-010", "แผ่น", "SS400", 3, 500, 400, 70, outline=square)
    groups = nesting.plan([part], None, laser.LaserParams().nest_params())
    sheets = len(groups[0].sheets)
    queue = laser.CutQueue()
    progs = laser.make_programs(groups, queue, laser.LaserParams())
    assert sum(p.repeat for p in progs) == sheets and len(progs) < sheets  # full sheets are one program × N
    assert progs[0].no.startswith("LC") and progs[0].no.endswith("-0001")
    assert sum(p.pieces * p.repeat for p in progs) == 70
    back = laser.CutQueue.from_dict(queue.to_dict())
    assert [p.no for p in back.programs] == [p.no for p in progs] and back.next_no() != progs[-1].no


def test_laser_files_and_recording_a_cut(set_parts, tmp_path):
    import ezdxf

    lib = laser.FlatLibrary()
    lib.add_parts(set_parts)
    job = _job(set_parts)
    params = laser.LaserParams(mark_codes=True)
    d = laser.demand_from_jobs([job], lib)
    groups = nesting.plan(d.parts, None, params.nest_params())
    queue = laser.CutQueue()
    progs = laser.make_programs(groups, queue, params, d.source)
    out = laser.export_package(progs, tmp_path / "pkg", params, d.parts, laser.check_parts(d.parts, params, groups))
    assert out["programs"] == len(progs) and out["parts"] == len(d.parts)
    assert (tmp_path / "pkg" / "ใบสั่งตัดเลเซอร์.xlsx").is_file()
    t3 = next(p for p in progs if p.thickness == 3)
    doc = ezdxf.readfile(t3.files[0])
    kinds = {(e.dxftype(), e.dxf.layer) for e in doc.modelspace()}
    assert ("CIRCLE", "CUT_INNER") in kinds and ("LWPOLYLINE", "CUT_OUTER") in kinds and ("TEXT", "MARK") in kinds
    assert doc.header["$INSUNITS"] == 4
    back = dwg_io.read_drawing(t3.files[0])  # the importer reads our own file: 48 parts with 2 holes each
    assert len(back.outer_profiles) == t3.pieces == 48
    assert all(len(p.holes) == 2 for p in back.outer_profiles)
    for part_file in (tmp_path / "pkg" / "parts").rglob("*.dxf"):
        assert part_file.name.isascii()  # laser software that cannot open Thai file names

    ledger = Ledger()
    n, pd = laser.apply_cut(t3, 1, [job], ledger, operator="ช่าง A", remnant="1219x1500")
    assert n == 48 and t3.status == laser.ST_DONE and pd.doc_type == "PD" and pd.lines[0].qty == 1
    t001 = next(p for p in job.parts if p.code == "RRS-T-001")
    assert t001.done_at("ตัด") == 48 and t001.status_text == "รอพับ 48"
    assert laser.apply_cut(t3, 1, [job], ledger) == (0, None)  # nothing left on this program


def test_program_r12_and_partlist_source(tmp_path):
    pl = PartList(parts=[Part(part_no="RRS-X-020", name="แผ่น", material="SS400", thickness=2, qty=2,
                              outline=[[(0, 0), (300, 0), (300, 200), (0, 200)]])])
    d = laser.demand_from_partlist(pl, 3)
    assert [(p.key, p.qty) for p in d.parts] == [("pl:0", 6)] and "× 3 คัน" in d.source
    params = laser.LaserParams(dxf_version="R12")
    groups = nesting.plan(d.parts, None, params.nest_params())
    progs = laser.make_programs(groups, laser.CutQueue(), params)
    path = laser.export_program_dxf(progs[0], tmp_path / "p.dxf", params)
    assert dwg_io.read_drawing(path).outer_profiles
    n, _pd = laser.apply_cut(progs[0], 1, [], None)
    assert n == 0 and progs[0].status == laser.ST_DONE  # Part List pieces: no job to record on


def test_open_cut_lines_are_counted(tmp_path):
    import ezdxf

    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    for a, b in [((0, 0), (100, 0)), ((100, 0), (100, 50)), ((100, 50), (0, 50)), ((0, 50), (0, 0))]:
        msp.add_line(a, b)
    for a, b in [((200, 0), (300, 0)), ((300, 0), (300, 50)), ((300, 50), (200, 50)), ((200, 50), (200, 2))]:
        msp.add_line(a, b)  # 2 mm gap at the corner
    path = tmp_path / "gap.dxf"
    doc.saveas(path)
    data = dwg_io.read_drawing(path)  # 2 mm: more than the repair joins by itself
    assert len(data.outer_profiles) == 1 and data.open_chains == 1 and data.open_examples[0] in [(200, 0), (200, 2)]
    [unfixed] = [f for f in data.fixes if not f.fixed]
    assert unfixed.kind == cad_fix.FIX_OPEN and "ปลายห่าง 2.0 มม." in unfixed.text
    data = dwg_io.read_drawing(path, repair=False)  # as drawn
    assert data.open_chains == 1 and data.open_examples == [(200.0, 0.0)] and not data.fixes
    data = dwg_io.read_drawing(path, gap_tol=3)  # joined
    assert len(data.outer_profiles) == 2 and data.open_chains == 0
    assert [(f.kind, round(f.size, 2)) for f in data.fixes] == [(cad_fix.FIX_GAP, 2.0)]


def test_machine_presets_bed_and_old_settings():
    params = laser.LaserParams()
    params.use_machine("Fiber 3,000W (ทั่วไป)")
    assert params.speed("STEEL", 3) == 4500 and params.bed_l == 3000
    # settings saved by the first version (3 kW table, never tuned) move to the company's machine
    old = laser.LaserParams.from_dict({k: v for k, v in params.to_dict().items() if k not in ("machine", "bed_w", "bed_l")})
    assert old.machine == "HSG 12,000W" and old.speed("STEEL", 3) == 26000
    tuned = params.to_dict()
    tuned.pop("machine")
    tuned["speeds"]["STEEL"]["3"] = 5000  # tuned by hand: kept
    assert laser.LaserParams.from_dict(tuned).speed("STEEL", 3) == 5000
    params = laser.LaserParams()
    square = [(0, 0), (9000, 0), (9000, 100), (0, 100)]
    long_part = nesting.NestPart("k", "RRS-X-030", "รางยาว", "SS400", 3, 9000, 100, 1, outline=[square])
    assert any("ใหญ่กว่าโต๊ะ" in i.text and i.level == laser.ERROR for i in laser.check_part(long_part, params))
    assert params.fits_bed(1524, 6096) and not params.fits_bed(3000, 3000)


def test_machine_values_layer_colours_and_test_file(tmp_path):
    import ezdxf

    params = laser.LaserParams()
    assert params.speed("STEEL", 2) == 38000 and params.pierce_seconds(2) == pytest.approx(0.04)  # HSG technic
    old = params.to_dict()  # saved with the first HSG estimates: moves to the machine's values
    old["speeds"]["STEEL"]["2"] = 35000
    old["pierce"] = {"1": 0.1, "3": 0.2, "5": 0.3, "8": 0.6, "12": 1.0, "16": 1.5, "20": 2.5, "25": 3.5, "30": 5.0}
    assert laser.LaserParams.from_dict(old).speed("STEEL", 2) == 38000
    params.color_outer, params.color_inner = 2, 4
    back = laser.LaserParams.from_dict(params.to_dict())
    assert (back.color_outer, back.color_inner, back.color_mark) == (2, 4, 3)
    path = laser.export_layer_test(tmp_path / "LAYER_TEST.dxf", back)
    doc = ezdxf.readfile(path)
    assert doc.layers.get("CUT_OUTER").color == 2 and doc.layers.get("COLOR_6").color == 6
    squares = [e for e in doc.modelspace() if e.dxftype() == "LWPOLYLINE"]
    assert len(squares) == 10 and all(e.closed for e in squares)


def test_marks_gaps_spacing_and_orientation(tmp_path):
    import math

    import ezdxf

    square = [(0.0, 0.0), (100.0, 0.0), (100.0, 50.0), (0.0, 50.0)]
    # Gap / micro-joint: the outer contour in open pieces, `width` mm left uncut at each joint
    pieces = laser.micro_joints(square, 2, 1.0)
    assert len(pieces) == 2 and sum(laser.loop_length(p) - math.dist(p[0], p[-1]) for p in pieces) == pytest.approx(298)
    assert {round(p[0][1]) for p in pieces} == {0, 50}  # in the middle of the two long edges
    assert laser.micro_joints(square, 0, 1.0) == [square + square[:1]]
    params = laser.LaserParams()
    part = nesting.NestPart("k", "RRS-X-1", "ฉาก", "SS400", 3, 100, 50, 4, outline=[square],
                            bend_lines=[[(30.0, 0.0), (30.0, 50.0)]], fixes=["ต่อเส้นที่ต่อไม่สนิท 1 จุด (ห่างสุด 0.30 มม.)"])
    assert params.joints_for(part) == 0  # off by default
    params.joints, params.mark_bends = "small", "ticks"
    assert params.joints_for(part) == 2 and params.joints_for(nesting.NestPart(
        "b", "B", "ใหญ่", "SS400", 3, 1000, 500, 1, outline=[[(0, 0), (1000, 0), (1000, 500), (0, 500)]])) == 0
    issues = laser.check_part(part, params)
    assert any(i.level == laser.INFO and i.text.startswith("แก้แบบอัตโนมัติ: ต่อเส้น") for i in issues)
    path = laser.export_part_dxf(part, tmp_path / "p.dxf", params)
    ents = list(ezdxf.readfile(path).modelspace())
    cut = [e for e in ents if e.dxf.layer == params.layer_outer]
    marks = [e for e in ents if e.dxf.layer == params.layer_mark]
    assert len(cut) == 2 and not any(e.closed for e in cut)
    assert sorted((round(e.dxf.start.y), round(e.dxf.end.y)) for e in marks) == [(0, 10), (50, 40)]  # ticks
    params.mark_bends = "full"
    path = laser.export_part_dxf(part, tmp_path / "p2.dxf", params)
    assert [round(e.dxf.end.y - e.dxf.start.y) for e in ezdxf.readfile(path).modelspace()
            if e.dxf.layer == params.layer_mark] == [50]
    # spacing by thickness: 12 mm plate gets 12 mm between parts, 3 mm plate keeps the 5 mm gap
    nest = params.nest_params()
    assert nest.gap_for(3) == 5 and nest.gap_for(12) == 12
    groups = nesting.plan([part, nesting.NestPart("t", "T", "หนา", "SS400", 12, 100, 50, 2, outline=[square])],
                          None, nest)
    assert sorted((g.thickness, g.gap) for g in groups) == [(3, 5), (12, 12)]
    # a part drawn at 30°: turned to its smallest blank before nesting (and its bend lines with it)
    c, s = math.cos(math.radians(30)), math.sin(math.radians(30))
    tilted = [(x * c - y * s, x * s + y * c) for x, y in square]
    ox, oy = min(p[0] for p in tilted), min(p[1] for p in tilted)
    tilted = [(x - ox, y - oy) for x, y in tilted]
    bend = [[(30 * c - ox, 30 * s - oy), (30 * c - 50 * s - ox, 30 * s + 50 * c - oy)]]
    w, h = max(p[0] for p in tilted), max(p[1] for p in tilted)
    turned = nesting.best_orientation(nesting.NestPart("r", "R", "เอียง", "SS400", 3, w, h, 1, outline=[tilted],
                                                       bend_lines=bend))
    assert sorted((round(turned.width), round(turned.height))) == [50, 100]
    (a, b), = turned.bend_lines
    assert round(math.dist(a, b)) == 50 and (round(a[0]) == round(b[0]) or round(a[1]) == round(b[1]))
    assert nesting.best_orientation(part) is part  # already square to the sheet


def test_bend_lines_and_fixes_kept_in_library_and_programs():
    data = dwg_io.read_drawing(SAMPLES / "RRS-T-FIX_broken_lines.dxf")
    parts = [c.part for c in dwg_io.drawing_to_candidates(data)]
    lib = laser.FlatLibrary()
    lib.add_parts(parts)
    back = laser.FlatLibrary.from_dict(lib.to_dict()).get("RRS-T-101")
    assert back.bend_lines == [[(150.0, 0.0), (150.0, 150.0)], [(230.0, 0.0), (230.0, 150.0)]] and back.fixes
    job = production.job_from_parts("SO6910-020", parts, 1, None, False)
    demand = laser.demand_from_jobs([job], lib)
    side = next(p for p in demand.parts if p.code == "RRS-T-101")
    assert side.bend_lines == back.bend_lines and side.fixes == back.fixes
    params = laser.LaserParams()
    progs = laser.make_programs(nesting.plan(demand.parts, None, params.nest_params()), laser.CutQueue(), params)
    prog = laser.CutProgram.from_dict(progs[0].to_dict())
    key = next(k for k, it in prog.items.items() if it["code"] == "RRS-T-101")
    assert prog.nest_part(key).bend_lines == back.bend_lines


def test_nest_parts_by_hand_in_free_space():
    square = [(0.0, 0.0), (400.0, 0.0), (400.0, 300.0), (0.0, 300.0)]
    big = nesting.NestPart("j", "RRS-T-019", "ฝาข้าง", "SS400", 3, 400, 300, 2, outline=[square])
    params = laser.LaserParams()
    nest = params.nest_params()
    [group] = nesting.plan([big], None, nest)
    sheet = group.sheets[0]
    before = [(p.x, p.y) for p in sheet.placements]
    assert nesting.free_pct(sheet, nest) > 0.8
    lib = laser.FlatLibrary()
    lib.add_parts([Part(part_no="RRS-A-033", name="ตะขอฝาท้าย", material="SS400", thickness=3,
                        outline=[[(0, 0), (80, 0), (80, 40), (0, 40)]]),
                   Part(part_no="RRS-A-099", name="หนาอื่น", material="SS400", thickness=6,
                        outline=[[(0, 0), (50, 0), (50, 50), (0, 50)]])])
    flats = laser.flats_for(lib, group.family, 3)
    assert [f.code for f in flats] == ["RRS-A-033"]  # same material and thickness only
    hook = laser.extra_part(flats[0])
    assert nesting.add_to_group(group, 0, hook, 5, nest) == 5
    assert [(p.x, p.y) for p in sheet.placements[:2]] == before  # the parts already there do not move
    extra = group.parts[-1]
    assert extra.key.startswith(laser.EXTRA_KEY) and extra.qty == 5 and not extra.job
    boxes = [(p.x, p.y, p.x + p.w, p.y + p.h) for p in sheet.placements]
    for i, a in enumerate(boxes):  # nothing overlaps, everything keeps the gap and the edge margin
        assert a[0] >= nest.margin - 1e-6 and a[1] >= nest.margin - 1e-6
        assert a[2] <= sheet.width - nest.margin + 1e-6 and a[3] <= sheet.height - nest.margin + 1e-6
        for b in boxes[i + 1:]:
            assert a[2] + nest.gap <= b[0] + 1e-6 or b[2] + nest.gap <= a[0] + 1e-6 or \
                a[3] + nest.gap <= b[1] + 1e-6 or b[3] + nest.gap <= a[1] + 1e-6
    # into a program in the queue: every sheet of it, as many as fit
    queue = laser.CutQueue()
    [prog] = laser.make_programs([group], queue, params)
    minutes, use = prog.minutes, prog.utilization
    n = laser.add_to_program(prog, hook, 0, params)
    assert n > 20 and prog.minutes > minutes and prog.utilization > use
    assert sum(1 for p in prog.placements if p["key"] == hook.key) == 5 + n
    assert prog.items[hook.key]["extra"] and "เพิ่มเอง RRS-A-033" in prog.note
    assert laser.add_to_program(prog, hook, 0, params) == 0  # full now
    back = laser.CutProgram.from_dict(prog.to_dict())
    assert len(back.placements) == len(prog.placements)
    thick = laser.extra_part(lib.get("RRS-A-099"))
    with pytest.raises(ValueError):
        laser.add_to_program(prog, thick, 1, params)  # another thickness
    done, _pd = laser.apply_cut(prog, 1, [], None)  # extra pieces belong to no job: nothing recorded on jobs
    assert done == 0
    with pytest.raises(ValueError):
        laser.add_to_program(prog, hook, 1, params)  # not waiting any more


def test_plan_sheet_size_chosen_or_added_by_hand():
    from partlist_studio.core.stock import StockItem, StockList

    square = [(0.0, 0.0), (400.0, 0.0), (400.0, 300.0), (0.0, 300.0)]
    part = nesting.NestPart("j", "RRS-T-019", "ฝาข้าง", "SS400", 3, 400, 300, 30, outline=[square])
    stock = StockList(items=[StockItem(code="01-B00-0003", name="เหล็กแผ่นดำ 3 มม. 4x8 ฟุต", spec="3 มม.",
                                       unit="แผ่น", on_hand=7)])
    custom = [(3000, 1500, 0, "สั่งซื้อ"), (1000, 2000, 6, "เฉพาะ 6 มม.")]
    [auto] = nesting.plan([part], stock, None, None, custom)
    # stock plate + size added for every thickness (turned to width x length); the 6 mm size is not offered
    assert [(w, h, code) for w, h, code, _ in auto.options] == [(1219.2, 2438.4, "01-B00-0003"), (1500, 3000, "")]
    assert auto.options[1][3] == "เพิ่มเอง: สั่งซื้อ" and not auto.chosen and auto.sheet_code == "01-B00-0003"
    [picked] = nesting.plan([part], stock, None, None, custom, {auto.key: (3000, 1500)})
    assert picked.chosen and (picked.sheet_w, picked.sheet_h) == (1500, 3000) and picked.sheet_name.startswith("เพิ่มเอง")
    assert {s.size for s in picked.sheets} == {"1500x3000"} and len(picked.tried) == 1
    [typed] = nesting.plan([part], stock, None, None, None, {auto.key: (1250, 2500)})  # a size not in the list
    assert typed.chosen and (typed.sheet_w, typed.sheet_h) == (1250, 2500)
    assert any(nesting.same_size(o, (2500, 1250)) for o in typed.options)
    [back] = nesting.plan([part], stock, None, None, custom, {})  # back to automatic
    assert not back.chosen and back.sheet_code == "01-B00-0003"
    params = laser.LaserParams()
    progs = laser.make_programs([picked], laser.CutQueue(), params)
    assert {p.sheet_size for p in progs} == {"1500x3000"} and not any(p.sheet_code for p in progs)
    prog = progs[0]
    ledger = Ledger()
    _, doc = laser.apply_cut(prog, 1, [], ledger, "ช่าง")
    line = doc.lines[0]
    assert line.name == "แผ่นSS400 3มม. 1500x3000 (เพิ่มเอง: สั่งซื้อ)" and "เลือกรหัสแผ่น" in doc.remark


def test_plan_sheet_picked_for_parts_too_big_for_the_main_sheet():
    """The parts too big for the main sheet go on the smallest size they fit - or on the sheet picked for them,
    out of the sizes they fit on."""
    from partlist_studio.core.stock import StockItem, StockList

    def plate(w, h, n):
        return [[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]], w, h, n

    small_outline, *_ = plate(400, 300, 0)
    big_outline, *_ = plate(1300, 2000, 0)
    small = nesting.NestPart("s", "RRS-T-019", "ฝาข้าง", "SS400", 3, 400, 300, 12, outline=small_outline)
    big = nesting.NestPart("b", "RRS-T-020", "พื้นกระบะ", "SS400", 3, 1300, 2000, 1, outline=big_outline)
    stock = StockList(items=[
        StockItem(code="01-B00-0003", name="เหล็กแผ่นดำ 3 มม. 4x8 ฟุต", spec="3 มม.", unit="แผ่น", on_hand=7),
        StockItem(code="01-B00-0005", name="เหล็กแผ่นดำ 3 มม. 5x10 ฟุต", spec="3 มม.", unit="แผ่น", on_hand=2),
        StockItem(code="01-B00-0007", name="เหล็กแผ่นดำ 3 มม. 5x20 ฟุต", spec="3 มม.", unit="แผ่น", on_hand=1)])
    [auto] = nesting.plan([small, big], stock)
    assert auto.sheet_code == "01-B00-0003" and not auto.overflow
    assert [(c, n) for _s, c, _name, n in auto.sheet_counts()] == [("01-B00-0003", 1), ("01-B00-0005", 1)]
    fits = nesting.overflow_options(auto, auto.sheet_counts()[1][0])
    assert [o[2] for o in fits] == ["01-B00-0005", "01-B00-0007"]  # 4x8 is too small for พื้นกระบะ
    main = {auto.key: (auto.sheet_w, auto.sheet_h, auto.sheet_code)}  # the main sheet stays (pinned by the page)
    [picked] = nesting.plan([small, big], stock, None, None, None, main, {auto.key: [(1524, 6096, "01-B00-0007")]})
    assert picked.sheet_code == "01-B00-0003" and [o[2] for o in picked.overflow] == ["01-B00-0007"]
    assert [(c, n) for _s, c, _name, n in picked.sheet_counts()] == [("01-B00-0003", 1), ("01-B00-0007", 1)]
    assert not picked.too_big
    rows = nesting.plan_rows([picked])
    assert [r[3] for r in rows] == ["01-B00-0003", "01-B00-0007"]
    # a picked size the part does not fit on: the smallest size it fits is used after it
    [small_pick] = nesting.plan([small, big], stock, None, None, None, main, {auto.key: [(1219.2, 2438.4)]})
    assert [c for _s, c, _name, _n in small_pick.sheet_counts()] == ["01-B00-0003", "01-B00-0005"]


def test_demand_finds_the_flat_of_a_part_tied_to_a_stock_code(set_parts):
    """After the stock check a Part List row carries its stock code (RRS-A-001-250): the job made from it still
    cuts the flat pattern of its drawing code."""
    lib = laser.FlatLibrary()
    lib.add_parts(set_parts)
    part = next(p for p in set_parts if p.part_no == "RRS-T-001")
    tied = Part(part_no=part.part_no, name=part.name, stock_code="RRS-A-001-250", qty=1, thickness=part.thickness,
                material=part.material)
    job = production.job_from_parts("SO-T", [tied], 2, None, False)
    assert (job.parts[0].code, job.parts[0].drawing_code) == ("RRS-A-001-250", "RRS-T-001")
    demand = laser.demand_from_jobs([job], lib)
    assert not demand.missing and [p.code for p in demand.parts] == ["RRS-A-001-250"]
    assert demand.parts[0].outline == lib.get("RRS-T-001").outline
