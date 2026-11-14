"""นำเข้า IGES / STEP เข้าคู่มือประกอบ 3 มิติ: the test files are made here with OpenCascade itself (skipped without it).

The measurement on a big file is not part of the normal run:
    RRS_CAD_MEASURE=600 python -m pytest -q -p no:cacheprovider tests/test_cad_import.py -k measure -s
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from partlist_studio.core import assembly3d as a3
from partlist_studio.core import cad_import as ci

pytest.importorskip("OCP")
np = pytest.importorskip("numpy")

ROOT = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- files made with OpenCascade
def _ext(text: str):
    from OCP.TCollection import TCollection_ExtendedString

    return TCollection_ExtendedString(text, True)


def _box(x, y, z, lx, ly, lz):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), lx, ly, lz).Shape()


def _cylinder(x, y, z, r, h):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1)), r, h).Shape()


def _sphere(x, y, z, r):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeSphere(gp_Pnt(x, y, z), r).Shape()


def _faces(shape) -> list:
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    exp, out = TopExp_Explorer(shape, TopAbs_FACE), []
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def _open_box(x, y, z, lx, ly, lz, gap=0.0) -> list:
    """The six faces of a box as separate rectangles, each drawn `gap` short of its edges (surfaces that do
    not quite meet, as in a careless IGES)."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
    from OCP.gp import gp_Pnt

    lo, hi = (x, y, z), (x + lx, y + ly, z + lz)
    out = []
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        for side, w in ((0, lo[axis]), (1, hi[axis])):
            corners = [(lo[u] + gap, lo[v] + gap), (hi[u] - gap, lo[v] + gap), (hi[u] - gap, hi[v] - gap), (lo[u] + gap, hi[v] - gap)]
            pts = []
            for a, b in (corners if side else reversed(corners)):  # counter-clockwise seen from outside
                p = [0.0, 0.0, 0.0]
                p[axis], p[u], p[v] = w, a, b
                pts.append(gp_Pnt(*p))
            out.append(BRepBuilderAPI_MakeFace(BRepBuilderAPI_MakePolygon(*pts, True).Wire()).Face())
    return out


def _location(x=0.0, y=0.0, z=0.0, turn=0.0):
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
    from OCP.TopLoc import TopLoc_Location

    move, rot = gp_Trsf(), gp_Trsf()
    move.SetTranslation(gp_Vec(x, y, z))
    if turn:
        rot.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), turn)
    return TopLoc_Location(move.Multiplied(rot))


class _Doc:
    """An XDE document: shapes with a name, a colour and a layer, and assemblies of them."""

    def __init__(self):
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFDoc import XCAFDoc_DocumentTool

        self.doc = TDocStd_Document(_ext("XmlXCAF"))
        self.shapes = XCAFDoc_DocumentTool.ShapeTool_s(self.doc.Main())
        self.colours = XCAFDoc_DocumentTool.ColorTool_s(self.doc.Main())
        self.layers = XCAFDoc_DocumentTool.LayerTool_s(self.doc.Main())

    def describe(self, label, name="", colour=None, layer=""):
        from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
        from OCP.TDataStd import TDataStd_Name
        from OCP.XCAFDoc import XCAFDoc_ColorGen

        if name:
            TDataStd_Name.Set_s(label, _ext(name))
        if colour:
            self.colours.SetColor(label, Quantity_Color(*colour, Quantity_TOC_sRGB), XCAFDoc_ColorGen)
        if layer:
            self.layers.SetLayer(label, _ext(layer))
        return label

    def part(self, shape, name="", colour=None, layer=""):
        return self.describe(self.shapes.AddShape(shape, False), name, colour, layer)

    def assembly(self, name):
        return self.describe(self.shapes.NewShape(), name)

    def place(self, assembly, part, **where):
        return self.shapes.AddComponent(assembly, part, _location(**where))

    def write_step(self, path) -> Path:
        from OCP.STEPCAFControl import STEPCAFControl_Writer
        from OCP.STEPControl import STEPControl_AsIs

        self.shapes.UpdateAssemblies()
        writer = STEPCAFControl_Writer()
        writer.SetNameMode(True)
        writer.SetColorMode(True)
        assert writer.Transfer(self.doc, STEPControl_AsIs)
        writer.Write(str(path))
        return Path(path)

    def write_iges(self, path) -> Path:
        from OCP.IGESCAFControl import IGESCAFControl_Writer

        writer = IGESCAFControl_Writer()
        for mode in (writer.SetNameMode, writer.SetColorMode, writer.SetLayerMode):
            mode(True)
        assert writer.Transfer(self.doc)
        assert writer.Write(str(path))
        return Path(path)


def _tray(path) -> Path:
    """TRAY ─ SUBFRAME ─ 2 × คานตามยาว (red) + 4 × CROSS_MEMBER (blue);  TRAY ─ 3 × BOLT_M12, each turned."""
    d = _Doc()
    root, sub = d.assembly("TRAY"), d.assembly("SUBFRAME")
    rail = d.part(_box(0, 0, 0, 2600, 50, 100), "คานตามยาว", (1, 0, 0))
    cross = d.part(_box(0, 0, 0, 40, 1800, 75), "CROSS_MEMBER", (0, 0.5, 1))
    bolt = d.part(_cylinder(20, 0, 0, 6, 40), "BOLT_M12")
    for y in (-450, 400):
        d.place(sub, rail, y=y)
    for i in range(4):
        d.place(sub, cross, x=100 + 700 * i, y=-900, z=100)
    d.place(root, sub, z=10)
    for i in range(3):
        d.place(root, bolt, x=200 * i, z=300, turn=1.5707963267948966 * i)
    return d.write_step(path)


