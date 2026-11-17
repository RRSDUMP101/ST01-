"""คู่มือประกอบ 3 มิติ: the model from the job, imported meshes, the order of drawing, the view and the tab."""

import os
import struct

import pytest

from partlist_studio.core import assembly3d as a3
from partlist_studio.core import install_manual as im


def _job(**kw) -> im.InstallJob:
    job = im.InstallJob(product=kw.pop("product", "flat_tray"))
    job.apply_product()
    for k, v in kw.items():
        setattr(job, k, v)
    return job


def test_tray_model_follows_the_job():
    model = a3.build_for_job(_job())
    assert "1.96 × 2.60" in model.name and model.source == "auto" and model.problems() == []
    # the factory's 13 steps: on the jig, onto the vehicle, on the vehicle
    assert len(model.steps) == 13
    assert [s.phase for s in model.steps] == ["งานบนจิ๊ก"] * 4 + ["ยกขึ้นรถ"] * 2 + ["งานบนรถ"] * 7
    assert [s.title for s in model.steps][:6] == [
        "วางและเชื่อมโครงตัวล่าง", "เชื่อมโครงตัวบนเข้ากับโครงตัวล่าง", "ปูและเชื่อมแผ่นพื้น", "ติดชิ้นเชื่อมย่อยใต้โครง",
        "ตรวจแท่นยึดบนแชสซี แล้วยกโครงวาง", "ขันสลักยึดกับแท่นยึด"]
    assert model.steps[12].title == "ตรวจขั้นสุดท้าย" and model.steps[12].no_parts
    assert [len(model.parts_of_step(n)) for n in range(1, 14)] == [8, 4, 2, 0, 6, 24, 4, 3, 0, 0, 0, 6, 0]
    assert [n for n, s in enumerate(model.steps, 1) if s.no_parts] == [4, 9, 10, 11, 13]  # work only: no part to show
    assert model.steps[5].torque == "M14 เกรด 10.9: 150–200 Nm" and "ขั้นต่ำ M12 เกรด 10.9" in model.steps[5].check
    assert model.steps[1].check == "ผิวบนอยู่ระนาบเดียวกัน กว้าง 1,960 มม." and "28 มม." in model.steps[4].check
    groups = model.groups()
    assert groups[0] == a3.REF_GROUP and {"ซับเฟรม", "สลักยึด", "คานขวาง", "พื้น", "โครงกันหัว", "ฝาข้าง", "ฝาท้าย"} <= set(groups)
    rails = [p for p in model.parts if p.group == "ซับเฟรม"]
    assert len(rails) == 2 and rails[0].dims[0] == 2600 and rails[0].size == "C100×50×5 L=2600" and rails[0].step == 1
    cross = [p for p in model.parts if p.name == "คานขวาง"]
    xs = sorted(p.pos[0] for p in cross)
    assert len(cross) == 6 and max(b - a for a, b in zip(xs, xs[1:])) <= 600  # BEMM 5.6.3: 600 mm at most
    assert [(b.no, b.name, b.qty) for b in model.bom(6)] == [(1, "แหวนรอง Ø50×5", 12), (2, "สลัก M14 เกรด 10.9 + น็อตล็อก", 12)]
    assert model.bom_no(next(p for p in model.parts if p.name.startswith("สลัก"))) == 2
    lo, hi = model.bounds([p for p in model.parts if p.step > 0])
    assert (hi[0] - lo[0], hi[1] - lo[1]) == (2600, 1960)  # the body is as long and as wide as the job says
    shorter = a3.build_for_job(_job(cab="double", body_length=1850, bolt_size="M12"))
    assert "Double Cab" in shorter.name and shorter.steps[5].torque == "M12 เกรด 10.9: 95–125 Nm"
    assert len([p for p in shorter.parts if p.name == "คานขวาง"]) == 4
    box = a3.build_for_job(_job(product="box_body"))
    assert any(p.name == "หลังคา" for p in box.parts) and "captive" in box.steps[2].warning and box.problems() == []
    assert a3.build_for_job(_job(product="trailer_5m")) is None


def test_the_13_steps_on_an_imported_model():
    """Groups named like the levels of the customer's IGES go to the factory's steps; the rest waits in step 4."""
    def part(n, group, x, y, z):
        return a3.Part3D(f"m{n}", f"{group} {n:02d}", group, "mesh", mesh=[[[x, y, z], [x + 50, y, z], [x, y + 50, z]]])

    names = ["กล่องหลัง", "โครงตัวล่าง", "โครงตัวบน", "พิ้น", "Layer0000", "โรบาหลัง", "ฝาข้าง", "ตะแกรงมีลาย", "Layer0001",
             "บังโครน ใหม่", "ขาบ้ายะเบียน", "ฝาทังนำ้ม้น", "ไฟท้าย", "กรอบพื้น", "บานพับหลัง", "สลักยึดแท่น M12"]
    spots = {"โรบาหลัง": (1200, 0, 300), "ไฟท้าย": (1300, -800, -100), "กล่องหลัง": (1250, 0, -150)}
    parts = [part(n, g, *spots.get(g, (-1000 + 100 * n, (-1) ** n * 600, 10 * n))) for n, g in enumerate(names, 1)]
    parts.insert(2, part(40, "ฝาข้าง", 0, -950, 200))  # the right side gate
    model = a3.AssemblyModel("tray", parts, source="file")
    assert a3.tray_sequence_fits(model) == 11 and a3.tray_sequence_fits(a3.AssemblyModel("x", [part(1, "Layer0000", 0, 0, 0)])) == 0
    where = a3.apply_tray_sequence(model)
    assert where == {"กล่องหลัง": 12, "โครงตัวล่าง": 1, "โครงตัวบน": 2, "พิ้น": 3, "Layer0000": 4, "โรบาหลัง": 9, "ฝาข้าง": 8,
                     "ตะแกรงมีลาย": 7, "Layer0001": 4, "บังโครน ใหม่": 10, "ขาบ้ายะเบียน": 4, "ฝาทังนำ้ม้น": 11, "ไฟท้าย": 12,
                     "กรอบพื้น": 2, "บานพับหลัง": 4, "สลักยึดแท่น M12": 6}
    assert len(model.steps) == 13 and model.problems() == []
    assert [n for n, s in enumerate(model.steps, 1) if s.no_parts] == [5, 13]
    assert model.steps[5].torque == "M12 เกรด 10.9: 95–125 Nm"  # no job: the minimum of Ford's manual
    by_group = {p.group: p for p in model.parts}
    assert by_group["โครงตัวล่าง"].explode == [0.0, 0.0, 0.0] and by_group["พิ้น"].explode == [0.0, 0.0, 650.0]
    assert by_group["โรบาหลัง"].explode == [600.0, 0.0, 0.0] and by_group["ไฟท้าย"].explode == [600.0, 0.0, 0.0]
    assert model.part("m40").explode == [0.0, -550.0, 0.0]  # a side gate goes out to its own side
    mirrored = a3.AssemblyModel("m", [part(1, "โรบาหลัง", -1200, 0, 0), part(2, "โครงตัวล่าง", 0, 0, 0),
                                      part(3, "โครงตัวล่าง", 1300, 0, 0)])
    a3.apply_tray_sequence(mirrored)
    assert mirrored.parts[0].explode == [-600.0, 0.0, 0.0]  # a model drawn with its rear towards −X
    job = _job(bolt_size="M12", cab_gap=35, lamp_low=620)
    a3.apply_tray_sequence(model, job, explode=False)
    assert "งานนี้ 35 มม." in model.steps[4].check and "งานนี้ 620 มม." in model.steps[11].check
    assert by_group["พิ้น"].explode == [0.0, 0.0, 650.0]  # left as they were


def _solid(n, name, group, x, y, z, lx=50.0, ly=50.0, lz=50.0):
    """A part as it comes from a CAD file: a mesh that fills the box from (x, y, z)."""
    faces = [[[x, y, z], [x + lx, y, z], [x, y + ly, z]], [[x + lx, y + ly, z + lz], [x, y + ly, z + lz], [x + lx, y, z + lz]]]
    return a3.Part3D(f"s{n}", name, group, "mesh", mesh=faces)


