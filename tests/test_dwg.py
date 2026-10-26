import math
import shutil
import stat
import sys
from collections import Counter

import pytest

from conftest import SAMPLES
from partlist_studio.core import dwg_io
from partlist_studio.core.models import Part, PartList


def test_flat_pattern_weight_and_cut_length():
    data = dwg_io.read_drawing(SAMPLES / "RRS-TB-001_side_panel.dxf")
    assert data.title_block["drawing_no"] == "RRS-TB-001"
    assert data.thickness == 3.2
    outers = data.outer_profiles
    assert len(outers) == 1  # the A3 frame and the title block are not parts
    plate = outers[0]
    assert len(plate.holes) == 4
    # 300x150 minus a R20 corner, minus 3 x Ø13 holes and a 60x12 slot
    gross = 300 * 150 - (20 * 20 - 3.14159265 * 20 ** 2 / 4)
    holes = 3 * 3.14159265 * 6.5 ** 2 + 60 * 12 + 3.14159265 * 6 ** 2
    assert plate.net_area == pytest.approx(gross - holes, rel=1e-3)
    assert plate.label == "P1"

    [cand] = dwg_io.drawing_to_candidates(data)
    part = cand.part
    assert part.part_no == "RRS-TB-001" and part.qty == 2 and part.material == "SS400"
    assert part.weight == pytest.approx(dwg_io.plate_weight(plate.net_area, 3.2, 7.85))
    assert part.spec.startswith("t3.2")


def test_bom_drawn_with_text_is_read_in_item_order():
    data = dwg_io.read_drawing(SAMPLES / "RRS-AS-100_tailgate_assembly.dxf")
    assert data.bom_source == "text"
    parts = [c.part for c in dwg_io.drawing_to_candidates(data)]
    assert [p.item_no for p in parts] == ["1", "2", "3", "4", "5"]
    assert parts[4].part_no == "STD-M10-30" and parts[4].qty == 8
    assert all(p.drawing_no == "RRS-AS-100" for p in parts)
    assert "material" not in data.title_block  # "-" in the title block means empty
    assert data.blocks == {"BOLT_M10x30": 8, "HINGE_SUS_120": 2}


def test_blocks_are_optional_candidates():
    data = dwg_io.read_drawing(SAMPLES / "RRS-AS-100_tailgate_assembly.dxf")
    blocks = [c for c in dwg_io.drawing_to_candidates(data, include_blocks=True) if c.source == "block"]
    assert {c.part.name for c in blocks} == {"BOLT_M10x30", "HINGE_SUS_120"}
    assert not any(c.selected for c in blocks)


def test_dxf_table_export_roundtrip(tmp_path):
    pl = PartList(parts=[Part(item_no=str(i), part_no=f"P-{i}", name=f"ชิ้นที่ {i}", material="SS400", qty=i)
                         for i in range(1, 8)])
    path = dwg_io.export_dxf_table(pl, tmp_path / "table.dxf")
    data = dwg_io.read_drawing(path)
    parts = data.bom.to_parts()
    assert [(p.part_no, p.qty) for p in parts] == [(f"P-{i}", i) for i in range(1, 8)]
    assert parts[0].name == "ชิ้นที่ 1"


@pytest.mark.parametrize("text, mm", [("t3.2", 3.2), ("THK 4.5", 4.5), ("SS400 t=6", 6), ("2.3 mm", 2.3),
                                      ("หนา 1.6", 1.6), ("50x50x2.3", 0), ("", 0), ("Thickness=3.00", 3),
                                      ("4 มิลแบบมียาง", 4), ("หนา 9มิล 4 ชิ้น", 9), ("เพิ่มความหนาเป็น4 มิล", 4),
                                      ("T: 2", 2), ("RRS-T001", 0), ("RRS-T-001", 0), ("500 mm", 0),
                                      ("Material=1", 0)])
def test_parse_thickness(text, mm):
    assert dwg_io.parse_thickness(text) == mm


def test_density_lookup():
    assert dwg_io.density_for("SUS304") == 7.93
    assert dwg_io.density_for("A5052") == 2.68
    assert dwg_io.density_for("SS400") == 7.85
    assert dwg_io.density_for("unknown") == dwg_io.STEEL_DENSITY


def test_dwg_without_converter_raises(tmp_path):
    dwg = tmp_path / "x.dwg"
    dwg.write_bytes(b"AC1032")
    with pytest.raises(dwg_io.DrawingError):
        dwg_io.read_drawing(dwg, converter=None)