def _write_iges(path, shapes, solids=True, unit="MM") -> Path:
    """`solids`: as manifold solids (type 186); else every shape given is written as it is - give faces and the
    file holds trimmed surfaces (type 144) only, all at the top level, as a CAD system writes them."""
    from OCP.IGESControl import IGESControl_Writer

    writer = IGESControl_Writer(unit, 1 if solids else 0)
    for s in shapes:
        writer.AddShape(s)
    writer.ComputeModel()
    assert writer.Write(str(path))
    return Path(path)


def _write_step(path, shape, unit="MM") -> Path:
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    STEPControl_Writer()  # the first one makes the settings exist
    Interface_Static.SetCVal_s("write.step.unit", unit)
    try:
        writer = STEPControl_Writer()
        writer.Transfer(shape, STEPControl_AsIs)
        writer.Write(str(path))
    finally:
        Interface_Static.SetCVal_s("write.step.unit", "MM")
    return Path(path)


def _compound(shapes):
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    compound, builder = TopoDS_Compound(), BRep_Builder()
    builder.MakeCompound(compound)
    for s in shapes:
        builder.Add(compound, s)
    return compound


SHAPES = (((0, 0, 0), (100, 50, 20)), ((200, 0, 0), (230, 30, 30)), ((0, 200, 0), (500, 210, 60)), ((275, 275, 0), (325, 325, 80)))
VOLUMES = (100000.0, 27000.0, 300000.0, 3.141592653589793 * 25 * 25 * 80)


def _four_shapes() -> list:
    return [_box(0, 0, 0, 100, 50, 20), _box(200, 0, 0, 30, 30, 30), _box(0, 200, 0, 500, 10, 60), _cylinder(300, 300, 0, 25, 80)]


# --------------------------------------------------------------------------- what is asked of a model
def _volume(part: a3.Part3D) -> float:
    """Signed: positive when the triangles wind outwards."""
    t = np.array(part.mesh)
    return float(np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() / 6)


def _box_of(part: a3.Part3D) -> tuple:
    lo, hi = part.bounds()
    return tuple(round(v, 1) + 0.0 for v in lo), tuple(round(v, 1) + 0.0 for v in hi)


def _close(a, b, tol=0.1) -> bool:
    return all(abs(x - y) <= tol for p, q in zip(a, b) for x, y in zip(p, q))


def _check(model: a3.AssemblyModel, max_faces: int = 60000) -> None:
    """What every imported model must be: in the budget, ready for the view, the same after a save."""
    boxes = sum(1 for p in model.parts if p.shape == "box")
    assert a3.face_count(model) + ci.BOX_FACES * boxes <= max_faces
    assert model.source == "file" and model.problems() == [] and len(model.steps) == len(model.groups())
    assert all(p.step > 0 and p.group and p.name and any(abs(v) > 1 for v in p.explode) for p in model.parts)
    for p in model.parts:
        assert p.shape in ("mesh", "box") and p.color.startswith("#") and len(p.color) == 7
        if p.shape == "mesh":
            flat = [c for f in p.mesh for pt in f for c in pt]
            assert all(len(f) == 3 for f in p.mesh) and all(abs(c * 100 - round(c * 100)) < 1e-6 for c in flat)  # 0.01 mm
            if p.cull:
                assert _volume(p) > 0
    assert a3.AssemblyModel.from_dict(json.loads(json.dumps(model.to_dict()))).to_dict() == model.to_dict()


# --------------------------------------------------------------------------- STEP
def test_step_assembly_names_colours_instances(tmp_path):
    path = _tray(tmp_path / "กระบะ ford.step")  # a Thai file name, as the real file has
    seen = []
    model, report = ci.read_cad_report(path, progress=lambda stage, fraction: seen.append((stage, fraction)))
    _check(model)
    assert [p.name for p in model.parts] == ["คานตามยาว"] * 2 + ["CROSS_MEMBER"] * 4 + ["BOLT_M12"] * 3
    assert [p.group for p in model.parts] == ["SUBFRAME"] * 6 + ["BOLT_M"] * 3  # the sub-assembly, or the name less its number
    assert [p.color for p in model.parts] == ["#FF0000"] * 2 + ["#0080FF"] * 4 + [a3.STEEL] * 3
    assert [(b.name, b.qty, b.size) for b in model.bom()] == [("คานตามยาว", 2, "2600×100×50"), ("CROSS_MEMBER", 4, "1800×75×40"),
                                                              ("BOLT_M12", 3, "40×12×12")]
    assert [s.title for s in model.steps] == ["ประกอบกลุ่ม SUBFRAME", "ประกอบกลุ่ม BOLT_M"] and model.name == "กระบะ ford"
    # where every instance is: the placement of the sub-assembly and of the part in it, and the bolts turned a quarter each
    assert _box_of(model.parts[0]) == ((0, -450, 10), (2600, -400, 110)) and _box_of(model.parts[1])[0] == (0, 400, 10)
    assert [_box_of(p)[0] for p in model.parts[2:6]] == [(100 + 700 * i, -900, 110) for i in range(4)]
    assert _box_of(model.parts[5])[1] == (2240, 900, 185)
    assert _close(_box_of(model.parts[6]), ((14, -6, 300), (26, 6, 340))) and _close(_box_of(model.parts[7]), ((194, 14, 300), (206, 26, 340)))
    assert _close(_box_of(model.parts[8]), ((374, -6, 300), (386, 6, 340)))
    assert all(p.cull and len(p.mesh) == 12 and abs(_volume(p) - 2600 * 50 * 100) < 1 for p in model.parts[:2])
    assert all(p.cull and 0.9 < _volume(p) / (3.14159 * 36 * 40) < 1.0 for p in model.parts[6:])
    assert report.kind == "STEP" and report.reader == "XDE" and report.unit == "มม." and report.parts == 9 and report.groups == 2
    assert report.bounds == [[0, -900, 10], [2600, 900, 340]] and report.triangles == a3.face_count(model) and report.boxed == 0
    assert "STEP" in model.note and "มม." in model.note and "โครงสร้างชุดประกอบ" in model.note and "solid 9" in model.note
    assert seen[0][0] == "อ่านไฟล์" and seen[-1] == ("เสร็จ", 1.0) and [f for _s, f in seen] == sorted(f for _s, f in seen)
    assert {"แปลงรูปทรง", "แยกชิ้นส่วน", "จัดกลุ่มชิ้นส่วน"} <= {s for s, _f in seen}
    # the round trip through a file, and what the plain call gives
    file = tmp_path / "tray.rrsasm"
    model.save(file)
    assert a3.AssemblyModel.load(file).to_dict() == model.to_dict() and '"cull": true' in file.read_text("utf-8")
    assert ci.read_cad(path).to_dict() == model.to_dict()