def _step_tray() -> tuple[a3.AssemblyModel, a3.AssemblyModel]:
    """A tray as ZW3D writes it to STEP (names, a group per part or sub-assembly, the front at −X) and the same
    tray from IGES (no names, the designer's levels)."""
    rows = [  # name, group, box, level in the IGES
        ("ตะขอผ้าไบ 01", "ตะขอผ้าไบ", (0, -900, -60), "Layer0000"),
        ("เต่าที่1", "เต่าที่", (-600, -630, -180), "โครงตัวล่าง"),
        ("เต่าที่1_Mirror_1", "เต่าที่1_Mirror", (-600, 580, -180), "โครงตัวล่าง"),
        ("Part015", "Part", (300, -580, -180), "โครงตัวล่าง"),
        ("Part015_Mirror_1", "Part015_Mirror", (300, 530, -180), "โครงตัวล่าง"),
        ("โครงล่าง หน้า", "โครงล่าง หน้า", (-1300, 0, -100), "โครงตัวบน"),  # the name says lower, the level upper
        ("โครงล่าง หลัง", "โครงล่าง หลัง", (1200, 0, -200), ""),
        ("พื้น ซ้าย 01", "พื้น ซ้าย", (-100, -25, 0), "พิ้น"),
        ("รางข้างแบบพับ 01", "รางข้างแบบพับ", (0, -960, 250, 1200, 20, 300), "ฝาข้าง"),
        ("รางข้างแบบพับ_Mirror 01", "รางข้างแบบพับ_Mirror", (0, 940, 250, 1200, 20, 300), "ฝาข้าง"),
        ("Hex head screw ISO8676-M12x1.25x65-5.6", "Part004", (100, -990, 270, 18, 30, 20), "Layer0000"),
        ("Washer ISO 7090-12-200HV", "Part004", (100, -995, 270, 24, 3, 24), ""),
        ("Hexagon regular nut ISO8673-M12x1.25-0_4", "Hexagon regular nut ISO8673-M12x1.25-0", (1270, -940, 560, 18, 20, 11),
         "ฝาข้าง"),
        ("JNSPN5", "JNSPN", (1270, 910, 560, 23, 54, 3), "ฝาข้าง"),
        ("Hex head screw ISO8676-M8x1x16-5.6", "duratray ตะแกรงห้นา1", (-1370, 90, 355, 21, 15, 13), ""),
        ("Hex head screw ISO8676-M12x1.25x100-5.6", "เขาบน_Mirror", (-1370, 630, 860, 108, 21, 18), "Layer0001"),
        ("ตะแกรง 01", "duratray ตะแกรงห้นา1", (-1390, -25, 400), "ตะแกรงมีลาย"),
        ("ราวท่อด้านข้างตัวหน้า1_Mirror 01", "ราวท่อด้านข้างตัวหน้า1_Mirror", (-500, 900, -300), "Layer0000"),
        ("โรบาหลัง 01", "โรบาหลัง", (1130, -25, 0), "โรบาหลัง"),
        ("ขายึดบังโครน_Mirror", "บังโครน ใหม่_Mirror_1", (700, 800, -200), "Layer0000"),
        ("ฝาทังนำ้ม้น 2", "ฝาทังนำ้ม้น", (-700, -980, -150), "Layer0000"),
        ("N1WJ-19H391-A-1-RVC KIT ASSEMBLY (1) 01", "N1WJ-19H391-A-1-RVC KIT ASSEMBLY (1)", (1030, -30, -370), "กล่องหลัง"),
        ("W711213-S/2-NUT&WSHR M8 HX FL 10 01", "DI-P703-W711213-FBUGJ7_RH-002/2-NUT&WSHR M8 HX FL 10 (View)", (1210, -890, -230),
         "Layer0000"),
        ("Part009_Mirror", "Part009_Mirror", (500, 300, -400), "Layer0000"),
        ("Hexagon nut ISO4032-M10", "Part030", (500, 0, -700, 16, 16, 8), ""),  # a nut by itself, far from anything
        ("ท้าย2", "ท้าย", (-1280, -900, -110), ""),
    ]
    step = a3.AssemblyModel("step", [_solid(n, name, group, *box) for n, (name, group, box, _l) in enumerate(rows)], source="file")
    iges = a3.AssemblyModel("iges", [_solid(n, f"{level} {n:02d}", level, *box) for n, (_n, _g, box, level) in enumerate(rows)
                                     if level], source="file")
    return step, iges


def test_levels_of_the_same_assembly_from_another_file():
    step, iges = _step_tray()
    iges.parts[0].mesh = [[[x + 0.4, y, z] for x, y, z in f] for f in iges.parts[0].mesh]  # the files differ by a hair
    floor = next(p for p in iges.parts if p.group == "พิ้น")  # … and the IGES has this solid sewn in two pieces
    lo, hi = floor.bounds()
    half = (lo[0] + hi[0]) / 2
    iges.parts.append(_solid(90, "พิ้น 90", "พิ้น", half, lo[1], lo[2], hi[0] - half, 50, 50))
    floor.mesh = _solid(0, "", "", lo[0], lo[1], lo[2], half - lo[0], 50, 50).mesh
    stray = _solid(91, "x", "ฝาข้าง", 300, -580, -180)  # two levels at the place of one part: no answer
    iges.parts.append(stray)
    levels = a3.adopt_groups(step, iges)
    by_name = {p.name: levels.get(p.id) for p in step.parts}
    assert by_name["ตะขอผ้าไบ 01"] == "Layer0000" and by_name["เต่าที่1"] == "โครงตัวล่าง" and by_name["พื้น ซ้าย 01"] == "พิ้น"
    assert by_name["Part015"] is None and by_name["โครงล่าง หลัง"] is None and by_name["Part015_Mirror_1"] == "โครงตัวล่าง"
    assert a3.adopt_groups(step, a3.AssemblyModel("far", [_solid(1, "a", "ฝาข้าง", 9000, 0, 0)])) == {}