@pytest.mark.skipif(sys.platform == "win32", reason="uses a POSIX shell script as fake converter")
@pytest.mark.parametrize("kind", ["libredwg", "oda"])
def test_dwg_conversion_with_fake_converter(tmp_path, kind):
    """The converter is called with the right arguments and its DXF output is read."""
    sample = SAMPLES / "RRS-TB-001_side_panel.dxf"
    exe = tmp_path / ("dwg2dxf" if kind == "libredwg" else "ODAFileConverter")
    if kind == "libredwg":  # dwg2dxf -y -o out.dxf in.dwg
        script = f'#!/bin/sh\ncp "{sample}" "$3"\n'
    else:  # ODAFileConverter in_dir out_dir ACAD2018 DXF 0 1 name.dwg
        script = f'#!/bin/sh\nn=$(basename "$7" .dwg)\ncp "{sample}" "$2/$n.dxf"\n'
    exe.write_text(script)
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    dwg = tmp_path / "RRS-TB-001.dwg"
    dwg.write_bytes(b"AC1032 fake")
    conv = dwg_io.find_converter(str(exe))
    assert conv.kind == kind
    data = dwg_io.read_drawing(dwg, conv)
    assert data.file_name == "RRS-TB-001.dwg"
    assert data.title_block["drawing_no"] == "RRS-TB-001"
    assert dwg_io.drawing_record(data, 1).path == str(dwg)


def test_find_converter_custom_missing():
    assert dwg_io.find_converter("/nonexistent/ODAFileConverter") is None


@pytest.mark.skipif(shutil.which("ODAFileConverter") is None, reason="ODA File Converter not installed")
def test_real_oda_roundtrip(tmp_path):
    conv = dwg_io.find_converter()
    dxf = dwg_io.export_dxf_table(PartList(parts=[Part(part_no="A", qty=1)]), tmp_path / "t.dxf")
    dwg = dwg_io.export_dxf_to_dwg(dxf, tmp_path / "t.dwg", conv)
    assert dwg_io.read_drawing(dwg, conv).bom.to_parts()[0].part_no == "A"


def test_repair_values_wrapped_by_converter(tmp_path):
    """LibreDWG dwg2dxf can break a long Thai MTEXT value onto a second line."""
    pl = PartList(parts=[Part(part_no="A", name="แผ่นพื้น", qty=1)])
    path = dwg_io.export_dxf_table(pl, tmp_path / "t.dxf")
    raw = path.read_bytes()
    value = "แผ่นพื้น".encode()
    raw = raw.replace(value, value[:6] + b"\r\n" + value[6:], 1)  # split inside the Thai text
    broken = tmp_path / "broken.dxf"
    broken.write_bytes(raw)
    data = dwg_io.read_drawing(broken)
    assert data.bom.to_parts()[0].name == "แผ่นพื้น"


def test_conflicting_key_values_are_not_title_block(tmp_path):
    import ezdxf

    doc = ezdxf.new()
    msp = doc.modelspace()
    for i, text in enumerate(["Thickness=3.00", "Thickness=4.00", "Material=1", "MATERIAL : SS400"]):
        msp.add_text(text, height=3).set_placement((0, i * 10))
    path = tmp_path / "notes.dxf"
    doc.saveas(path)
    tb = dwg_io.read_drawing(path).title_block
    assert "thickness" not in tb
    assert tb["material"] == "SS400"


def test_bundled_libredwg_is_found(tmp_path, monkeypatch):
    name = "dwg2dxf.exe" if sys.platform == "win32" else "dwg2dxf"
    exe = tmp_path / "libredwg" / name
    exe.parent.mkdir()
    exe.write_text("")
    monkeypatch.setattr(dwg_io, "_oda_candidates", lambda: [])
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    conv = dwg_io.find_converter()
    assert conv.kind == "libredwg" and conv.exe == str(exe)


# --------------------------------------------------------------------------
# Labels of each flat pattern: code, name, thickness
# --------------------------------------------------------------------------
SET = SAMPLES / "RRS-T-SET_frame_parts.dxf"