def test_step_leaf_with_several_solids_and_thai_in_a_windows_code_page(tmp_path):
    d = _Doc()
    d.part(_compound([_box(0, 0, 0, 300, 40, 40), _box(0, 100, 0, 300, 40, 40), _box(0, 200, 0, 40, 40, 500)]), "โครงกันหัว", (0, 1, 0))
    path = d.write_step(tmp_path / "frame.step")
    model = ci.read_cad(path)
    _check(model)
    # two forms in one leaf: numbered; the same form twice would have kept one name
    assert [p.name for p in model.parts] == ["โครงกันหัว.1", "โครงกันหัว.2", "โครงกันหัว.3"]
    assert model.groups() == ["โครงกันหัว"] and {p.color for p in model.parts} == {"#00FF00"}
    # the same file as a CAD program on Thai Windows may write it: the name in code page 874, not UTF-8
    data = path.read_bytes()
    assert "โครงกันหัว".encode("utf-8") in data
    legacy = tmp_path / "frame874.step"
    legacy.write_bytes(data.replace("โครงกันหัว".encode("utf-8"), "โครงกันหัว".encode("cp874")))
    assert [p.name for p in ci.read_cad(legacy).parts] == [p.name for p in model.parts]


def test_text_repairs():
    assert ci._fix_text("คาน") == "คาน" and ci._fix_text("RAIL_1") == "RAIL_1" and ci._fix_text("") == ""
    assert ci._fix_text("คาน".encode("cp874").decode("latin-1")) == "คาน"
    assert ci._fix_text("คาน".encode("utf-8").decode("latin-1")) == "คาน"
    assert ci._fix_text("คาน".encode("utf-8").decode("latin-1").encode("utf-8").decode("latin-1")) == "คาน"
    assert ci._fix_text("Ø50") == "Ø50"  # one accented letter is not Thai
    assert ci._clean("  CROSS \n MEMBER ") == "CROSS MEMBER" and ci._clean("=>[0:1:1:5]") == "" and ci._clean("SOLID") == ""
    assert ci._garbled("¤ҹ") and not ci._garbled("คาน A1")
    assert ci.is_cad_file("a.STEP") and ci.is_cad_file("พื้น.igs") and not ci.is_cad_file("a.obj") and ci.have_ocp()


# --------------------------------------------------------------------------- IGES
def test_iges_solids(tmp_path):
    model, report = ci.read_cad_report(_write_iges(tmp_path / "solids.igs", _four_shapes()))
    _check(model)
    assert report.kind == "IGES" and report.unit == "มม." and report.loose_faces == 0 and "solid 4" in model.note
    assert len(model.parts) == 4 and sorted(p.name for p in model.parts) == [f"ชิ้นที่ {n}" for n in (1, 2, 3, 4)]
    by_name = {p.name: p for p in model.parts}
    for n, (box, volume) in enumerate(zip(SHAPES, VOLUMES), 1):
        part = by_name[f"ชิ้นที่ {n}"]
        assert _close(part.bounds(), box) and part.cull and 0.97 < _volume(part) / volume <= 1.0001
    # no names, no levels, no tree: by size, the bigger first
    assert model.groups() == [ci.SIZE_GROUPS[1], ci.SIZE_GROUPS[2]] and by_name["ชิ้นที่ 2"].group == ci.SIZE_GROUPS[2]
    assert "ขนาด" in model.note


def test_iges_trimmed_surfaces_only_are_sewn_into_parts(tmp_path):
    faces = [f for s in _four_shapes() for f in _faces(s)]
    path = _write_iges(tmp_path / "surfaces.igs", faces, solids=False)
    text = path.read_text("latin-1")
    kinds = {line[:8].strip() for line in text.splitlines() if line[72:73] == "D"}
    assert "144" in kinds and "186" not in kinds and "402" not in kinds  # trimmed surfaces only: no solid, no group
    model, report = ci.read_cad_report(path)
    _check(model)
    assert report.loose_faces == 21 and report.faces_in_file == 21 and len(model.parts) == 4
    assert "เย็บผิวอิสระ 21 ผิว" in model.note and "ได้ 4 เปลือก" in model.note
    found = sorted(model.parts, key=lambda p: p.bounds()[0][1] * 1000 + p.bounds()[0][0])
    for part, box, volume in zip(found, SHAPES, VOLUMES):
        # sewn shut and wound outwards, though the file never said these faces were one solid
        assert _close(part.bounds(), box) and part.cull and 0.97 < _volume(part) / volume <= 1.0001
    assert sorted(len(p.mesh) for p in model.parts)[:3] == [12, 12, 12]