def test_parts_of_a_real_tray_go_to_their_steps_by_name_level_and_what_they_fasten():
    step, iges = _step_tray()
    levels = a3.adopt_groups(step, iges)
    found = a3.tray_steps(step, levels)
    got = {p.name: found[p.id] for p in step.parts}
    assert got["ตะขอผ้าไบ 01"] == (4, "ตะขอผ้าใบ", "ชื่อ") and got["เต่าที่1"] == (4, "รองขาเต้า", "ชื่อ")  # a name beats the level
    assert got["Part015"] == (1, "โครงตัวล่าง", "เลเยอร์") and got["โครงล่าง หน้า"] == (2, "โครงตัวบน", "เลเยอร์")
    assert got["โครงล่าง หลัง"] == (1, "โครงตัวล่าง", "กลุ่ม")  # no level: its own group, called as the level of that step
    assert got["พื้น ซ้าย 01"] == (3, "พื้น", "เลเยอร์") and got["โรบาหลัง 01"] == (9, "โรบาหลัง", "เลเยอร์")
    assert got["รางข้างแบบพับ 01"] == got["JNSPN5"] == (8, "รางพับฝาข้าง", "ชื่อ")
    # bolts: M12 at the height of the gates are gate bolts – the size does not make them chassis bolts
    assert got["Hex head screw ISO8676-M12x1.25x65-5.6"] == (8, "สลักฝาข้าง / รางพับ", "ชิ้นข้างเคียง")
    assert got["Washer ISO 7090-12-200HV"] == (8, "สลักฝาข้าง / รางพับ", "ชิ้นข้างเคียง")
    assert got["Hexagon regular nut ISO8673-M12x1.25-0_4"] == (8, "สลักฝาข้าง / รางพับ", "เลเยอร์")
    assert got["Hex head screw ISO8676-M8x1x16-5.6"] == (7, "สลักตะแกรงกันหัว", "กลุ่ม")
    assert got["Hex head screw ISO8676-M12x1.25x100-5.6"] == (7, "สลักตะแกรงกันหัว", "กลุ่ม")  # in the headboard's horn
    assert got["Hexagon nut ISO4032-M10"] == (4, a3.UNSORTED_GROUP, "ไม่ทราบ")  # nothing near: not guessed
    assert got["ราวท่อด้านข้างตัวหน้า1_Mirror 01"] == (4, "ราวท่อข้าง", "ชื่อ")
    assert got["ขายึดบังโครน_Mirror"] == (10, "บังโคลน", "ชื่อ") and got["ฝาทังนำ้ม้น 2"] == (11, "คอเติมน้ำมัน", "ชื่อ")
    assert got["N1WJ-19H391-A-1-RVC KIT ASSEMBLY (1) 01"] == (12, "ชุดกล้องถอย", "ชื่อ")  # on the level 'กล่องหลัง'
    assert got["W711213-S/2-NUT&WSHR M8 HX FL 10 01"] == (12, a3.FORD_GROUP, "ชื่อ")  # Ford's nut, not a mount bolt
    assert got["Part009_Mirror"] == (4, a3.UNSORTED_GROUP, "ไม่ทราบ") and got["ท้าย2"] == (4, "ท้าย", "ไม่ทราบ")
    assert [p.name for p in a3.tray_unsorted(step, levels)] == ["Part009_Mirror", "Hexagon nut ISO4032-M10", "ท้าย2"]
    assert a3.tray_sequence_fits(step) >= 8

    a3.apply_tray_sequence(step, levels=levels, tidy=True)
    named = {p.id: (p.name, p.group, p.step) for p in step.parts}
    names = {name for name, _g, _s in named.values()}
    # misspellings corrected; '_Mirror' is the side the part is on (the front is at −X, so −Y is the left)
    assert {"ตะขอผ้าใบ 01", "ขาเต้า ซ้าย", "ขาเต้า ขวา", "Part015 ซ้าย", "Part015 ขวา", "รางข้างแบบพับ ซ้าย 01", "รางข้างแบบพับ ขวา 01",
            "ขายึดบังโคลน ขวา", "ฝาถังน้ำมัน 2", "Part009 ขวา", "ราวท่อด้านข้างตัวหน้า1 ขวา 01", "พื้น ซ้าย 01", "ท้าย2"} <= names
    kept = next(p for p in step.parts if p.name == "ขาเต้า ขวา")
    assert kept.note == "ชื่อในไฟล์: เต่าที่1_Mirror_1" and kept.group == "รองขาเต้า"
    assert not any("_Mirror" in p.name or "_Mirror" in p.group for p in step.parts)
    assert step.problems() == [] and [n for n, s in enumerate(step.steps, 1) if s.no_parts] == [5, 6, 13]
    a3.apply_tray_sequence(step, tidy=True)  # again, without the other file: the groups now say it all
    assert {p.id: (p.name, p.group, p.step) for p in step.parts} == named

    plain = a3.AssemblyModel("p", [_solid(1, "บานพับ_Mirror 02", "บานพับ_Mirror", 0, 0, 0), _solid(2, "บานพับ 01", "บานพับ", 0, 9, 0)])
    assert a3.tidy_names(plain) == 2  # the side is not known: a mirrored part is the right one, as RRS draws them
    assert [p.name for p in plain.parts] == ["บานพับ ขวา 02", "บานพับ ซ้าย 01"]
    assert a3.tidy_name("duratray ตะแกรงห้นา1") == "ตะแกรงหน้า (กันหัว)" and a3.tidy_name("รองขาเต่า4") == "รองขาเต้า4"


def test_faces_wind_outwards():
    np = pytest.importorskip("numpy")
    model = a3.build_for_job(_job())
    for part in model.parts:
        for piece in part.chunks():
            pts = np.array([q for f, _e in piece for q in f])
            mid = (pts.min(0) + pts.max(0)) / 2
            for f, _e in piece:
                v = np.array(f)
                assert np.cross(v[1] - v[0], v[2] - v[1]) @ (v.mean(0) - mid) > 0, part.name
    flipped = a3.Part3D("x", "c", "g", "channel", [500, 50, 100, 5], "y", [0, 0, 0], True)
    assert flipped.bounds() == ((-50, 0, 0), (0, 500, 100)) and len(flipped.chunks()) == 3


def test_imported_models(tmp_path):
    obj = tmp_path / "frame.obj"
    obj.write_text("o RAIL_1\nv 0 0 0\nv 2 0 0\nv 2 0.1 0\nv 0 0.1 0\nf 1 2 3 4\n"
                   "o RAIL_2\nv 0 1 0\nv 2 1 0\nv 2 1.1 0\nf 5 6 7\n"
                   "g CROSS-01\nv 1 0 0.2\nv 1 1 0.2\nv 1.1 1 0.2\nf -3 -2 -1\n", encoding="utf-8")
    stl = tmp_path / "bracket_3.stl"
    tri = struct.pack("<12fH", 0, 0, 1, 0.5, 0.5, 0, 0.6, 0.5, 0, 0.6, 0.6, 0, 0)
    stl.write_bytes(b"\0" * 80 + struct.pack("<I", 1) + tri)
    model = a3.model_from_files([obj, stl])
    assert [p.name for p in model.parts] == ["RAIL_1", "RAIL_2", "CROSS-01", "bracket 3"]
    assert model.groups() == ["RAIL", "CROSS", "bracket"] and [p.step for p in model.parts] == [1, 1, 2, 3]
    assert "เมตร" in model.note and model.bounds()[1][0] == 2000  # 2 units long: metres, made mm
    assert len(model.steps) == 3 and model.problems() == [] and a3.face_count(model) == 4
    assert all(any(abs(x) > 1 for x in p.explode) for p in model.parts)  # every part has somewhere to wait
    text = tmp_path / "t.stl"
    text.write_text("solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 100 0 0\nvertex 0 100 0\nendloop\nendfacet\n",
                    encoding="utf-8")
    assert a3.load_stl(text).mesh == [[[0, 0, 0], [100, 0, 0], [0, 100, 0]]]
    a3.swap_up_axis(model)
    assert model.parts[1].mesh[0][0] == [0, -0.0, 1000]
    path = tmp_path / "m.rrsasm"
    model.save(path)
    back = a3.AssemblyModel.load(path)
    assert back.to_dict() == model.to_dict()
    model.parts[0].step = 7
    model.steps.append(a3.Step("ว่าง"))
    assert len(model.problems()) == 2
    (tmp_path / "empty.obj").write_text("", encoding="utf-8")
    with pytest.raises(ValueError):
        a3.model_from_files([tmp_path / "empty.obj"])
    page = a3.render_steps_html(a3.build_for_job(_job()), {1: "a.png"}, "SO-1", {1})
    assert "งานบนจิ๊ก · ขั้นที่ 1 / 13" in page and "a.png" in page and "☑" in page and "150–200 Nm" in page
    assert "ไม่มีชิ้นส่วนใหม่" in page  # a step of work only says so in place of an empty table


@pytest.fixture(scope="module")
def app():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_a_floor_on_its_beam_is_drawn_after_it(app):
    import numpy as np

    from partlist_studio.ui.assembly_view import Assembly3DView, draw_order

    # a beam under the near edge of a big floor: its middle is nearer to the camera than the middle of the floor
    lo = np.array([[0, 0, 100], [0, 900, 0]], dtype=float)  # floor, beam
    hi = np.array([[2600, 1000, 104], [2600, 950, 100]], dtype=float)
    view = Assembly3DView()
    view.yaw, view.pitch = 90.0, 30.0  # from the +y side, from above
    r, u, d = view._basis()
    assert ((lo + hi) / 2 @ d)[1] < ((lo + hi) / 2 @ d)[0]  # by distance alone the beam would cover the floor
    assert draw_order(lo, hi, d, r, u) == [1, 0]
    view.pitch = -30.0  # from below: the beam is in front
    r, u, d = view._basis()
    assert draw_order(lo, hi, d, r, u) == [0, 1]
    far = np.array([[0, 0, 0], [5000, 5000, 0]], dtype=float)  # two that do not meet in the picture: by distance
    assert sorted(draw_order(far, far + 10, d, r, u)) == [0, 1]