def test_code_name_thickness_per_flat_pattern():
    data = dwg_io.read_drawing(SET)
    assert data.thickness == 2.3 and len(data.outer_profiles) == 5
    rows = {c.part.part_no: c for c in dwg_io.drawing_to_candidates(data)}
    got = {code: (c.part.name, c.part.thickness, c.thickness_source, c.part.qty) for code, c in rows.items()}
    assert got == {
        "RRS-T-001": ("เฟรมบน", 3, dwg_io.THK_FROM_PART, 16),  # four texts under the part, '16 ชิ้น'
        "RRS-T-002": ("เฟรมล่าง", 3.2, dwg_io.THK_FROM_PART, 2),  # one combined text inside it
        "RRS-T-003": ("แผ่นปิดข้าง", 4, dwg_io.THK_FROM_PART, 4),  # PART_NO / NAME / THK / QTY attributes
        "RRS-T-004": ("ขาจับ", 2, dwg_io.THK_FROM_PART, 1),  # Thickness=2.00 note
        "RRS-T-005": ("ฝาปิดท้าย", 2.3, dwg_io.THK_FROM_TITLE, 1),  # nothing on the part: THK of the title block
    }
    assert {code: (c.qty_source, c.qty_text) for code, c in rows.items()} == {
        "RRS-T-001": (dwg_io.QTY_FROM_PART, "16 ชิ้น"),
        "RRS-T-002": (dwg_io.QTY_FROM_PART, "RRS-T-002 เฟรมล่าง t3.2 2 ชิ้น"),
        "RRS-T-003": (dwg_io.QTY_FROM_PART, "QTY = 4"),
        "RRS-T-004": (dwg_io.QTY_DEFAULT, ""),  # no quantity written: 1, flagged
        "RRS-T-005": (dwg_io.QTY_DEFAULT, ""),
    }
    assert rows["RRS-T-001"].part.drawing_qty == 16 and rows["RRS-T-004"].part.drawing_qty == 0
    assert rows["RRS-T-001"].part.qty_source == "แบบ (ป้ายที่ชิ้นงาน): “16 ชิ้น”"
    p1 = rows["RRS-T-001"].part
    assert p1.spec == "t3 x 150 x 60" and p1.drawing_thickness == 3
    assert p1.weight == pytest.approx(dwg_io.outline_net_area(p1.outline) * 3 * 7.85e-6, abs=2e-3)
    # the label block of RRS-T-003 is not the title block
    assert data.title_block["drawing_no"] == "RRS-T-SET" and data.title_block["name"] == "ชุดเฟรมกระบะ"
    record = dwg_io.drawing_record(data, 5, [c.part for c in rows.values()])
    assert record.thickness == "2, 2.3, 3, 3.2, 4" and record.pieces == 16 + 2 + 4 + 1 + 1


def test_thickness_rule_fixed_and_default(tmp_path):
    data = dwg_io.read_drawing(SET)
    fixed = dwg_io.drawing_to_candidates(data, default_thickness=6, thickness_mode="fixed")
    assert {(c.part.thickness, c.thickness_source) for c in fixed} == {(6, dwg_io.THK_MANUAL)}
    assert sorted(c.part.drawing_thickness for c in fixed) == [2, 2.3, 3, 3.2, 4]  # what the drawing said is kept

    import ezdxf

    doc = ezdxf.new()
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (100, 0), (100, 50), (0, 50)], close=True)
    msp.add_lwpolyline([(200, 0), (300, 0), (300, 50), (200, 50)], close=True)
    msp.add_text("RRS-T-020 แผ่นรอง", height=4).set_placement((10, 20))
    path = tmp_path / "no_thk.dxf"
    doc.saveas(path)
    data = dwg_io.read_drawing(path)
    plain = dwg_io.drawing_to_candidates(data)
    assert {c.thickness_source for c in plain} == {dwg_io.THK_MISSING}
    assert all(c.part.weight == 0 for c in plain)
    filled = dwg_io.drawing_to_candidates(data, default_thickness=2.5)
    assert {(c.part.thickness, c.thickness_source) for c in filled} == {(2.5, dwg_io.THK_DEFAULT)}
    assert filled[0].part.part_no == "RRS-T-020" and filled[0].part.name == "แผ่นรอง"
    assert all(c.part.weight > 0 for c in filled)


def test_labels_inside_a_part_do_not_make_it_a_frame(tmp_path):
    import ezdxf

    doc = ezdxf.new()
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (200, 0), (200, 100), (0, 100)], close=True)
    msp.add_circle((150, 50), 10)
    for i, text in enumerate(["PART NO: RRS-T-010", "NAME: แผ่นพื้น", "THK: 4.5", "QTY: 3"]):
        msp.add_text(text, height=4).set_placement((10, 80 - i * 10))
    path = tmp_path / "labels.dxf"
    doc.saveas(path)
    data = dwg_io.read_drawing(path)
    [prof] = data.outer_profiles
    assert len(prof.holes) == 1
    [cand] = dwg_io.drawing_to_candidates(data)
    assert (cand.part.part_no, cand.part.name, cand.part.thickness, cand.part.qty) == ("RRS-T-010", "แผ่นพื้น", 4.5, 3)


def test_set_part_thickness_keeps_size_and_weight_in_step():
    data = dwg_io.read_drawing(SET)
    part = next(c.part for c in dwg_io.drawing_to_candidates(data) if c.part.part_no == "RRS-T-001")
    w3 = part.weight
    dwg_io.set_part_thickness(part, 4.5)
    assert part.thickness == 4.5 and part.spec == "t4.5 x 150 x 60"
    assert part.weight == pytest.approx(w3 * 1.5, abs=2e-3)
    dwg_io.set_part_thickness(part, 0)
    assert part.spec == "150 x 60" and part.weight == 0
    bom = Part(part_no="X", spec="t2 x 100 x 100", thickness=2, weight=1.0)
    dwg_io.set_part_thickness(bom, 3)  # no flat pattern: weight scales with the thickness
    assert bom.weight == 1.5 and bom.spec == "t3 x 100 x 100"
    assert dwg_io.spec_with_thickness("50x50x2.3", 3) == "50x50x2.3"  # a tube size is left alone
    assert dwg_io.spec_with_thickness("", 3) == "t3"