def test_iges_names_colours_levels(tmp_path):
    d = _Doc()
    d.part(_box(0, 0, 0, 254, 50.8, 25.4), "RAIL_1", (1, 0, 0), "7")
    d.part(_box(0, 300, 0, 254, 50.8, 25.4), "RAIL_2", (1, 0, 0), "7")
    d.part(_cylinder(300, 300, 0, 25, 80), "BOLT", (0, 1, 0), "9")
    path = d.write_iges(tmp_path / "named.igs")
    model = ci.read_cad(path)
    _check(model)
    assert [(p.name, p.group, p.color) for p in model.parts] == [("RAIL_1", "RAIL", "#FF0000"), ("RAIL_2", "RAIL", "#FF0000"),
                                                                 ("BOLT", "BOLT", "#00FF00")]
    assert _close(model.parts[1].bounds(), ((0, 300, 0), (254, 350.8, 25.4))) and all(p.cull for p in model.parts)
    # Thai names: IGES has bytes, not letters - UTF-8 and the Windows code page 874 both come through
    data = path.read_bytes()
    assert b"6HRAIL_1" in data and b"6HRAIL_2" in data
    for encoding, first, second in (("cp874", "คานยาว", "คานสอง"), ("utf-8", "คน", "กบ")):
        assert len(first.encode(encoding)) == len(second.encode(encoding)) == 6  # IGES counts the bytes of a text
        file = tmp_path / f"thai_{encoding}.igs"
        file.write_bytes(data.replace(b"6HRAIL_1", b"6H" + first.encode(encoding)).replace(b"6HRAIL_2", b"6H" + second.encode(encoding)))
        assert [p.name for p in ci.read_cad(file).parts] == [first, second, "BOLT"]


def test_unnamed_parts_on_levels_are_grouped_by_level(tmp_path):
    d = _Doc()
    for i in range(3):
        d.part(_box(200 * i, 0, 0, 100, 50, 20), layer="12" if i < 2 else "30")
    model = ci.read_cad(d.write_iges(tmp_path / "levels.igs"))
    _check(model)
    assert [p.group for p in model.parts] == ["เลเยอร์ 12", "เลเยอร์ 12", "เลเยอร์ 30"]
    assert [s.title for s in model.steps] == ["ประกอบกลุ่ม เลเยอร์ 12", "ประกอบกลุ่ม เลเยอร์ 30"]


def _gapped(tmp_path, gap: float, describe=None) -> Path:
    """Five boxes as loose rectangles that stop `gap` short of one another, on cell-centred coordinates."""
    d = _Doc()
    for i in range(5):
        faces = _compound(_open_box(11 + 200 * i, 11, 11, 100, 60, 40, gap))
        d.part(faces, **(describe(i) if describe else {}))
    return d.write_iges(tmp_path / f"gap_{gap}_{bool(describe)}.igs")


def test_loose_surfaces_do_not_become_thousands_of_parts(tmp_path, monkeypatch):
    monkeypatch.setattr(ci, "LOOSE_MAX", 3)  # stands for the 200 of real life
    # 1. gaps a little over the first tolerance: the second, looser sewing closes them
    model = ci.read_cad(_gapped(tmp_path, 0.1))
    _check(model)
    assert len(model.parts) == 5 and "เย็บซ้ำแบบหลวม" in model.note and "ได้อีก 5 เปลือก" in model.note
    assert _close(model.parts[0].bounds(), ((11, 11, 11), (111, 71, 51)), 0.11)
    # 2. gaps no sewing closes: faces whose edges end at the same places are one part
    model = ci.read_cad(_gapped(tmp_path, 0.45))
    _check(model)
    assert len(model.parts) == 5 and "รวมผิวที่ขอบต่อกัน 30 ผิว เป็น 5 ชิ้น" in model.note
    assert all(len(p.mesh) == 12 and not p.cull for p in model.parts)  # open: drawn from both sides
    # 3. … and when that still leaves too many: by IGES level, else by colour
    monkeypatch.setattr(ci, "LOOSE_MAX", 2)
    monkeypatch.setattr(ci, "LINK_GRID", 0.01)  # nothing links
    model = ci.read_cad(_gapped(tmp_path, 0.45, lambda i: {"layer": "5" if i < 3 else "8"}))
    _check(model)
    assert len(model.parts) == 2 and "รวมผิวตาม level ของ IGES 30 ผิว เป็น 2 ชิ้น" in model.note
    assert sorted(len(p.mesh) for p in model.parts) == [24, 36] and model.groups() == ["เลเยอร์ 5", "เลเยอร์ 8"]
    model = ci.read_cad(_gapped(tmp_path, 0.45, lambda i: {"colour": (1, 0, 0) if i < 1 else (0, 0, 1)}))
    assert sorted((p.color, len(p.mesh)) for p in model.parts) == [("#0000FF", 48), ("#FF0000", 12)] and "รวมผิวตามสี" in model.note
    # 4. nothing to tell them apart: one part of all the single faces - none is dropped
    model = ci.read_cad(_gapped(tmp_path, 0.45))
    _check(model)
    assert len(model.parts) == 1 and len(model.parts[0].mesh) == 60 and "รวมผิวเดี่ยวที่เหลือเป็นชิ้นเดียว 30 ผิว" in model.note
    # few loose faces are a part each (a floor plate drawn as one surface is a real part)
    monkeypatch.setattr(ci, "LOOSE_MAX", 200)
    model = ci.read_cad(_gapped(tmp_path, 0.45))
    assert len(model.parts) == 30 and "ผิวเดี่ยว 30 ผิว เป็นชิ้นละผิว" in model.note