def test_view_steps_and_picking(app):
    from partlist_studio.ui.assembly_view import Assembly3DView

    model = a3.build_for_job(_job())
    view = Assembly3DView()
    view.resize(900, 600)
    view.set_model(model)
    image = view.render_image(900, 600)
    colors = {image.pixel(x, y) for x in range(0, 900, 30) for y in range(0, 600, 30)}
    assert len(colors) > 8  # something is drawn
    floor = next(p for p in model.parts if p.name == "แผ่นพื้น ขวา")  # the sheet at +Y
    picked = model.part(view.pick(450, 300))
    assert picked is not None and picked.step > 0
    view.set_step(2, animate=False)
    states = {p.name: view._state(p) for p in model.parts}
    assert states["คานข้าง ซ้าย"] == "current" and states["คานตามยาว ซ้าย"] == "done"
    assert states["แผ่นพื้น ซ้าย"] == "" and states["ผนังหลังเก๋ง"] == "ref"
    view.ghost_later = True
    assert view._state(floor) == "ghost"
    view.set_explode(0.5)
    assert list(view._offset(floor, "normal")) == [0, 75, 300] and not view._offset(model.parts[0], "ref").any()
    view.set_step(3)  # the floor flies in
    assert view._anim == 1 and view._timer.isActive() and list(view._offset(floor, "current")) == list(floor.explode)
    view.finish_animation()
    zoom = view.zoom
    view.zoom_to([floor.id])
    assert view.zoom != zoom and abs(view.target[2] - 177) < 1
    view.hidden_groups = {"พื้น"}
    assert view._state(floor) == ""


@pytest.fixture
def window(app, tmp_path):
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    w.go("install")
    yield w
    w.state.dirty = False
    w.close()


def test_assembly_tab(window, tmp_path):
    from PySide6.QtCore import Qt

    page = window.pages["install"]
    tab = page.assembly
    assert "Single Cab" in tab.title.text() and tab.step == 0 and tab.bom.rowCount() > 10
    assert tab.groups.count() == len(tab.model.groups())  # 'ทุกกลุ่ม' in place of the vehicle
    tab.go(6, animate=False)
    assert tab.step_no.text() == "ขั้นที่ 6 / 13 · ยกขึ้นรถ" and tab.bom.rowCount() == 2
    assert "150–200 Nm" in tab.step_info.text() and "ไม่มีชิ้นส่วนใหม่" not in tab.step_info.text()
    tab.done.setChecked(True)
    assert page.job.record["asm:6"]["done"] and "1 / 13" in tab.progress.text()
    tab.go(99)
    assert tab.step == 13 and "ไม่มีชิ้นส่วนใหม่" in tab.step_info.text() and tab.bom.rowCount() == 0
    tab.go(-5)
    assert tab.step == 0 and tab.step_no.text().startswith("ภาพรวม")
    # one group alone
    tab.groups.setCurrentIndex(tab.groups.findData("คานขวาง"))
    assert "ซับเฟรม" in tab.view.hidden_groups and a3.REF_GROUP not in tab.view.hidden_groups
    tab.vehicle.setChecked(False)
    assert a3.REF_GROUP in tab.view.hidden_groups
    tab.groups.setCurrentIndex(0)
    # the job changes: the model follows (the 2.60 m tray on a double cab is still drawn - the BEMM tab says it fails)
    page.inputs["body_length"].setValue(1850)
    assert "1.85" in tab.title.text() and len([p for p in tab.model.parts if p.name == "คานขวาง"]) == 4
    assert "asm:6" in page.job.record  # the marks stay with the job
    # a part moved to another step by hand: the model is no longer rebuilt from the job
    row = next(r for r in range(tab.parts.rowCount()) if tab.parts.item(r, 1).text() == "คานท้าย")
    tab.parts.item(row, 3).setText("3")
    tab.parts.item(row, 5).setText("RRS-F-900")
    assert tab.model.source == "file" and [b.name for b in tab.model.bom(3)][0] == "คานท้าย"
    page.inputs["body_length"].setValue(2000)
    assert "1.85" in tab.title.text()
    tab.go(3, animate=False)
    assert tab.bom.rowCount() == 3 and tab.bom.item(0, 3).text() == "RRS-F-900"
    tab.step_title.setText("ปูพื้น + คานท้าย")
    tab._step_text_edited()
    saved = tab.save_model(str(tmp_path / "m.rrsasm"))
    tab.rebuild(force=True)
    assert "2.00" in tab.title.text() and tab.model.source == "auto"
    tab.open_model(saved)
    assert tab.model.steps[2].title == "ปูพื้น + คานท้าย" and tab.model.source == "file"
    pdf = tab.export_pdf(str(tmp_path / "manual.pdf"))
    assert (tmp_path / "manual.pdf").read_bytes()[:4] == b"%PDF" and pdf
    tab.export_pdf(str(tmp_path / "manual.html"))
    assert len(list((tmp_path / "manual").glob("step_*.png"))) == 13
    assert "งานบนรถ · ขั้นที่ 13 / 13" in (tmp_path / "manual.html").read_text("utf-8")
    # the demonstration
    tab.go(0)
    tab.toggle_play()
    assert tab._playing and tab.step == 1 and tab.play_btn.text() == "■ หยุด"
    tab.view.finish_animation()
    tab._play_next()
    assert tab.step == 2
    tab.toggle_play()
    assert not tab._playing
    # a trailer has no sample model; an imported one takes its place
    page.inputs["product"].setCurrentIndex(page.inputs["product"].findData("trailer_5m"))
    tab.rebuild(force=True)
    assert tab.model is None and tab.bom.rowCount() == 0 and "นำเข้า" in tab.note.text()
    obj = tmp_path / "t.obj"
    obj.write_text("o DRAWBAR\nv 0 0 0\nv 1500 0 0\nv 1500 100 0\nf 1 2 3\no AXLE_1\nv 0 0 300\nv 0 1800 300\nv 50 1800 300\nf 4 5 6\n",
                   encoding="utf-8")
    model = tab.import_files([str(obj)])
    assert model is tab.model and tab.parts.rowCount() == 2 and len(model.steps) == 2
    tab.view.resize(700, 500)
    assert not tab.view.render_image(700, 500, fit=True).isNull()
    tab.parts.selectRow(1)
    assert tab.view.selected == model.parts[1].id and "AXLE_1" in tab.part_info.text()
    assert tab.parts.item(0, 0).checkState() == Qt.Checked
    tab.parts.item(0, 0).setCheckState(Qt.Unchecked)
    assert model.parts[0].id in tab.view.hidden_parts


def test_imported_mesh_is_filled_and_picked(app):
    """A thin plate seen from above: its top and bottom triangles overlap on the screen and turn opposite ways. Drawn
    as one path they must not cancel each other (the floor of the real tray once showed as a hole)."""
    import numpy as np

    from partlist_studio.ui.assembly_view import Assembly3DView, triangles_path

    from PySide6.QtCore import QPointF

    twice = triangles_path(np.array([[[0, 0], [10, 0], [0, 10]], [[0, 0], [10, 0], [0, 10]]], dtype=float))
    assert twice.elementCount() == 8 and twice.contains(QPointF(2, 2))  # one over the other: still filled
    opposite = triangles_path(np.array([[[0, 0], [10, 0], [0, 10]], [[0, 0], [0, 10], [10, 0]]], dtype=float))
    assert not opposite.contains(QPointF(2, 2))  # why the view turns them all the same way first
    top = [[0, 0, 2], [1000, 0, 2], [1000, 800, 2]], [[0, 0, 2], [1000, 800, 2], [0, 800, 2]]
    bottom = [[0, 0, 0], [1000, 800, 0], [1000, 0, 0]], [[0, 0, 0], [0, 800, 0], [1000, 800, 0]]
    quad = [[0, 0, 0], [1000, 0, 0], [1000, 0, 2], [0, 0, 2]]  # a face with 4 corners: drawn as 2 triangles
    plate = a3.Part3D("m1", "แผ่นพื้น", "พื้น", "mesh", mesh=[*top, *bottom, quad], color="#A0A0A0", step=1)
    model = a3.AssemblyModel("plate", [plate], [a3.Step("พื้น")], source="file")
    view = Assembly3DView()
    view.resize(600, 400)
    view.set_model(model)
    assert view._meshes["m1"].faces == 6
    for moving in (False, True):
        view._moving = moving
        image = view.render_image(600, 400)
        r, g, b = image.pixelColor(300, 200).getRgb()[:3]
        assert abs(r - g) < 6 and abs(g - b) < 6 and 60 < r < 200, (moving, r, g, b)  # grey steel, not the background
    view._moving = False
    assert view.pick(300, 200) == "m1" and view.pick(5, 5) == ""
    view.selected = "m1"  # a selected mesh is tinted (it has no outline to thicken)
    r, g, b = view.render_image(600, 400).pixelColor(300, 200).getRgb()[:3]
    assert r > b + 15