def test_thickness_column_and_old_files(tmp_path):
    from partlist_studio.core.mapping import match_header

    assert match_header("THK") == "thickness" and match_header("ความหนา") == "thickness"
    assert match_header("ขนาด/ความหนา") == "spec"
    old = {"parts": [{"part_no": "A", "spec": "t3.2 x 300 x 150", "qty": 1}]}
    assert PartList.from_dict(old).parts[0].thickness == 3.2  # saved before the thickness column existed
    pl = PartList(parts=[Part(part_no="B", thickness=2.5, drawing_thickness=3)])
    pl.save(tmp_path / "x.rrspl")
    back = PartList.load(tmp_path / "x.rrspl").parts[0]
    assert (back.thickness, back.drawing_thickness) == (2.5, 3)


# --------------------------------------------------------------------------
# Quantity: '16 ชิ้น' next to a part, 'อย่างละ 2 ชิ้น', general notes
# --------------------------------------------------------------------------
@pytest.mark.parametrize("text, qty", [("16 ชิ้น", 16), ("16ชิ้น", 16), ("จำนวน 16 ชิ้น", 16), ("QTY: 4", 4),
                                       ("1,000 ชิ้น", 1000), ("๑๖ ชิ้น", 16), ("8 pcs", 8), ("หนา 9มิล 4 ชิ้น", 4),
                                       ("M10 2 ชิ้น", 2), ("ชิ้นที่ 3", 0), ("หนา 3 มิล", 0), ("", 0), (None, 0)])
def test_parse_qty(text, qty):
    assert dwg_io.parse_qty(text) == qty


def _read(tmp_path, parts, texts):
    import ezdxf

    doc = ezdxf.new()
    msp = doc.modelspace()
    for x0, y0, w, h in parts:
        msp.add_lwpolyline([(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)], close=True)
    for value, x, y in texts:
        msp.add_text(value, height=5).set_placement((x, y))
    path = tmp_path / "qty.dxf"
    doc.saveas(path)
    data = dwg_io.read_drawing(path)
    return data, [(c.part.qty, c.qty_source) for c in dwg_io.drawing_to_candidates(data)]


def test_qty_next_to_each_part(tmp_path):
    two = [(0, 0, 100, 50), (120, 0, 100, 50)]
    _d, got = _read(tmp_path, two, [("16 ชิ้น", 0, -10), ("ขาจับ 4 ชิ้น", 120, -10)])
    assert got == [(16, dwg_io.QTY_FROM_PART), (4, dwg_io.QTY_FROM_PART)]
    data, _got = _read(tmp_path, two, [("ขาจับ 4 ชิ้น", 120, -10)])
    assert [c.part.name for c in dwg_io.drawing_to_candidates(data)] == ["ชิ้นที่ 1", "ขาจับ"]
    # 'อย่างละ' between two parts: both get it (not only the nearest)
    data, got = _read(tmp_path, two, [("หนา 6 มิล อย่างละ 2 ชิ้น", 60, 60)])
    assert got == [(2, dwg_io.QTY_FROM_PART)] * 2
    assert [c.part.thickness for c in dwg_io.drawing_to_candidates(data)] == [6, 6]


def test_qty_from_general_notes(tmp_path):
    one, two = [(0, 0, 100, 50)], [(0, 0, 100, 50), (200, 0, 100, 50)]
    _d, got = _read(tmp_path, one, [("16 ชิ้น", 400, 400)])  # one part: a note anywhere is its quantity
    assert got == [(16, dwg_io.QTY_FROM_NOTE)]
    _d, got = _read(tmp_path, two, [("อย่างละ 3 ชิ้น", 600, 400)])  # 'each': every part
    assert got == [(3, dwg_io.QTY_FROM_NOTE)] * 2
    _d, got = _read(tmp_path, two, [("8 ชิ้น", 0, -10), ("อย่างละ 3 ชิ้น", 600, 400)])  # its own label wins
    assert got == [(8, dwg_io.QTY_FROM_PART), (3, dwg_io.QTY_FROM_NOTE)]
    data, got = _read(tmp_path, two, [("16 ชิ้น", 600, 400)])  # several parts: which one? not guessed
    assert got == [(1, dwg_io.QTY_DEFAULT)] * 2 and (data.note_qty, data.note_qty_each) == (16, False)
    data, got = _read(tmp_path, one, [("16 ชิ้น", 400, 400), ("8 ชิ้น", 400, 300)])  # two different notes
    assert got == [(1, dwg_io.QTY_DEFAULT)] and data.note_qty == 0