# --------------------------------------------------------------------------- units
def test_inch_and_metre_files_come_out_in_mm(tmp_path):
    inch, report = ci.read_cad_report(_write_iges(tmp_path / "inch.igs", _four_shapes(), unit="IN"))
    assert " 1HG" not in "" and report.unit == "นิ้ว" and "หน่วยในไฟล์: นิ้ว → มม." in inch.note
    assert "2HIN" in (tmp_path / "inch.igs").read_text("latin-1")[:800]  # the file really is in inches: 100 mm is 3.937 there
    by_name = {p.name: p for p in inch.parts}
    assert all(_close(by_name[f"ชิ้นที่ {n}"].bounds(), box) for n, box in enumerate(SHAPES, 1))
    surfaces = ci.read_cad(_write_iges(tmp_path / "inch_s.igs", [f for s in _four_shapes() for f in _faces(s)], solids=False, unit="IN"))
    assert len(surfaces.parts) == 4 and _close(surfaces.bounds(), ((0, 0, 0), (500, 325, 80)))  # sewn with a tolerance in mm
    for unit, name, said in (("M", "metre", "เมตร"), ("INCH", "inch", "นิ้ว"), ("MM", "mm", "มม.")):
        path = _write_step(tmp_path / f"{name}.step", _box(0, 0, 0, 2600, 1960, 300), unit)
        text = path.read_text("latin-1")
        assert ("(0.,0.,0.3)" in text) == (unit == "M") and ("CONVERSION_BASED_UNIT('INCH'" in text) == (unit == "INCH")
        model, report = ci.read_cad_report(path)
        assert report.unit == said and report.bounds == [[0, 0, 0], [2600, 1960, 300]] and model.parts[0].size == "2600×1960×300"
        assert abs(_volume(model.parts[0]) - 2600 * 1960 * 300) < 1