def test_a_long_import_note_stays_short(window):
    tab = window.pages["install"].assembly
    assert "ตัวอย่าง" in tab.note.text() and not tab.note.toolTip()  # the sample's own note fits
    model = a3.build_for_job(_job())
    model.source = "file"
    model.note = " · ".join(f"บันทึกข้อที่ {n} " + "ก" * 60 for n in range(1, 9))
    model.steps.append(a3.Step("ขั้นที่ไม่มีชิ้นส่วน"))
    tab.set_model(model)
    shown = tab.note.text()
    assert "ข้อที่ 2" in shown and "ข้อที่ 3" not in shown and "ชี้เมาส์" in shown
    assert "ไม่มีชิ้นส่วน" in shown  # what is wrong with the steps is never cut away
    assert "ข้อที่ 8" in tab.note.toolTip()


def test_steps_can_be_added_removed_and_moved():
    model = a3.build_for_job(_job())
    titles = [s.title for s in model.steps]
    floor = [p.id for p in model.parts_of_step(3)]
    assert a3.insert_step(model, 2, a3.Step("ตรวจระดับ")) == {n: n + 1 for n in range(2, 14)}
    assert [s.title for s in model.steps] == [titles[0], "ตรวจระดับ", *titles[1:]] and model.parts_of_step(2) == []
    assert [p.id for p in model.parts_of_step(4)] == floor
    assert model.problems() == ["ขั้นที่ 2 “ตรวจระดับ” ไม่มีชิ้นส่วน"]  # a new step is expected to get parts
    assert a3.move_step(model, 4, -1) == {4: 3, 3: 4}
    assert [p.id for p in model.parts_of_step(3)] == floor and model.steps[2].title == "ปูและเชื่อมแผ่นพื้น"
    assert a3.move_step(model, 1, -1) == {} and a3.move_step(model, 14, 1) == {} and a3.move_step(model, 2, 3) == {}
    assert a3.remove_step(model, 2)[2] is None and [s.title for s in model.steps][:2] == [titles[0], titles[2]]
    frame, plates = len(model.parts_of_step(1)), len(model.parts_of_step(2))
    moved = a3.remove_step(model, 2)  # the floor joins the lower frame
    assert moved == {2: None, **{n: n - 1 for n in range(3, 14)}} and len(model.parts_of_step(1)) == frame + plates
    upper = len(model.parts_of_step(2))
    a3.remove_step(model, 1)  # the first step: its parts join what is now the first
    assert len(model.parts_of_step(1)) == frame + plates + upper and model.problems() == [] and len(model.steps) == 11
    one = a3.AssemblyModel("x", [a3.Part3D("a", "a", "g", step=1)], [a3.Step("เดียว")])
    assert a3.remove_step(one, 1) == {} and len(one.steps) == 1  # the last step stays
    a3.set_explode(one.parts, "ไปทางซ้าย (−Y)", 250)
    assert one.parts[0].explode == [0.0, -250.0, 0.0]


def test_tab_tools_for_many_parts_and_steps(window, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    page = window.pages["install"]
    tab = page.assembly
    model = tab.model
    rows = [r for r in range(tab.parts.rowCount()) if tab.parts.item(r, 1).text() == "คานขวาง"]
    for r in rows:
        tab.select_part_row(r, more=True)
    assert tab.chosen.text() == "เลือก 6 ชิ้น" and len(tab.view.marked) == 6
    assert tab.move_selected_to_step() == 0  # the overview is no step
    tab.go(5, animate=False)
    assert tab.move_selected_to_step() == 6 and tab.model.source == "file"
    assert sum(1 for p in model.parts_of_step(5) if p.name == "คานขวาง") == 6 and len(model.parts_of_step(1)) == 2
    assert len(tab.selected_parts()) == 6  # the selection stays for the next action
    assert tab.set_group_selected("กรอบพื้น") == 6 and "คานขวาง" not in model.groups()
    tab.explode_dir.setCurrentText("ลง (−Z)")
    tab.explode_dist.setValue(300)
    assert tab.set_explode_selected() == 6 and tab.selected_parts()[0].explode == [0.0, 0.0, -300.0]
    assert tab.explode.value() == 100
    # the fields of a step
    tab.edit_btn.setChecked(True)
    assert tab.editor.isVisibleTo(tab) and not tab.step_info.isVisibleTo(tab)
    tab.step_fields["torque"].setText("M10 เกรด 8.8: 41–55 Nm")
    tab.step_fields["check"].setText("ระยะทแยงมุมเท่ากัน ±2 มม.")
    tab._step_fields_edited()
    assert model.steps[4].torque == "M10 เกรด 8.8: 41–55 Nm" and model.steps[4].check.startswith("ระยะทแยงมุม")
    # steps added, moved, removed; the done marks follow their steps
    tab.done.setChecked(True)
    assert page.job.record["asm:5"]["done"]
    assert tab.shift_step(-1) and tab.step == 4 and model.steps[3].torque.startswith("M10")
    assert page.job.record["asm:4"]["done"] and "asm:5" not in page.job.record
    assert tab.add_step(after=False) == 4 and model.steps[3].title == "ขั้นตอนใหม่" and len(model.steps) == 14
    assert "ขั้นที่ 4 “ขั้นตอนใหม่” ไม่มีชิ้นส่วน" in tab.note.text()
    assert page.job.record["asm:5"]["done"] and tab.bom.rowCount() == 0
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.Yes)
    assert tab.delete_step() and len(model.steps) == 13 and page.job.record["asm:4"]["done"]
    tab.go(4, animate=False)
    assert tab.done.isChecked() and tab.step_fields["torque"].text().startswith("M10")
    assert not tab.shift_step(9)
    pdf_note = a3.render_steps_html(model, {}, "SO-9", tab.done_steps())
    assert "41–55 Nm" in pdf_note and "ระยะทแยงมุม" in pdf_note


def test_tab_puts_the_13_steps_on_an_imported_model(window, tmp_path):
    page = window.pages["install"]
    tab = page.assembly
    obj = tmp_path / "tray.obj"
    obj.write_text("".join(f"o {name}\nv {x} 0 {z}\nv {x + 100} 0 {z}\nv {x} 100 {z}\nf -3 -2 -1\n" for name, x, z in (
        ("โครงตัวล่าง_1", 0, 0), ("โครงตัวล่าง_2", 500, 0), ("โครงตัวบน_1", 0, 100), ("พิ้น_1", 0, 180),
        ("Layer0000_1", 200, 50), ("ฝาข้าง_1", 0, 300), ("โรบาหลัง_1", 2500, 300), ("กล่องหลัง_1", 2550, -100))), encoding="utf-8")
    model = tab.import_files([str(obj)])
    assert len(model.steps) == 7 and a3.tray_sequence_fits(model) == 6  # an OBJ comes in with a step per group
    tab.go(2, animate=False)
    tab.done.setChecked(True)
    where = tab.use_tray_sequence(ask=False)
    assert where[a3.UNSORTED_GROUP] == 4 and where["โรบาหลัง"] == 9 and len(tab.model.steps) == 13 and tab.step == 0
    assert where["พื้น"] == 3 and "ยังไม่ได้จัด 1 ชิ้น" in window.statusBar().currentMessage()  # 'พิ้น' as the file spells it
    assert not any(k.startswith("asm:") for k in page.job.record)  # the marks were of the old steps
    assert "ขั้น 4" in window.statusBar().currentMessage() or tab.model.problems() == []
    tab.go(1, animate=False)
    assert tab.step_no.text() == "ขั้นที่ 1 / 13 · งานบนจิ๊ก" and tab.bom.rowCount() == 2
    tab.go(5, animate=False)
    assert "28 มม." in tab.step_info.text() and "ไม่มีชิ้นส่วนใหม่" in tab.step_info.text()


