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