@pytest.mark.parametrize("text, material", [("M=Steel", "Steel"), ("M=aluminium", "Aluminium"), ("m = stainless", "Stainless"),
                                            ('M="SUS304"', "SUS304"), ("MAT: SS400", "SS400"),
                                            ("RRS-T-001 เฟรมบน t3 16 ชิ้น M=Steel", "Steel"),
                                            ("16 ชิ้น", ""), ("M=1", ""), ("Room: A", "")])
def test_parse_material(text, material):
    assert dwg_io.parse_material(text)[0] == material


def test_material_next_to_each_part_and_change_later(tmp_path):
    two = [(0, 0, 100, 50), (120, 0, 100, 50)]
    data, _got = _read(tmp_path, two, [("RRS-T-001 เฟรมบน t3 16 ชิ้น M=Steel", 0, -10),
                                       ("RRS-T-002 ฝาท้าย t2 4 ชิ้น M=Aluminium", 120, -10)])
    cands = dwg_io.drawing_to_candidates(data)
    assert [(c.part.part_no, c.part.name, c.part.qty, c.part.material) for c in cands] == [
        ("RRS-T-001", "เฟรมบน", 16, "Steel"), ("RRS-T-002", "ฝาท้าย", 4, "Aluminium")]  # M= is not part of the name
    assert all(c.material_source == dwg_io.MAT_FROM_PART for c in cands)
    assert "M=Aluminium" in cands[1].part.material_source and cands[1].part.drawing_material == "Aluminium"
    steel, alu = cands[0].part, cands[1].part
    assert alu.weight == pytest.approx(steel.weight * (2 / 3) * 2.70 / 7.85, rel=0.01)  # weighed as aluminium
    # changed later: weighed again, the drawing's value kept to go back to
    assert dwg_io.set_part_material(alu, "Stainless") and alu.material_source.startswith(dwg_io.MAT_MANUAL)
    assert alu.weight == pytest.approx(steel.weight * (2 / 3) * 7.93 / 7.85, rel=0.01)
    assert dwg_io.reset_part_material(alu) and alu.material == "Aluminium" and alu.material_source.startswith("ตามแบบ")
    assert not dwg_io.set_part_material(alu, "Aluminium")  # nothing changed
    from partlist_studio.core.models import Part

    back = Part.from_dict(alu.__dict__ | {})
    assert (back.drawing_material, back.material_source) == (alu.drawing_material, alu.material_source)


def test_material_from_notes_and_title_block(tmp_path):
    two = [(0, 0, 100, 50), (200, 0, 100, 50)]
    data, _got = _read(tmp_path, two, [("M=Stainless", 600, 400)])  # one note for the whole drawing
    assert [(c.part.material, c.material_source) for c in dwg_io.drawing_to_candidates(data)] == [
        ("Stainless", dwg_io.MAT_FROM_NOTE)] * 2
    data, _got = _read(tmp_path, two, [("M=Steel", 0, -10)])  # the label of the first part only
    assert [c.material_source for c in dwg_io.drawing_to_candidates(data)] == [dwg_io.MAT_FROM_PART,
                                                                               dwg_io.MAT_MISSING]
    data, _got = _read(tmp_path, two, [("MATERIAL : SS400", 600, 400), ("M=Aluminium", 0, -10)])
    assert [(c.part.material, c.material_source) for c in dwg_io.drawing_to_candidates(data)] == [
        ("Aluminium", dwg_io.MAT_FROM_PART), ("SS400", dwg_io.MAT_FROM_NOTE)]  # its own label wins
    data, _got = _read(tmp_path, two, [("M=Aluminium", 0, -10)])
    data.title_block["material"] = "SPHC"  # the Title Block is used last
    assert [(c.part.material, c.material_source) for c in dwg_io.drawing_to_candidates(data)] == [
        ("Aluminium", dwg_io.MAT_FROM_PART), ("SPHC", dwg_io.MAT_FROM_TITLE)]
    data, _got = _read(tmp_path, two, [])
    assert {c.material_source for c in dwg_io.drawing_to_candidates(data)} == {dwg_io.MAT_MISSING}


def test_material_line_under_a_stacked_label(tmp_path):
    two = [(0, 200, 150, 60), (300, 200, 150, 60)]
    lines = [(v, 0, 192 - i * 6) for i, v in enumerate(("RRS-T-001", "เฟรมบน", "t=3", "16 ชิ้น", "M=Aluminium"))]
    data, got = _read(tmp_path, two, lines)  # the 5th line is past LABEL_DISTANCE, still the part's own label
    cands = dwg_io.drawing_to_candidates(data)
    assert got[0] == (16, dwg_io.QTY_FROM_PART) and not data.note_material
    assert [(c.part.material, c.material_source) for c in cands] == [("Aluminium", dwg_io.MAT_FROM_PART),
                                                                     ("", dwg_io.MAT_MISSING)]


