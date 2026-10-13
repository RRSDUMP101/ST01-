import shutil
import stat
import sys

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
                                      ("หนา 1.6", 1.6), ("50x50x2.3", 0), ("", 0)])
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