# --------------------------------------------------------------------------- the budget
def _spheres(tmp_path, count=60) -> Path:
    balls = [_sphere(100 * (i % 10), 100 * (i // 10), 0, 10 + i) for i in range(count)]  # radius 10 … 69 mm
    return _write_iges(tmp_path / "spheres.igs", balls)


def test_face_budget_meshes_coarser_then_boxes_the_smallest_and_drops_nothing(tmp_path):
    path = _spheres(tmp_path)
    fine, report = ci.read_cad_report(path)
    _check(fine)
    assert len(fine.parts) == 60 and report.level == 0 and report.boxed == 0 and report.triangles > 30000
    # 1. a smaller budget: the same parts, a coarser mesh, still spheres
    model, report = ci.read_cad_report(path, max_faces=8000)
    _check(model, 8000)
    assert len(model.parts) == 60 and 0 < report.level and report.boxed == 0 and report.triangles <= 8000
    assert all(p.shape == "mesh" and p.cull and len(p.mesh) >= 40 for p in model.parts) and f"ระดับ {report.level + 1}/4" in model.note
    ball = min(model.parts, key=lambda p: p.bounds()[1][2])  # the smallest: still within 12 % of a sphere of 10 mm
    assert 0.6 < _volume(ball) / (4 / 3 * 3.14159 * 1000) <= 1.0 and _close(ball.bounds(), ((-10, -10, -10), (10, 10, 10)), 1.5)
    # 2. under what the coarsest mesh needs: the smallest are shown as their boxes, and the note says how many
    coarsest = ci.read_cad_report(path, max_faces=4000)[1].triangles
    budget = coarsest // 2
    model, report = ci.read_cad_report(path, max_faces=budget)
    _check(model, budget)
    boxes = [p for p in model.parts if p.shape == "box"]
    assert len(model.parts) == 60 and report.level == 3 and 0 < len(boxes) == report.boxed < 60
    assert f"แสดงชิ้นเล็ก {len(boxes)} ชิ้น" in model.note and "เป็นกล่อง" in model.note and all("กล่อง" in p.note for p in boxes)
    assert max(p.dims[0] for p in boxes) < min(p.bounds()[1][0] - p.bounds()[0][0] for p in model.parts if p.shape == "mesh")
    assert all(abs(p.dims[0] - p.dims[1]) < 2 and 19 < p.dims[0] < 140 for p in boxes)  # where the sphere was, as big as it was
    assert sorted(p.name for p in model.parts) == sorted(p.name for p in fine.parts)  # nothing dropped
    # 3. a budget that not even boxes fit in: refused with the number to ask for, not a model with parts missing
    with pytest.raises(ci.CadImportError, match="60 ชิ้น.*720 หน้า"):
        ci.read_cad(path, max_faces=500)


def test_closed_and_winding_of_a_mesh():
    cube = np.array(a3.Part3D("x", "x", "x", "mesh", mesh=[[list(p) for p in f] for f, _e in a3.box_faces(10, 20, 30)]).mesh)
    tris = np.concatenate([cube[:, [0, 1, 2]], cube[:, [0, 2, 3]]])
    assert ci._closed(tris) == (True, pytest.approx(6000.0))
    assert ci._closed(tris[:, ::-1]) == (True, pytest.approx(-6000.0))  # inside out: closed, to be turned
    assert not ci._closed(tris[1:])[0]  # a hole
    turned = tris.copy()
    turned[0] = turned[0, ::-1]
    assert not ci._closed(turned)[0]  # one face the wrong way round: no culling


# --------------------------------------------------------------------------- files that cannot be read
def test_empty_broken_and_wrong_files(tmp_path):
    cases = {"empty.igs": b"", "empty.step": b"", "text.igs": b"this is not IGES\n" * 40, "cut.step": b"ISO-10303-21;\nHEADER;\nFILE_DESC",
             "zip.stp": b"PK\x03\x04" + bytes(range(256)) * 20}
    for name, data in cases.items():
        (tmp_path / name).write_bytes(data)
        with pytest.raises(ci.CadImportError) as e:
            ci.read_cad(tmp_path / name)
        assert name in str(e.value) and ("ว่างเปล่า" in str(e.value)) == (not data)
    good = _tray(tmp_path / "good.step").read_bytes()
    (tmp_path / "half.step").write_bytes(good[:len(good) // 2])  # a download that stopped half way
    with pytest.raises(ci.CadImportError):
        ci.read_cad(tmp_path / "half.step")
    with pytest.raises(ci.CadImportError, match="ไม่พบไฟล์"):
        ci.read_cad(tmp_path / "missing.igs")
    with pytest.raises(ci.CadImportError, match="ไม่รู้จักชนิดไฟล์"):
        ci.read_cad(tmp_path / "model.dwg")
    # curves only (a sketch exported by mistake): said, not an empty model
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.gp import gp_Pnt

    lines = _write_iges(tmp_path / "lines.igs", [BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0), gp_Pnt(100, 0, 0)).Edge()], solids=False)
    with pytest.raises(ci.CadImportError, match="ไม่พบผิวหรือชิ้นส่วน"):
        ci.read_cad(lines)
    assert isinstance(ci.CadImportError("x"), ValueError)  # what the tab already catches for OBJ / STL


def test_a_file_too_big_for_the_memory_is_refused_before_it_is_read(tmp_path, monkeypatch):
    path = _write_iges(tmp_path / "big.igs", _four_shapes())
    monkeypatch.setattr(ci, "_free_memory", lambda: 1000)
    with pytest.raises(ci.CadImportError, match="หน่วยความจำ.*big.igs|big.igs.*หน่วยความจำ"):
        ci.read_cad(path)
    monkeypatch.setattr(ci, "_free_memory", lambda: None)  # a system that does not tell: read
    assert len(ci.read_cad(path).parts) == 4
    monkeypatch.undo()
    assert ci._free_memory() is None or ci._free_memory() > 1 << 20
    assert ci.peak_memory_mb() > 50 or sys.platform == "win32"


def test_plain_reader_when_xde_fails(tmp_path, monkeypatch):
    def broken(self, reader):
        raise RuntimeError("no XDE today")

    monkeypatch.setattr(ci._Import, "_transfer_xde", broken)
    for path, parts in ((_tray(tmp_path / "t.step"), 9), (_write_iges(tmp_path / "s.igs", _four_shapes()), 4),
                        (_write_iges(tmp_path / "f.igs", [f for s in _four_shapes() for f in _faces(s)], solids=False), 4)):
        model, report = ci.read_cad_report(path)
        _check(model)
        assert report.reader == "basic" and len(model.parts) == parts and "XDE ล้มเหลว" in model.note
        assert all(p.name.startswith("ชิ้นที่") and p.cull for p in model.parts)  # shapes, placed right; no names
    assert report.bounds == [[0, 0, 0], [500, 325, 80]]


# --------------------------------------------------------------------------- without OpenCascade · the child process
def test_core_imports_and_runs_without_ocp(tmp_path):
    code = ("import sys; sys.modules['OCP'] = None\n"
            "import partlist_studio.core, partlist_studio.core.cad_import as ci, partlist_studio.core.assembly3d as a3\n"
            "assert not ci.have_ocp() and ci.is_cad_file('a.igs')\n"
            "assert a3.build_for_job is not None\n"
            "for call in (ci.read_cad, ci.read_cad_isolated):\n"
            "    try:\n"
            "        call(sys.argv[1])\n"
            "    except ci.CadImportError as e:\n"
            "        assert 'pip install cadquery-ocp' in str(e) and 'ติดตั้ง' in str(e), str(e)\n"
            "    else:\n"
            "        raise SystemExit('read without OCP?')\n"
            "print('fine')\n")
    path = _write_iges(tmp_path / "s.igs", _four_shapes())
    env = dict(os.environ, PYTHONPATH=str(ROOT / "src"))
    done = subprocess.run([sys.executable, "-c", code, str(path)], capture_output=True, text=True, env=env, cwd=str(tmp_path))
    assert done.returncode == 0 and done.stdout.strip() == "fine", done.stderr
    assert "OCP" not in Path(ci.__file__).read_text("utf-8").split("def _occ")[0].replace("โมดูล OCP", "")  # no import at the top


def test_isolated_reader_gives_the_same_model_and_survives_a_crash(tmp_path, monkeypatch):
    path = _tray(tmp_path / "ถาด.step")
    seen = []
    model = ci.read_cad_isolated(path, progress=lambda stage, fraction: seen.append((stage, fraction)))
    assert model.to_dict() == ci.read_cad(path).to_dict() and seen[0][0] == "อ่านไฟล์" and seen[-1] == ("เสร็จ", 1.0)
    assert ci.read_cad_isolated(path, max_faces=200).to_dict() == ci.read_cad(path, max_faces=200).to_dict()
    (tmp_path / "bad.igs").write_bytes(b"junk\n" * 50)
    with pytest.raises(ci.CadImportError, match="bad.igs"):  # the message of the child, word for word
        ci.read_cad_isolated(tmp_path / "bad.igs")
    monkeypatch.setattr(ci, "_CHILD", "import os; print('Segmentation fault'); os._exit(139)")
    with pytest.raises(ci.CadImportError, match="หยุดทำงานกลางคัน.*139.*Segmentation fault"):
        ci.read_cad_isolated(path)
    assert not list(Path(ci.tempfile.gettempdir()).glob("rrs_cad_*.rrsasm"))  # nothing left behind


def test_command_line_tool(tmp_path):
    path = _tray(tmp_path / "tray.step")
    out = tmp_path / "tray.rrsasm"
    tool = [sys.executable, str(ROOT / "tools" / "cad_to_rrsasm.py")]
    done = subprocess.run([*tool, str(path), str(out), "--max-faces", "300"], capture_output=True, text=True, encoding="utf-8")
    assert done.returncode == 0, done.stderr
    model = a3.AssemblyModel.load(out)
    assert len(model.parts) == 9 and a3.face_count(model) <= 300
    for word in ("9 ชิ้น ใน 2 กลุ่ม", "งบ 300", "มม. → โมเดลเป็น มม.", "2,600 × 1,800 × 330", "โครงสร้างชุดประกอบ", "วินาที", "MB", "tray.rrsasm"):
        assert word in done.stdout, word
    assert "อ่านไฟล์" in done.stderr and "100%" in done.stderr and "อ่านไฟล์" not in done.stdout  # progress apart from the summary
    (tmp_path / "bad.igs").write_bytes(b"junk")
    done = subprocess.run([*tool, str(tmp_path / "bad.igs"), str(tmp_path / "bad.rrsasm")], capture_output=True, text=True, encoding="utf-8")
    assert done.returncode == 1 and "นำเข้าไม่ได้" in done.stderr and not (tmp_path / "bad.rrsasm").exists()
    assert (ROOT / "requirements-cad.txt").read_text().split() == ["cadquery-ocp"]


# --------------------------------------------------------------------------- the view and the tab
@pytest.fixture(scope="module")
def app():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_a_closed_imported_box_shows_three_faces_not_six(app, tmp_path):
    from partlist_studio.ui.assembly_view import Assembly3DView

    model = ci.read_cad(_write_step(tmp_path / "box.step", _box(0, 0, 0, 300, 200, 100)))
    part = model.parts[0]
    assert part.cull and len(part.mesh) == 12  # six faces of two triangles
    view = Assembly3DView()
    view.resize(600, 400)
    view.set_model(model)
    for name in ("iso", "iso2", "top", "side"):
        view.set_view(name)
        view.render_image(600, 400)
        assert len(view._drawn) == (2 if name == "side" else 6), name  # three faces towards the camera (side on: one)
        assert view.pick(300, 200) == part.id
    # the faces that are drawn are the near ones: the top (z = 100), never the bottom
    view.set_view("iso")
    view.render_image(600, 400)
    r, u, _d = view._basis()
    drawn = {(round(x), round(y)) for pts, _id in view._drawn for x, y in pts}
    corner = lambda x, y, z: (round(float((np.array([x, y, z]) - view.target) @ r) * view.zoom * 600 / max(view.width(), 1) + 300),  # noqa: E731
                              round(200 - float((np.array([x, y, z]) - view.target) @ u) * view.zoom * 600 / max(view.width(), 1)))
    assert corner(0, 0, 100) in drawn and corner(300, 200, 100) in drawn
    part.cull = False  # as an OBJ / STL comes in: both sides of every face, the far ones painted over
    view.set_model(model)
    view.render_image(600, 400)
    assert len(view._drawn) == 12
    # files saved before there was such a thing still open, and draw as before
    old = model.to_dict()
    for p in old["parts"]:
        del p["cull"]
    back = a3.AssemblyModel.from_dict(json.loads(json.dumps(old)))
    assert back.parts[0].cull is False and back.parts[0].mesh == part.mesh
    assert a3.Part3D("a", "b", "c").cull is False and a3.build_for_job is not None


@pytest.fixture
def window(app, tmp_path):
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    w.go("install")
    yield w
    w.state.dirty = False
    w.close()


def _wait(app, tab, seconds=60.0) -> None:
    end = time.monotonic() + seconds
    while tab._cad_busy and time.monotonic() < end:
        app.processEvents()
        time.sleep(0.01)
    app.processEvents()
    assert not tab._cad_busy, "the CAD reader did not come back"


def test_tab_imports_cad_on_a_worker(app, window, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    from partlist_studio.ui.pages import assembly3d as page

    tab = window.pages["install"].assembly
    for pattern in ("*.step", "*.stp", "*.igs", "*.iges", "*.obj", "*.stl"):
        assert pattern in page.MODEL_FILTER
    before = tab.model
    path = _tray(tmp_path / "กระบะ.step")
    assert tab.import_files([str(path)]) is None and tab._cad_busy == "กระบะ.step"  # at once: the worker reads
    assert tab.model is before and "กำลังนำเข้า กระบะ.step" in tab.note.text()
    assert not tab.import_cad(str(path))  # one at a time
    ticks = 0
    while tab._cad_busy and ticks < 10000:  # the window goes on living while the file is read
        app.processEvents()
        time.sleep(0.005)
        ticks += 1
    _wait(app, tab)
    assert ticks > 3 and tab.model is not before and len(tab.model.parts) == 9 and tab.model.source == "file"
    assert tab.parts.rowCount() == 9 and tab.title.text() == "กระบะ" and "นำเข้าจาก STEP" in tab.note.text()
    assert tab.groups.count() == 3 and not tab._cad_timer.isActive()
    tab.view.resize(700, 500)
    assert not tab.view.render_image(700, 500, fit=True).isNull() and tab.view.face_total() == a3.face_count(tab.model)
    tab.go(1, animate=False)
    assert tab.bom.rowCount() == 2 and tab.bom.item(0, 1).text() == "คานตามยาว" and tab.bom.item(0, 4).text() == "2"
    # a file that cannot be read: told, and the model stays
    said = []
    monkeypatch.setattr(QMessageBox, "warning", lambda _parent, title, text: said.append((title, text)))
    (tmp_path / "bad.igs").write_bytes(b"junk\n" * 30)
    kept, note = tab.model, tab.note.text()
    tab.import_files([str(tmp_path / "bad.igs")])
    _wait(app, tab)
    assert tab.model is kept and tab.note.text() == note and said[-1][0] == "นำเข้าโมเดล" and "bad.igs" in said[-1][1]
    # without OpenCascade: how to install it, and nothing is started
    monkeypatch.setattr(ci, "have_ocp", lambda: False)
    assert tab.import_files([str(path)]) is None and not tab._cad_busy
    assert "pip install cadquery-ocp" in said[-1][1] and tab.model is kept
    # OBJ / STL as before, at once
    obj = tmp_path / "t.obj"
    obj.write_text("o DRAWBAR\nv 0 0 0\nv 1500 0 0\nv 1500 100 0\nf 1 2 3\n", encoding="utf-8")
    assert tab.import_files([str(obj)]) is tab.model and len(tab.model.parts) == 1


# --------------------------------------------------------------------------- measurement (on request)
def _channel(length: float):
    """A C-channel 100 × 50 × 5 with bent corners and four holes in its web: what a truck body is full of."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    edge = getattr(TopoDS, "Edge_s", None) or TopoDS.Edge
    shape = BRepAlgoAPI_Cut(_box(0, 0, 0, length, 50, 100), _box(-1, 5, 5, length + 2, 50, 90)).Shape()
    fillet = BRepFilletAPI_MakeFillet(shape)
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    seen = []
    while exp.More():
        e = exp.Current()
        if not any(e.IsSame(s) for s in seen):
            seen.append(e)
        exp.Next()
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    for e in seen:  # the four long edges of the two bends
        c = BRepAdaptor_Curve(edge(e))
        a, b = c.Value(c.FirstParameter()), c.Value(c.LastParameter())
        if abs(a.X() - b.X()) > length - 1 and min(a.Y(), b.Y()) < 6 and (a.Z() < 6 or a.Z() > 94):
            fillet.Add(4.0 if 4 < a.Y() and 4 < a.Z() < 96 else 9.0, edge(e))
    shape = fillet.Shape()
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    for i in range(4):
        hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(length * (i + 0.5) / 4, -1, 50), gp_Dir(0, 1, 0)), 7, 10).Shape()
        shape = BRepAlgoAPI_Cut(shape, hole).Shape()
    return shape


def _bolt():
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
    from OCP.gp import gp_Pnt, gp_Vec
    import math

    poly = BRepBuilderAPI_MakePolygon()
    for i in range(6):
        poly.Add(gp_Pnt(11 * math.cos(i * math.pi / 3), 11 * math.sin(i * math.pi / 3), 0))
    poly.Close()
    head = BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(poly.Wire()).Face(), gp_Vec(0, 0, 9)).Shape()
    return BRepAlgoAPI_Fuse(head, _cylinder(0, 0, -45, 7, 45)).Shape()


def _moved(shape, x, y, z, turn=0.0, nurbs=False):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert, BRepBuilderAPI_Transform

    shape = BRepBuilderAPI_Transform(shape, _location(x, y, z, turn).Transformation(), True).Shape()
    return BRepBuilderAPI_NurbsConvert(shape, True).Shape() if nurbs else shape


def big_tray(parts: int, nurbs: bool = True) -> list:
    """About `parts` solids laid out like a tray: channels along and across, floor plates, and bolts (2 in 3).
    `nurbs`: every surface as a B-spline, as most CAD systems write IGES (bigger and slower than planes)."""
    rail, cross, bolt, plate = _channel(2600), _channel(1800), _bolt(), _box(0, 0, 0, 1250, 640, 4)
    out = []
    n = 0
    while len(out) < parts:
        deck = 400 * (n // 60)  # one more tray above the last
        k = n % 60
        if k < 2:
            out.append(_moved(rail, 0, 900 * k, deck, nurbs=nurbs))
        elif k < 12:
            out.append(_moved(cross, 250 * (k - 2) + 100, 1900, deck + 110, turn=-1.5707963267948966, nurbs=nurbs))
        elif k < 20:
            out.append(_moved(plate, 1300 * ((k - 12) % 2), 650 * ((k - 12) // 2), deck + 215, nurbs=nurbs))
        else:
            out.append(_moved(bolt, 60 * (k - 20) + 50, 25 + 900 * (k % 2), deck + 150, turn=0.2 * k, nurbs=nurbs))
        n += 1
    return out


@pytest.mark.skipif(not os.environ.get("RRS_CAD_MEASURE"), reason="measurement on request: RRS_CAD_MEASURE=<parts>")
@pytest.mark.parametrize("kind", ["surfaces", "solids"])
def test_measure(tmp_path, kind):
    """Time and peak memory of the command line tool (a process of its own) on a generated tray."""
    parts = int(os.environ["RRS_CAD_MEASURE"])
    start = time.perf_counter()
    shapes = big_tray(parts)
    if kind == "surfaces":
        shapes = [f for s in shapes for f in _faces(s)]
    path = _write_iges(tmp_path / f"big_{kind}.igs", shapes, solids=kind == "solids")
    made = time.perf_counter() - start
    out = tmp_path / "big.rrsasm"
    done = subprocess.run([sys.executable, str(ROOT / "tools" / "cad_to_rrsasm.py"), str(path), str(out)],
                          capture_output=True, text=True, encoding="utf-8")
    print(f"\n=== {kind}: {parts} parts, {path.stat().st_size / 1e6:.1f} MB IGES (made in {made:.0f} s)\n{done.stdout}{done.stderr[-600:]}")
    assert done.returncode == 0
    model = a3.AssemblyModel.load(out)
    assert len(model.parts) == parts and a3.face_count(model) <= 60000