def test_tab_takes_the_groups_of_the_same_assembly_from_another_file(window, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    tab = window.pages["install"].assembly
    step, iges = _step_tray()
    tab.set_model(step)
    other = tmp_path / "iges.rrsasm"
    iges.save(other)
    assert tab.adopt_levels(str(other))
    message = window.statusBar().currentMessage()
    assert "ตรงกัน 21 จาก 26 ชิ้น" in message and "ยังไม่ได้จัด 3 ชิ้น" in message, message
    part = tab.model.part("s3")  # 'Part015': a name that says nothing, on the designer's level of the lower frame
    assert len(tab.model.steps) == 13 and (part.name, part.group, part.step) == ("Part015 ซ้าย", "โครงตัวล่าง", 1)
    assert part.note == "ชื่อในไฟล์: Part015"
    warned = []
    monkeypatch.setattr(QMessageBox, "warning", lambda *a: warned.append(a[2]))
    far = tmp_path / "far.rrsasm"
    a3.AssemblyModel("far", [_solid(1, "a", "ฝาข้าง", 9000, 0, 0)]).save(far)
    assert not tab.adopt_levels(str(far)) and "ไม่พบชิ้นของ far.rrsasm" in warned[0]
    assert not tab.adopt_levels(str(tmp_path / "none.rrsasm")) and "อ่านไฟล์ไม่ได้" in warned[1]


def test_what_the_name_of_a_fastener_says():
    spec = a3.fastener_spec
    assert spec("Hex head screw ISO8676-M12x1.25x65-5.6") == {
        "kind": "สลักเกลียว", "standard": "ISO 8676", "thread": "M12", "pitch": "1.25", "length": "65", "grade": "5.6"}
    assert spec("Hex head screw ISO4017-M8x25-5.6")["length"] == "25" and "pitch" not in spec("Hex head screw ISO4017-M8x25-5.6")
    assert spec("Hexagon high nut ISO8674-M8x1-8_1") == {"kind": "น็อต", "standard": "ISO 8674", "thread": "M8", "pitch": "1", "grade": "8"}
    assert "grade" not in spec("Hexagon regular nut ISO8673-M12x1.25-0_4")  # '-0_4' is the CAD's copy number
    assert spec("Washer ISO 7090-12-200HV") == {"kind": "แหวนรอง", "standard": "ISO 7090", "thread": "M12"}
    assert spec("สลัก M14 เกรด 10.9 + น็อตล็อก") == {"kind": "สลักเกลียว", "thread": "M14", "grade": "10.9"}  # a bolt with its nut
    assert spec("คานตามยาว ซ้าย") == {} and spec("แหวนรอง Ø50×5") == {"kind": "แหวนรอง"}


def test_details_of_a_part_for_its_card(tmp_path):
    job = _job()
    model = a3.build_for_job(job)
    bolt = next(p for p in model.parts if p.name.startswith("สลัก"))
    info = a3.part_details(model, bolt, job)
    rows = dict(info["rows"])
    assert info["title"] == bolt.name and info["step"] == 6 and info["count"] == 12 and info["photo"] == ""
    assert info["subtitle"] == "สลักยึด · ขั้นที่ 6" and "ขันแรงบิด" in info["description"]
    assert rows["ขั้นประกอบ"] == "ขั้นที่ 6 / 13 · ยกขึ้นรถ – ขันสลักยึดกับแท่นยึด" and rows["จำนวนในโมเดล"] == "12 ชิ้น"
    assert rows["ชนิด"] == "สลักเกลียว M14" and rows["เกรด"] == "10.9" and rows["แรงขันของขั้นนี้"] == "M14 เกรด 10.9: 150–200 Nm"
    assert "แรงขันตามคู่มือ Ford" not in rows  # the step says it already
    assert {"เครื่องมือ", "จุดตรวจ", "คำเตือน", "อ้างอิง BEMM", "ขนาดกรอบชิ้น", "ตำแหน่งกลางชิ้น"} <= set(rows)
    loose = a3.Part3D("x", "Hex head screw ISO8676-M12x1.25x65-10.9", "ยังไม่จัดกลุ่ม", "mesh", mesh=[[[0, 0, 0], [65, 0, 0], [0, 18, 21]]])
    rows = dict(a3.part_details(a3.AssemblyModel("m", [loose]), loose)["rows"])
    assert rows["ขั้นประกอบ"] == "ยังไม่ได้จัดเข้าขั้น" and rows["ชนิด"] == "สลักเกลียว M12 × 1.25 ยาว 65 มม."
    assert rows["แรงขันตามคู่มือ Ford"] == "95–125 Nm (M12 เกรด 10.9)" and rows["มาตรฐาน"] == "ISO 8676"
    chassis = next(p for p in model.parts if p.group == a3.REF_GROUP)
    assert dict(a3.part_details(model, chassis)["rows"])["ขั้นประกอบ"].startswith("ของรถ")
    model.photos[bolt.name] = "QUJD"  # a photo of the real part goes with the model file
    path = tmp_path / "m.rrsasm"
    model.save(path)
    again = a3.AssemblyModel.load(path)
    assert again.photos == {bolt.name: "QUJD"} and a3.part_details(again, again.part(bolt.id))["photo"] == "QUJD"
    assert "photos" not in a3.AssemblyModel("m", [loose]).to_dict()


def test_a_tap_on_a_part_opens_its_detail_card(window, tmp_path):
    from PySide6.QtCore import QPoint, QPointF, Qt
    from PySide6.QtGui import QColor, QImage
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QApplication

    tab = window.pages["install"].assembly
    window.resize(1500, 950)
    window.show()
    window.go("install")
    window.pages["install"].tabs.setCurrentWidget(tab)
    popup, model = tab.popup, tab.model
    bolts = [p for p in model.parts if p.name.startswith("สลัก")]
    bolt = bolts[0]
    assert not popup.isVisible()
    tab.view.last_click = QPointF(60, 80)
    tab.view.part_clicked.emit(bolt.id)  # what a click on the part in the picture sends
    assert popup.isVisible() and popup.part_id == bolt.id and popup.title.text() == bolt.name
    assert popup.subtitle.text() == "สลักยึด · ขั้นที่ 6" and popup.step_btn.text() == "ไปขั้นที่ 6"
    assert popup.all_same.text() == "ใช้ที่แก้กับชิ้นชื่อเดียวกันทั้ง 12 ชิ้น" and popup.form.rowCount() >= 10
    assert popup.mini.model.parts[0].name == bolt.name and len(popup.mini.model.parts) == 1  # the part alone, to turn
    assert popup.media.currentIndex() == 0 and "ยังไม่มีรูปจริง" in popup.photo.text() and not popup.has_photo()
    inside = tab.view.rect().adjusted(0, 0, -1, -1)  # it opens over the picture (and floats over the whole window)
    assert popup.parentWidget() is window and inside.contains(tab.view.mapFrom(window, popup.pos()))
    assert popup.width() <= popup.WIDTH
    # a tap on the card is not a tap on the picture under it
    QTest.qWait(QApplication.doubleClickInterval() + 80)  # for that long the card lets a second click through
    tab.view.selected = bolt.id
    QTest.mouseClick(popup, Qt.LeftButton, Qt.NoModifier, QPoint(8, 8))
    assert tab.view.selected == bolt.id and popup.isVisible()
    # save: Part No. and note for every part of that name
    popup.part_no.setText("RRS-BOLT-M14")
    popup.note.setText("ทาเครื่องหมายสีหลังขัน")
    popup.save_btn.click()
    assert not popup.isVisible() and all(p.part_no == "RRS-BOLT-M14" and p.note == "ทาเครื่องหมายสีหลังขัน" for p in bolts)
    assert tab.model.source == "file" and "12 ชิ้น" in window.statusBar().currentMessage()
    # … or for this one only
    tab.view.part_clicked.emit(bolt.id)
    assert popup.part_no.text() == "RRS-BOLT-M14"
    popup.all_same.setChecked(False)
    popup.part_no.setText("RRS-BOLT-M14-A")
    popup.save_btn.click()
    assert bolt.part_no == "RRS-BOLT-M14-A" and bolts[1].part_no == "RRS-BOLT-M14"
    # a photo of the real part
    picture = tmp_path / "bolt.png"
    image = QImage(1800, 1200, QImage.Format_RGB888)
    image.fill(QColor("#8a8f96"))
    image.save(str(picture))
    tab.view.part_clicked.emit(bolts[1].id)
    assert tab.attach_photo(bolts[1].id, str(picture))
    assert popup.isVisible() and popup.has_photo() and popup.media.currentIndex() == 1 and not popup.photo.pixmap().isNull()
    stored = QImage.fromData(__import__("base64").b64decode(tab.model.photos[bolts[1].name]))
    assert max(stored.width(), stored.height()) == 900  # kept small in the model file
    popup.cancel_btn.click()
    tab.view.part_clicked.emit(bolt.id)  # the other bolt of the same name shows the photo too
    assert popup.has_photo() and popup.media.currentIndex() == 1
    popup.remove_btn.click()
    assert tab.model.photos == {} and not popup.has_photo() and popup.isVisible()
    # the buttons that go somewhere
    zoom = tab.view.zoom
    popup.zoom_btn.click()
    assert tab.view.zoom != zoom and popup.isVisible()
    popup.step_btn.click()
    assert tab.step == 6 and not popup.isVisible()
    # put away: ✕ · a tap beside the model · the option off
    tab.view.part_clicked.emit(bolt.id)
    popup.close_btn.click()
    assert not popup.isVisible()
    tab.view.part_clicked.emit(bolt.id)
    tab.view.part_clicked.emit("")
    assert not popup.isVisible()
    tab.detail_on.setChecked(False)
    tab.view.part_clicked.emit(bolt.id)
    assert not popup.isVisible() and tab.view.selected == bolt.id
    tab.detail_on.setChecked(True)
    chassis = next(p for p in tab.model.parts if p.group == a3.REF_GROUP)
    tab.view.part_clicked.emit(chassis.id)
    assert popup.isVisible() and not popup.step_btn.isEnabled() and popup.step_btn.text() == "ไปขั้นประกอบ"
    tab.go(2, animate=False)
    assert not popup.isVisible()  # another step: the card goes
    window.state.dirty = False


def test_card_keeps_what_differs_and_follows_the_model(window, tmp_path):
    """What a review of the card found: only the changed field goes to the other parts of that name, typed text
    survives a new photo, the card goes when the model is edited elsewhere, and a photo follows a new name."""
    from PySide6.QtCore import QPointF
    from PySide6.QtGui import QColor, QImage

    tab = window.pages["install"].assembly
    window.resize(1500, 950)
    window.show()
    window.go("install")
    window.pages["install"].tabs.setCurrentWidget(tab)
    tab.rebuild(force=True)
    popup = tab.popup
    bolts = [p for p in tab.model.parts if p.name.startswith("สลัก")]
    a, b = bolts[0], bolts[1]
    a.part_no, b.part_no, b.note = "RRS-A", "RRS-B", "ตัวหน้าซ้าย"  # different on purpose
    tab.view.last_click = QPointF(60, 80)
    tab.view.part_clicked.emit(a.id)
    popup.note.setText("ทาเครื่องหมายสี")  # the note only; 'all of that name' is ticked
    popup.save_btn.click()
    assert (a.part_no, a.note) == ("RRS-A", "ทาเครื่องหมายสี") and (b.part_no, b.note) == ("RRS-B", "ทาเครื่องหมายสี")
    tab.view.part_clicked.emit(a.id)
    popup.save_btn.click()  # nothing changed: nothing written
    assert b.part_no == "RRS-B"
    # typed text stays when a photo is attached
    picture = tmp_path / "bolt.png"
    image = QImage(64, 48, QImage.Format_RGB888)
    image.fill(QColor("#8a8f96"))
    image.save(str(picture))
    tab.view.part_clicked.emit(a.id)
    popup.part_no.setText("RRS-TYPED")
    popup.all_same.setChecked(False)
    assert tab.attach_photo(a.id, str(picture))
    assert not popup.isHidden() and popup.part_no.text() == "RRS-TYPED" and not popup.all_same.isChecked() and popup.has_photo()
    popup.save_btn.click()
    assert a.part_no == "RRS-TYPED" and b.part_no == "RRS-B"
    # the photo goes with a new name (the name column of the table)
    old = a.name
    for row in range(tab.parts.rowCount()):
        if tab.parts.item(row, 0).data(0x0100) in {p.id for p in bolts}:
            tab.parts.item(row, 1).setText("สลักยึดแท่น M14")
    assert tab.model.photos.keys() == {"สลักยึดแท่น M14"} and old not in tab.model.photos
    # the card goes when the model is changed elsewhere
    tab.go(3, animate=False)
    tab.view.part_clicked.emit(a.id)
    assert not popup.isHidden() and popup.has_photo()
    assert tab.delete_step(ask=False) and popup.isHidden()
    tab.view.part_clicked.emit(a.id)
    tab.parts.item(0, 3).setText("2")  # a step typed in the table
    assert popup.isHidden()
    window.state.dirty = False


def test_double_click_and_escape_with_the_card(window):
    from PySide6.QtCore import QPoint, Qt
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QApplication

    tab = window.pages["install"].assembly
    window.resize(1500, 950)  # the picture is narrower than twice the card: the card lies over the tapped point
    window.show()
    window.activateWindow()
    window.go("install")
    window.pages["install"].tabs.setCurrentWidget(tab)
    tab.rebuild(force=True)
    QApplication.processEvents()
    view, popup = tab.view, tab.popup
    view.fit()
    view.repaint()
    spot = next(QPoint(x, y) for y in range(60, view.height() - 60, 6) for x in range(60, view.width() - 60, 6)
                if (pid := view.pick(x, y)) and tab.model.part(pid).step > 0)
    QTest.mouseClick(view, Qt.LeftButton, Qt.NoModifier, spot)
    assert not popup.isHidden() and popup.part_id == view.selected
    if QApplication.focusWidget() is not None:  # the offscreen platform may give no focus at all
        assert QApplication.focusWidget() is popup
    QTest.keyClick(QApplication.focusWidget() or popup, Qt.Key_Escape)
    assert popup.isHidden()
    zoom = view.zoom
    QTest.mouseClick(view, Qt.LeftButton, Qt.NoModifier, spot)  # … and the second click of a double click
    assert not popup.isHidden()
    QTest.mouseDClick(view, Qt.LeftButton, Qt.NoModifier, spot)
    assert popup.isHidden() and view.zoom != zoom  # the picture zoomed to the part, the card is out of the way
    window.state.dirty = False


def test_sorting_holds_for_what_a_review_found():
    # 'ขวา' inside 'คานขวาง' is not a side
    assert a3._with_side("คานขวาง_Mirror 02", "ซ้าย") == "คานขวาง ซ้าย 02" and a3._with_side("คานขวาง 01", "ขวา") == "คานขวาง ขวา 01"
    assert a3._with_side("พื้น ซ้าย2_Mirror", "ขวา") == "พื้น ขวา2" and a3._with_side("ขาคานขวาง ขวา", "ซ้าย") == "ขาคานขวาง ซ้าย"
    # bolts on a level do not give their group to the gates of that step
    step, iges = _step_tray()
    step.parts.append(_solid(60, "delux steel ฝาข้าง 01", "delux steel ฝาข้าง", 0, -970, 300, 1200, 20, 300))
    found = a3.tray_steps(step, a3.adopt_groups(step, iges))
    assert found["s60"] == (8, "delux steel ฝาข้าง", "กลุ่ม") or found["s60"][1] == "ฝาข้าง", found["s60"]
    assert found["s60"][1] not in a3.FASTENER_GROUPS.values()
    # a bolt through two parts goes with the later one, whichever is listed first
    beam = _solid(1, "โครงตัวบน ข้าง 01", "โครงตัวบน", 0, -960, 0, 2400, 50, 50)
    rail = _solid(2, "รางข้างแบบพับ 01", "รางข้างแบบพับ", 0, -960, 50, 2400, 20, 300)
    screw = _solid(3, "Hex head screw ISO8676-M12x1.25x65-5.6", "Part004", 100, -990, 30, 18, 60, 40)
    for order in ([beam, rail, screw], [rail, beam, screw], [screw, beam, rail]):
        assert a3.tray_steps(a3.AssemblyModel("m", list(order)))["s3"] == (8, "สลักฝาข้าง / รางพับ", "ชิ้นข้างเคียง")
    # the program's own order - import (the steps at once), then the levels - gives what the levels at once give
    at_once, iges = _step_tray()
    a3.apply_tray_sequence(at_once, levels=a3.adopt_groups(at_once, iges), tidy=True)
    later, _ = _step_tray()
    a3.apply_tray_sequence(later, tidy=True)
    assert next(p for p in later.parts if p.id == "s3").step == 4  # 'Part015': nothing says what it is yet
    a3.apply_tray_sequence(later, levels=a3.adopt_groups(later, iges), tidy=True)
    assert [(p.name, p.group, p.step) for p in later.parts] == [(p.name, p.group, p.step) for p in at_once.parts]
    a3.apply_tray_sequence(later, tidy=True)  # … and the levels are remembered without the other file
    assert [(p.name, p.group, p.step) for p in later.parts] == [(p.name, p.group, p.step) for p in at_once.parts]
    moved = next(p for p in later.parts if p.id == "s3")
    moved.group = "บังโคลน"  # a group set by hand counts as what the file says
    a3.apply_tray_sequence(later, tidy=True)
    assert (moved.group, moved.step) == ("บังโคลน", 10)
    # sides: not for bolts, and by the sub-assembly of the file, not by the group the part ends up in
    hinges = a3.AssemblyModel("h", [
        _solid(1, "บานพับ 01", "บานพับ", 0, -900, 0), _solid(2, "บานพับ_Mirror 01", "บานพับ_Mirror", 0, 850, 0),
        _solid(3, "Hex head screw ISO8676-M8x1x16-5.6", "บานพับ", 10, -900, 0, 16, 8, 8),
        _solid(4, "Hex head screw ISO8676-M8x1x16-5.6", "บานพับ_Mirror", 10, 850, 0, 16, 8, 8),
        _solid(5, "โรบาหลัง 01", "โรบาหลัง", 1200, -25, 0)])
    hinges.photos["บานพับ_Mirror 01"] = "QUJD"
    a3.apply_tray_sequence(hinges, tidy=True)
    assert [p.name for p in hinges.parts[:4]] == ["บานพับ ซ้าย 01", "บานพับ ขวา 01", "Hex head screw ISO8676-M8x1x16-5.6",
                                                  "Hex head screw ISO8676-M8x1x16-5.6"]
    assert a3.fastener_spec(hinges.parts[2].name)["grade"] == "5.6" and len(hinges.bom()) == 4
    assert hinges.photos == {"บานพับ ขวา 01": "QUJD"}  # the photo went with the name


def test_the_card_can_be_dragged_out_of_the_way(window):
    from PySide6.QtCore import QPoint, QPointF, Qt
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QApplication

    page = window.pages["install"]
    tab = page.assembly
    window.resize(1500, 950)
    window.show()
    window.go("install")
    page.tabs.setCurrentWidget(tab)
    tab.rebuild(force=True)
    QApplication.processEvents()
    popup, view = tab.popup, tab.view
    bolts = [p for p in tab.model.parts if p.name.startswith("สลัก")]
    view.last_click = QPointF(200, 250)
    view.part_clicked.emit(bolts[0].id)
    QTest.qWait(QApplication.doubleClickInterval() + 80)
    start = popup.pos()
    assert not popup.is_pinned() and popup.grip.text() == "⋮⋮"
    # dragged by its head, to the left, over the table of parts: out of the picture
    QTest.mousePress(popup, Qt.LeftButton, Qt.NoModifier, QPoint(60, 18))
    QTest.mouseMove(popup, QPoint(60 - 380, 18 - 90))
    QTest.mouseRelease(popup, Qt.LeftButton, Qt.NoModifier, QPoint(60 - 380, 18 - 90))
    if popup.pos() == start:  # this Qt sends the move without the button held: move it the way the drag does
        popup.move_card(start + QPoint(-380, -90))
    moved = popup.pos()
    assert popup.is_pinned() and moved == start + QPoint(-380, -90)
    assert moved.x() + popup.width() < view.mapTo(window, QPoint(0, 0)).x() + 120  # mostly beside the picture now
    assert not popup.isHidden() and view.selected == bolts[0].id  # the drag did not click what lies under the card
    # the next part: the card stays where it was put
    view.last_click = QPointF(380, 120)
    view.part_clicked.emit(bolts[1].id)
    assert popup.pos() == moved and popup.part_id == bolts[1].id
    # the keys of the picture still work while the card has the focus
    zoom = view.zoom
    QTest.keyClick(popup, Qt.Key_Plus)
    assert view.zoom > zoom
    # never so far out that its head (and the close button) is lost
    popup.move_card(QPoint(-5000, -5000))
    assert popup.pos().y() >= 0 and popup.pos().x() + popup.width() >= 120
    popup.move_card(QPoint(5000, 5000))
    assert popup.pos().x() <= window.width() - 120 and popup.pos().y() <= window.height() - 48
    # a double click on its head: back to opening beside the part
    QTest.mouseDClick(popup, Qt.LeftButton, Qt.NoModifier, QPoint(60, 18))
    assert not popup.is_pinned() and view.rect().contains(view.mapFrom(window, popup.pos()))
    # it floats over the window: it goes when another tab or page is shown
    page.tabs.setCurrentIndex(0)
    assert popup.isHidden()
    page.tabs.setCurrentWidget(tab)
    view.part_clicked.emit(bolts[0].id)
    window.go("parts")
    assert popup.isHidden()
    window.go("install")
    window.state.dirty = False


def test_a_part_drawn_as_a_box_shows_its_real_shape_when_it_is_picked(window):
    from PySide6.QtCore import QPointF

    tab = window.pages["install"].assembly
    window.resize(1500, 950)
    window.show()
    window.go("install")
    window.pages["install"].tabs.setCurrentWidget(tab)
    wedge = [[[0, 0, 0], [30, 0, 0], [0, 20, 0]], [[0, 0, 0], [0, 20, 0], [0, 0, 25]], [[0, 0, 0], [0, 0, 25], [30, 0, 0]],
             [[30, 0, 0], [0, 0, 25], [0, 20, 0]]]
    lock = a3.Part3D("k1", "กลอน", "ฝาข้าง", "box", dims=[30, 20, 25], pos=[0, 0, 0], step=1, detail=wedge)
    plain = a3.Part3D("k2", "แผ่น", "ฝาข้าง", "box", dims=[300, 200, 5], pos=[100, 0, 0], step=1)
    assert plain.detailed() is plain and lock.detailed().shape == "mesh" and lock.detailed().mesh == wedge
    tab.set_model(a3.AssemblyModel("m", [lock, plain], [a3.Step("ติด")], source="file"))
    view = tab.view
    view.render_image(400, 300)
    assert view._details == {}  # nothing picked: the box, as cheap as before
    view.last_click = QPointF(60, 80)
    view.part_clicked.emit(lock.id)
    view.selected = lock.id
    view.render_image(400, 300)
    assert view._details[lock.id].faces == 4  # the picked part is drawn with its real shape
    alone = tab.popup.mini.model.parts[0]
    assert alone.shape == "mesh" and alone.mesh == wedge  # … and so is the part in its card
    tab.set_model(a3.AssemblyModel("m", [plain], [a3.Step("ติด")], source="file"))
    assert view._details == {}
    tab.rebuild(force=True)
    window.state.dirty = False