def test_broken_lines_repaired_before_cutting():
    from partlist_studio.core import cad_fix as cf

    data = dwg_io.read_drawing(SAMPLES / "RRS-T-FIX_broken_lines.dxf")
    kinds = Counter(f.kind for f in data.fixes)
    assert kinds == {cf.FIX_GAP: 2, cf.FIX_OVERSHOOT: 2, cf.FIX_DUPLICATE: 1, cf.FIX_DUP_LOOP: 1, cf.FIX_STRAY: 4,
                     cf.FIX_GLYPH: 1, cf.FIX_BEND: 2, cf.FIX_TEXT: 2, cf.FIX_OPEN: 1}
    cands = {c.part.part_no: c.part for c in dwg_io.drawing_to_candidates(data)}
    assert sorted(cands) == ["RRS-T-101", "RRS-T-102", "RRS-T-104"]  # 103 is 3 mm open: not guessed
    side = cands["RRS-T-101"]
    assert len(side.outline) == 2 and side.spec == "t3 x 300 x 150"  # the round hole kept, '90' and the mark not
    assert side.weight == pytest.approx((300 * 150 - math.pi * 100) * 3 * 7.85e-6, rel=0.01)
    assert side.bend_lines == [[(150.0, 0.0), (150.0, 150.0)], [(230.0, 0.0), (230.0, 150.0)]]
    assert any(t.startswith("ต่อเส้นที่ต่อไม่สนิท 1 จุด (ห่างสุด 0.30") for t in side.cad_fixes)
    assert "ข้อความในชิ้นงาน (ไม่ส่งไปตัด): 90, UP 90° R 0" in side.cad_fixes
    [unfixed] = [f for f in data.fixes if not f.fixed]
    assert data.open_chains == 1 and "ปลายห่าง 3.0 มม." in unfixed.text
    assert {k for k, _pts in data.removed} >= {cf.FIX_BEND, cf.FIX_STRAY, cf.FIX_GLYPH, cf.FIX_OPEN}
    # read as drawn: the side panel falls apart into its bend panels and the letters
    raw = dwg_io.read_drawing(SAMPLES / "RRS-T-FIX_broken_lines.dxf", repair=False)
    assert not raw.fixes and raw.open_chains > 1 and "RRS-T-101" not in {
        c.part.part_no for c in dwg_io.drawing_to_candidates(raw)}
    # wider tolerance: the 3 mm corner is joined too
    wide = dwg_io.read_drawing(SAMPLES / "RRS-T-FIX_broken_lines.dxf", gap_tol=3.5)
    assert "RRS-T-103" in {c.part.part_no for c in dwg_io.drawing_to_candidates(wide)} and wide.open_chains == 0


def test_assembly_drawing_lines_not_repaired():
    data = dwg_io.read_drawing(SAMPLES / "RRS-AS-100_tailgate_assembly.dxf")
    assert data.bom and not data.fixes and data.gap_tol == 0 and "BOM" in data.repair_note


def test_repair_lines_cases():
    from partlist_studio.core import cad_fix as cf

    def rect(x0, y0, w, h):
        return [[(x0, y0), (x0 + w, y0)], [(x0 + w, y0), (x0 + w, y0 + h)], [(x0 + w, y0 + h), (x0, y0 + h)],
                [(x0, y0 + h), (x0, y0)]]

    def run(lines, **kw):
        return cf.repair_lines([(pts, "CUT") for pts in lines], **kw)

    lines = rect(0, 0, 100, 50)
    lines[3] = [(0, 50), (0, 0.3)]
    r = run(lines)
    assert [round(abs(cf.signed_area(p)))for p, _l in r.loops] == [5000] and r.fixes[0].kind == cf.FIX_GAP
    assert not run(lines, gap_tol=0.2).loops  # wider than allowed: left open
    lines = rect(0, 0, 100, 50)
    lines[0] = [(-2, 0), (103, 0)]  # past both corners
    r = run(lines)
    assert len(r.loops) == 1 and [p.spur for p in r.pieces] == [True, True]
    lines = rect(0, 0, 100, 50)
    lines[0], lines[1] = [(0, 0), (105, 0)], [(100, 0.4), (100, 50)]  # stops short of a line running past it
    r = run(lines)
    assert len(r.loops) == 1 and r.fixes[0].kind == cf.FIX_GAP and round(r.fixes[0].size, 1) == 0.4
    r = run(rect(0, 0, 100, 50) + [[(30, 0), (30, 50)]])  # a line across the part from edge to edge: a bend line
    assert len(r.loops) == 1 and r.bends == [((30.0, 0.0), (30.0, 50.0))]
    r = run(rect(0, 0, 100, 50) + rect(40, 20, 10, 10) + [[(0, 25), (40, 25)]])  # a line joining hole and edge
    assert sorted(round(abs(cf.signed_area(p))) for p, _l in r.loops) == [100, 5000] and len(r.pieces) == 1
    r = run(rect(0, 0, 100, 50) + [[(0, 0), (100, 0)]])  # drawn twice
    assert len(r.loops) == 1 and r.fixes[0].kind == cf.FIX_DUPLICATE
    lines = rect(0, 0, 100, 50)
    lines[0], lines[3] = [(-1, 0), (100, 0)], [(0, 50), (0, -1)]  # both lines run on past the corner they cross at
    r = run(lines)
    assert len(r.loops) == 1 and [(p.spur, round(p.length)) for p in r.pieces] == [(True, 1), (True, 1)]


def test_rrs_logo_and_real_holes_are_not_taken_for_letters(tmp_path):
    """Before cutting, letters left in a part are taken out ('90'), but the RRS logo (a honeycomb cut with the
    letters), the stencil lettering of the part (RUNGRUENG), oblong slots and a dimensioned cut-out are cut."""
    import ezdxf

    from partlist_studio.core import cad_fix as cf

    def c_shape(x, y, w, h, t=3):  # a letter-like (concave) closed outline
        return [(x, y), (x + w, y), (x + w, y + t), (x + t, y + t), (x + t, y + h - t), (x + w, y + h - t),
                (x + w, y + h), (x, y + h)]

    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 4  # mm
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (600, 0), (600, 300), (0, 300)], close=True)
    msp.add_text("RRS-T-201", dxfattribs={"height": 8, "insert": (20, 270)})
    for row in range(3):  # the RRS logo: 18 small hexagons packed together, and two pieces of the S among them
        for col in range(6):
            cx, cy = 60 + col * 13 + (6.5 if row % 2 else 0), 150 + row * 11
            msp.add_lwpolyline([(cx + 6 * math.cos(math.radians(a)), cy + 6 * math.sin(math.radians(a)))
                                for a in range(30, 390, 60)], close=True)
    for y in (151, 162):
        msp.add_lwpolyline(c_shape(140, y, 9, 9, 2), close=True)
    for cx in (300, 340):  # two oblong slots 14 x 26 and the bracket cut between them (the เต้า pieces)
        msp.add_lwpolyline([(cx + 7, 140, 0), (cx + 7, 152, 1), (cx - 7, 152, 0), (cx - 7, 140, 1)],
                           format="xyb", close=True)
    msp.add_lwpolyline([(310, 135), (330, 135), (330, 157), (310, 157), (310, 155), (328, 155), (328, 137),
                        (310, 137)], close=True)
    for x in (450, 465):  # two small L-shaped cut-outs: letter-like, but dimensioned
        msp.add_lwpolyline([(x, 140), (x + 10, 140), (x + 10, 143), (x + 3, 143), (x + 3, 155), (x, 155)], close=True)
    msp.add_linear_dim(base=(450, 120), p1=(450, 140), p2=(460, 140)).render()
    for x in (380, 405):  # stencil lettering: big letters, and a G cut in two smaller pieces next to them
        msp.add_lwpolyline(c_shape(x, 210, 20, 32, 4), close=True)
    for y in (210, 227):
        msp.add_lwpolyline(c_shape(430, y, 18, 15, 3), close=True)
    for x in (250, 263):  # '90' left in the part: taken out
        msp.add_lwpolyline(c_shape(x, 50, 10, 15, 2), close=True)
    path = tmp_path / "logo.dxf"
    doc.saveas(path)
    data = dwg_io.read_drawing(path)
    kept = sorted(f.text.split(" – ", 1)[1] for f in data.fixes if f.kind == cf.FIX_KEPT)
    assert kept == ["ตัวอักษรที่ตัดในชิ้นงาน (เช่น RUNGRUENG) – ไม่ลบ", "มีบอกขนาดในแบบ เป็นรูตัดจริง",
                    "โลโก้ RRS (ลวดลายที่ตัดในชิ้นงาน) – ไม่ลบ"]
    [glyph] = [f for f in data.fixes if f.kind == cf.FIX_GLYPH]
    assert glyph.text.startswith("2 ส่วน ขนาด 23x15")  # the '90'
    [part] = [c.part for c in dwg_io.drawing_to_candidates(data) if c.part.part_no == "RRS-T-201"]
    assert len(part.outline) == 1 + 18 + 2 + 2 + 1 + 2 + 2 + 2  # every hole but the '90' is cut
    assert "คงตัวอักษร/ลวดลายที่ตัดในชิ้นงาน (ตัดตามแบบ) 3 จุด" in part.cad_fixes
    assert cf.FIX_KEPT in cf.INFO


def _bracket(msp, x0, y0, w, h, mirror=False, label=""):
    """An L-shaped plate with two holes (not the same seen from the back): w x h at (x0, y0), or its mirror."""
    pts = [(0, 0), (w, 0), (w, 0.4 * h), (0.35 * w, 0.4 * h), (0.35 * w, h), (0, h)]
    holes = [(0.17 * w, 0.75 * h, 5), (0.85 * w, 0.2 * h, 4)]

    def at(x, y):
        return (x0 + (w - x if mirror else x), y0 + y)

    msp.add_lwpolyline([at(x, y) for x, y in pts], close=True)
    for x, y, r in holes:
        msp.add_circle(at(x, y), r)
    if label:
        msp.add_text(label, height=4).set_placement((x0 + w / 2 - 30, y0 + 0.2 * h))


def test_left_and_right_from_pieces_drawn_side_by_side(tmp_path):
    import ezdxf

    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    # one label on the left piece, its mirror image next to it on the right (no label of its own)
    _bracket(msp, 0, 0, 160, 90, label="RRS-T-027 /หูช้าง / t 3 / 2 ชิ้น/")
    _bracket(msp, 230, 0, 160, 90, mirror=True)
    # the same code written on both
    _bracket(msp, 0, 400, 200, 60, label="RRS-T-030 ฉากราวล่าง 1 ชิ้น")
    _bracket(msp, 300, 400, 200, 60, mirror=True, label="RRS-T-030 ฉากราวล่าง 1 ชิ้น")
    # the name says ซ้าย: the piece next to it is ขวา
    _bracket(msp, 0, 800, 130, 130, label="RRS-T-034 หูล็อคฝาท้าย ซ้าย")
    _bracket(msp, 180, 800, 130, 130, mirror=True)
    # one above the other: the drawing does not tell the side
    _bracket(msp, 0, 1200, 240, 70, label="RRS-T-001 /ข้างเฟรมบน / 2 ชิ้น/")
    _bracket(msp, 0, 1300, 240, 70)
    # two plain plates of one size side by side: two parts, no side
    msp.add_lwpolyline([(0, 1600), (100, 1600), (100, 1650), (0, 1650)], close=True)
    msp.add_lwpolyline([(150, 1600), (250, 1600), (250, 1650), (150, 1650)], close=True)
    msp.add_text("RRS-T-020 แผ่นรอง", height=4).set_placement((10, 1620))
    path = tmp_path / "sides.dxf"
    doc.saveas(path)
    data = dwg_io.read_drawing(path)
    cands = dwg_io.drawing_to_candidates(data)
    got = [(c.part.part_no, c.part.name, c.part.qty, c.part.thickness, c.side_source) for c in cands]
    layout, pair = dwg_io.SIDE_FROM_LAYOUT, dwg_io.SIDE_FROM_PAIR
    assert got[:6] == [
        ("RRS-T-001", "ข้างเฟรมบน", 2, 0, ""),
        ("RRS-T-020", "แผ่นรอง", 1, 0, ""),
        ("RRS-T-027", "หูช้าง (ซ้าย)", 1, 3, layout),  # 2 ชิ้น for the pair: ซ้าย 1 + ขวา 1
        ("RRS-T-027", "หูช้าง (ขวา)", 1, 3, layout),  # the copy takes the code, name and thickness
        ("RRS-T-030", "ฉากราวล่าง (ซ้าย)", 1, 0, layout),
        ("RRS-T-030", "ฉากราวล่าง (ขวา)", 1, 0, layout),
    ]
    assert got[6:8] == [("RRS-T-034", "หูล็อคฝาท้าย ซ้าย", 1, 0, ""), ("RRS-T-034", "หูล็อคฝาท้าย (ขวา)", 1, 0, pair)]
    assert [(g[0], g[4]) for g in got[8:]] == [("", "")] * 2  # the copy under ข้างเฟรมบน, the second plate
    left, right = cands[2], cands[3]
    assert left.part.side_source == f"{layout}: ชิ้นที่วางฝั่งซ้าย = ซ้าย (L)"
    assert right.part.side_source == f"{layout}: ชิ้นที่วางฝั่งขวา = ขวา (R)"
    assert left.qty_source == dwg_io.QTY_FROM_PAIR
    assert left.qty_text == "RRS-T-027 /หูช้าง / t 3 / 2 ชิ้น/ = ซ้าย 1 + ขวา 1"
    assert right.part.weight == left.part.weight > 0 and right.part.drawing_box[0] > left.part.drawing_box[2]
    assert cands[7].part.side_source.endswith("ชิ้นคู่เป็นข้างซ้าย = ขวา (R)")
    saved = tmp_path / "sides.rrspl"
    PartList(parts=[left.part, right.part]).save(saved)
    back = PartList.load(saved).parts
    assert [(p.name, p.drawing_box, p.side_source) for p in back] == [
        (p.name, p.drawing_box, p.side_source) for p in (left.part, right.part)]
