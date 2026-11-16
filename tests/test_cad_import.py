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
    # solids without a name in a product: called after it, numbered from the biggest, one name for the same item
    assert [p.name for p in model.parts] == ["โครงกันหัว 02", "โครงกันหัว 02", "โครงกันหัว 01"]
    assert [(b.name, b.qty, b.size) for b in model.bom()] == [("โครงกันหัว 02", 2, "300×40×40"),
                                                              ("โครงกันหัว 01", 1, "500×40×40")]
    assert model.groups() == ["โครงกันหัว"] and {p.color for p in model.parts} == {"#00FF00"}
    # the same file as a CAD program on Thai Windows may write it: the name in code page 874, not UTF-8
    data = path.read_bytes()
    assert "โครงกันหัว".encode("utf-8") in data
    legacy = tmp_path / "frame874.step"
    legacy.write_bytes(data.replace("โครงกันหัว".encode("utf-8"), "โครงกันหัว".encode("cp874")))
    assert [p.name for p in ci.read_cad(legacy).parts] == [p.name for p in model.parts]


def test_step_products_are_the_groups_and_nameless_solids_are_named_after_them(tmp_path):
    d = _Doc()
    root, kit, brackets = d.assembly("REAR LIGHTS"), d.assembly("ชุดไฟท้าย"), d.assembly("BRACKET KIT")
    small, big = d.part(_box(0, 0, 0, 60, 40, 5)), d.part(_box(0, 0, 0, 300, 100, 80))
    bolt = d.part(_cylinder(0, 0, 0, 5, 30), "BOLT M10")
    for i in range(3):
        d.place(kit, small, x=100 * i, z=200)
    d.place(kit, big, y=200, z=200)
    d.place(kit, bolt, y=400, z=200)
    d.place(brackets, small)
    d.place(brackets, d.part(_box(0, 0, 0, 500, 50, 50)), y=100)
    d.place(root, kit)
    d.place(root, brackets)
    model, report = ci.read_cad_report(d.write_step(tmp_path / "kit.step"))
    _check(model)
    # a product is a group; the lower one is the first step though the file has it last
    assert model.groups() == ["BRACKET KIT", "ชุดไฟท้าย"]
    assert report.group_counts == [["BRACKET KIT", 2, 24], ["ชุดไฟท้าย", 5, 188]]
    # a solid without a name is called after its product, from the biggest; the one that has a name keeps it
    assert [(p.name, p.group, p.size) for p in model.parts] == [
        ("BRACKET KIT 02", "BRACKET KIT", "60×40×5"), ("BRACKET KIT 01", "BRACKET KIT", "500×50×50"),
        *[("ชุดไฟท้าย 02", "ชุดไฟท้าย", "60×40×5")] * 3, ("ชุดไฟท้าย 01", "ชุดไฟท้าย", "300×100×80"),
        ("BOLT M10", "ชุดไฟท้าย", "30×10×10")]
    assert [(b.name, b.qty) for b in model.bom()] == [("BRACKET KIT 02", 1), ("BRACKET KIT 01", 1), ("ชุดไฟท้าย 02", 3),
                                                    ("ชุดไฟท้าย 01", 1), ("BOLT M10", 1)]
    for word in ("STEP", "ไฟล์ kit.step", "โครงสร้างชุดประกอบ", "BRACKET KIT 2 ชิ้น 24 หน้า", "ชุดไฟท้าย 5 ชิ้น 188 หน้า",
                 "Z ขึ้นตามไฟล์"):
        assert word in model.note, word


def test_step_from_zw3d_a_named_product_with_nameless_bodies_is_one_part(tmp_path):
    d = _Doc()
    root = d.assembly("พื้นเรียบ")
    hook = d.assembly("ตะขอผ้าไบ")  # a part as ZW3D writes it: a named product whose bodies have no name
    d.place(hook, d.part(_box(0, 0, 0, 40, 10, 10)))
    d.place(hook, d.part(_cylinder(0, 0, 20, 5, 30)))
    beam = d.assembly("เต่าที่1")
    d.place(beam, d.part(_box(0, 0, 0, 70, 50, 170)))
    kit = d.assembly("Part004")  # a sub-assembly: its children are parts with names
    bolt = d.assembly("Hex head screw M12")
    d.place(bolt, d.part(_cylinder(0, 0, 0, 6, 65)))
    for x in (0, 500):
        d.place(kit, bolt, x=x)
        d.place(root, hook, x=x, y=900)
    d.place(root, beam, x=-600, y=-630)
    d.place(root, kit, y=-950, z=280)
    model, report = ci.read_cad_report(d.write_step(tmp_path / "zw.step"))
    _check(model)
    # the bodies carry the name of their part, not 'Layer0000 017'; a part of one body has the name as it is
    assert sorted((p.name, p.group) for p in model.parts) == [
        ("Hex head screw M12", "Part004"), ("Hex head screw M12", "Part004"), ("ตะขอผ้าไบ 01", "ตะขอผ้าไบ"),
        ("ตะขอผ้าไบ 01", "ตะขอผ้าไบ"), ("ตะขอผ้าไบ 02", "ตะขอผ้าไบ"), ("ตะขอผ้าไบ 02", "ตะขอผ้าไบ"), ("เต่าที่1", "เต่าที่")]
    assert report.group_counts == [["ตะขอผ้าไบ", 4, 304], ["เต่าที่", 1, 12], ["Part004", 2, 280]]


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
    for i in range(3):  # (OpenCascade's XDE reader keeps the level only of what also has a colour)
        d.part(_box(200 * i, 0, 0, 100, 50, 20), colour=(0.5, 0.5, 0.5), layer="12" if i < 2 else "30")
    model = ci.read_cad(d.write_iges(tmp_path / "levels.igs"))
    _check(model)
    assert [p.group for p in model.parts] == ["Layer 12", "Layer 12", "Layer 30"]  # a level without a name: its number
    assert [p.name for p in model.parts] == ["Layer 12 01", "Layer 12 01", "Layer 30 01"]
    assert [(b.name, b.qty, b.size) for b in model.bom()] == [("Layer 12 01", 2, "100×50×20"),
                                                              ("Layer 30 01", 1, "100×50×20")]
    assert [s.title for s in model.steps] == ["ประกอบกลุ่ม Layer 12", "ประกอบกลุ่ม Layer 30"]


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
    # 3. … and when that still leaves too many: every IGES level is taken by itself anyway, then by colour
    monkeypatch.setattr(ci, "LOOSE_MAX", 2)
    monkeypatch.setattr(ci, "LINK_GRID", 0.01)  # nothing links
    model = ci.read_cad(_gapped(tmp_path, 0.45, lambda i: {"layer": "5" if i < 3 else "8", "colour": (0, 1, 0)}))
    _check(model)
    assert len(model.parts) == 2 and "แยกตาม level ของ IGES 2 level" in model.note
    assert "รวมผิวเดี่ยวที่เหลือเป็นชิ้นเดียว 30 ผิว เป็น 2 ชิ้น" in model.note
    assert sorted(len(p.mesh) for p in model.parts) == [24, 36] and model.groups() == ["Layer 5", "Layer 8"]
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


# --------------------------------------------------------------------------- a real IGES: named levels, patterns, Y up
def _name_levels(path, names: dict, encoding: str = "cp874", newline: bytes = b"\n") -> Path:
    """What ZW3D writes for a level that has a name and OpenCascade's writer does not: a property entity
    (type 406 form 3) on that level, with the name as bytes of the code page of the designer's Windows."""
    lines = Path(path).read_bytes().splitlines()
    start, glob, directory, params = ([line for line in lines if line[72:73] == k] for k in (b"S", b"G", b"D", b"P"))
    for level, name in names.items():
        raw = name.encode(encoding)
        d_no, p_no = len(directory) + 1, len(params) + 1
        params.append((b"406,2,0,%dH%s,0,0;" % (len(raw), raw)).ljust(64) + b" %7dP%7d" % (d_no, p_no))
        directory.append(b"%8d%8d%8d%8d%8d%8d%8d%8d00000000D%7d" % (406, p_no, 0, 0, level, 0, 0, 0, d_no))
        directory.append(b"%8d%8d%8d%8d%8d%24s%8dD%7d" % (406, 0, 0, 1, 3, b"", 0, d_no + 1))
    end = (b"S%7dG%7dD%7dP%7d" % (len(start), len(glob), len(directory), len(params))).ljust(72) + b"T%7d" % 1
    assert all(len(line) == 80 for line in directory + params + [end])
    Path(path).write_bytes(newline.join(start + glob + directory + params + [end]) + newline)
    return Path(path)


def _label_surfaces(path, labels: dict) -> Path:
    """Writes on every trimmed surface (type 144) of a level the label ZW3D gives the faces of one 'shape'."""
    lines = Path(path).read_bytes().splitlines()
    first = None
    for n, line in enumerate(lines):
        if line[72:73] != b"D":
            continue
        if first is None:
            first = line
        else:
            label = labels.get(int(first[32:40])) if int(first[0:8]) == 144 else None
            if label:
                lines[n] = line[:56] + label.encode("ascii").rjust(8) + b" " * 8 + line[72:]  # (no subscript)
            first = None
    Path(path).write_bytes(b"\n".join(lines) + b"\n")
    return Path(path)


def _plate(x, y, z, lx, ly, t, holes=(), radius=5.0):
    """A plate lx × ly × t, drilled through at `holes` [(hx, hy), …] from its corner."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

    plate = _box(x, y, z, lx, ly, t)
    drills = _compound([_cylinder(x + hx, y + hy, z - 1, radius, t + 2) for hx, hy in holes])
    return BRepAlgoAPI_Cut(plate, drills).Shape() if holes else plate


def _chequered(x, y, z, lx, ly, t, bumps) -> object:
    """A plate with raised blocks 12 × 8 × 2 on it, one solid: the embossed pattern of a chequered plate."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse

    shape = _box(x, y, z, lx, ly, t)
    for bx, by in bumps:
        shape = BRepAlgoAPI_Fuse(shape, _box(x + bx, y + by, z + t, 12, 8, 2)).Shape()
    return shape


GRID = [(50 + 100 * i, 50 + 100 * j) for i in range(6) for j in range(4)]  # 24 places on a plate 600 × 400


def test_small_holes_and_patterns_are_left_out_of_a_shape():
    o = ci._occ()

    def mesh(shape) -> tuple[int, float, bool]:
        """Triangles, volume and whether the skin closes, at a mesh as coarse as the importer's coarsest."""
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.BRepTools import BRepTools

        BRepTools.Clean_s(shape)
        BRepMesh_IncrementalMesh(shape, 5.0, False, 1.2, False)
        run = ci._Import("x.step", 1000, None)
        form = ci._Shape(shape, "solid")
        run._triangles(form)
        closed, volume = ci._closed(form.tris)
        return len(form.tris), abs(volume), closed

    # a perforated plate: 24 holes of 10 mm and one opening of 120 mm
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

    plate = BRepAlgoAPI_Cut(_plate(0, 0, 0, 600, 400, 3, GRID), _cylinder(300, 200, -1, 60, 5)).Shape()
    assert len(_faces(plate)) == 6 + 24 + 1
    with_holes = mesh(plate)
    shape, loops, faces = ci._drop_small_loops(o, plate, 30.0)
    assert (loops, faces) == (48, 24) and len(_faces(shape)) == 7  # both rims and the wall of every small hole
    without = mesh(shape)
    assert with_holes[0] > 5 * without[0] and without[2]  # far fewer triangles, and the skin closes again
    assert 720000 - 34000 < without[1] < 720000 - 28000  # filled where the holes were; the opening is there
    assert ci._drop_small_loops(o, plate, 4.0) == (plate, 0, 0)  # nothing under 4 mm: the same shape back
    shape, loops, faces = ci._drop_small_loops(o, plate, 200.0)
    assert (loops, faces) == (50, 25)  # a threshold above the opening takes it too
    # a chequered plate: every raised block is a loop on the top face and five faces above it
    chequer = _chequered(0, 0, 0, 300, 200, 4, [(30 + 60 * i, 30 + 50 * j) for i in range(4) for j in range(3)])
    shape, loops, faces = ci._drop_small_loops(o, chequer, 30.0)
    assert (loops, faces) == (12, 60) and len(_faces(shape)) == 6
    flat = mesh(shape)
    assert flat[0] == 12 and flat[2] and abs(flat[1] - 300 * 200 * 4) < 1
    # what is not a hole stays: a hole 10 mm wide and 100 mm deep has a wall that is no small face …
    block = BRepAlgoAPI_Cut(_box(0, 0, 0, 200, 200, 100), _cylinder(100, 100, -1, 5, 102)).Shape()
    assert ci._drop_small_loops(o, block, 30.0) == (block, 0, 0)
    # … a small part is not eaten through its own hole (the rim is not small beside the face it is in) …
    washer = BRepAlgoAPI_Cut(_cylinder(0, 0, 0, 10, 2), _cylinder(0, 0, -1, 6, 4)).Shape()
    assert ci._drop_small_loops(o, washer, 30.0) == (washer, 0, 0)
    # … and the two rims of a tube are no holes of its wall
    tube = _faces(_cylinder(0, 0, 0, 8, 20))[0]
    assert ci._drop_small_loops(o, tube, 30.0)[1:] == (0, 0)


def _real_tray(tmp_path, name="tray.igs", y_up=True, levels=True) -> Path:
    """A tray as ZW3D writes it, in small: trimmed surfaces only, on named levels, every surface labelled with the
    'shape' it was drawn in ('S1' on the faces of unrelated parts), Y up. Level 3 floor (a chequered plate),
    5 frame (two rails, three cross members), 6 a perforated headboard, 8 two side gates that stand on the floor -
    and no name for level 8."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

    def rotated(shape, axis, angle, shift=(0, 0, 0)):
        turn, move = gp_Trsf(), gp_Trsf()
        turn.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(*axis)), angle)
        move.SetTranslation(gp_Vec(*shift))
        return BRepBuilderAPI_Transform(shape, move.Multiplied(turn), True).Shape()

    def turned(shape):  # drawn Z up here, written Y up: (x, y, z) → (x, z, -y)
        return rotated(shape, (1, 0, 0), -1.5707963267948966) if y_up else shape

    # the headboard: a plate 500 × 1000 × 6 with 9 holes of 8 mm, stood up across the front
    headboard = rotated(_plate(0, 0, 0, 500, 1000, 6, [(250, 100 + 100 * i) for i in range(9)], 4.0), (0, 1, 0),
                        1.5707963267948966, (0, 0, 650))

    d = _Doc()
    grey, blue, green = (0.5, 0.5, 0.5), (0, 0.5, 1), (0, 1, 0)
    for i in range(3):  # written first, though they are fitted after the rails
        d.part(turned(_box(200 + 600 * i, 0, 100, 60, 1000, 50)), "", blue, "5")
    for y in (150, 800):
        d.part(turned(_box(0, y, 0, 1600, 50, 100)), "", blue, "5")
    d.part(turned(headboard), "", grey, "6")
    bumps = [(100 + 150 * i, 100 + 200 * j) for i in range(10) for j in range(4)]
    d.part(turned(_chequered(0, 0, 150, 1600, 1000, 3, bumps)), "", grey, "3")
    for y in (0, 980):
        d.part(turned(_box(6, y, 153, 1594, 20, 250)), "", green, "8")
    path = _label_surfaces(d.write_iges(tmp_path / name), {3: "S1", 5: "S2", 6: "S1", 8: "S1"})
    return _name_levels(path, {3: "พื้น", 5: "โครงตัวล่าง", 6: "ตะแกรงมีลาย", 7: "บานพับหลัง"}) if levels else path


def test_iges_level_names_are_read_from_the_text_of_the_file(tmp_path):
    plain = _real_tray(tmp_path, "plain.igs", levels=False)
    assert ci._iges_level_names(plain) == {}
    names = {3: "พื้น", 5: "โครงตัวล่าง", 12: "Layer0001"}
    for encoding in ("cp874", "utf-8"):  # Thai Windows · a newer CAD program
        path = tmp_path / f"{encoding}.igs"
        path.write_bytes(plain.read_bytes())
        _name_levels(path, names, encoding)
        assert ci._iges_level_names(path) == names
        if encoding == "cp874":
            assert "พื้น".encode("cp874") in path.read_bytes() and "พื้น".encode("utf-8") not in path.read_bytes()
    # Windows line ends; and lines that are not all 80 long (a file that went through an editor): read line by line
    crlf = tmp_path / "crlf.igs"
    crlf.write_bytes(b"\r\n".join(path.read_bytes().splitlines()) + b"\r\n")
    ragged = tmp_path / "ragged.igs"
    lines = path.read_bytes().splitlines()
    ragged.write_bytes(b"\n".join(line + b"  " * (n % 3 == 0) for n, line in enumerate(lines)) + b"\n")
    assert ci._iges_level_names(crlf) == names and ci._iges_level_names(ragged) == names
    assert ci._iges_text("พื้น".encode("cp874")) == ci._iges_text("พื้น".encode("utf-8")) == "พื้น"


def test_iges_levels_are_the_groups_and_parts_are_named_after_them(tmp_path):
    path = _real_tray(tmp_path)
    model, report = ci.read_cad_report(path, up="y")
    _check(model)
    # the groups are the levels under their Thai names, the level without a name keeps its number; bottom-up
    assert model.groups() == ["โครงตัวล่าง", "พื้น", "Layer 8", "ตะแกรงมีลาย"] and report.groups == 4
    assert [s.title for s in model.steps] == [f"ประกอบกลุ่ม {g}" for g in model.groups()]
    assert [p.step for p in model.parts] == [1] * 5 + [2] + [3] * 2 + [4]
    assert report.levels == {3: "พื้น", 5: "โครงตัวล่าง", 6: "ตะแกรงมีลาย", 7: "บานพับหลัง"}
    # sewn level by level: the gates stand on the floor and the headboard against them - still 9 parts, none merged
    assert len(model.parts) == report.parts == 9 and "แยกตาม level ของ IGES 4 level" in model.note
    # no part is called S1 or S2: named after its group, from the biggest, the same item under one name
    assert [p.name for p in model.parts] == [*["โครงตัวล่าง 02"] * 3, *["โครงตัวล่าง 01"] * 2, "พื้น 01", "Layer 8 01",
                                             "Layer 8 01", "ตะแกรงมีลาย 01"]
    assert [(b.name, b.qty, b.size) for b in model.bom()] == [
        ("โครงตัวล่าง 02", 3, "1000×60×50"), ("โครงตัวล่าง 01", 2, "1600×100×50"), ("พื้น 01", 1, "1600×1000×5"),
        ("Layer 8 01", 2, "1594×250×20"), ("ตะแกรงมีลาย 01", 1, "1000×500×6")]
    assert "ป้ายบนผิว" in model.note and not any(p.name.startswith("S") for p in model.parts)
    # the note: file, unit, how the parts were found, the groups with their parts and triangles, the axes
    for word in ("ไฟล์ tray.igs", "หน่วยในไฟล์: มม.", "เย็บผิวอิสระ", "กลุ่ม = level ของ IGES", "โครงตัวล่าง 5 ชิ้น 60 หน้า",
                 "พื้น 1 ชิ้น", "ตะแกรงมีลาย 1 ชิ้น", "Layer 8 2 ชิ้น 24 หน้า", "ต่ำสุดขึ้นไป", "Y ขึ้น เป็น Z ขึ้น (กำหนดเอง)",
                 "การลดรายละเอียด: ตาข่ายระดับ 1/4"):
        assert word in model.note, word
    assert report.group_counts[0] == ["โครงตัวล่าง", 5, 60] and sum(c[2] for c in report.group_counts) == report.triangles
    # with the default budget nothing is left out: the holes of the headboard and the chequers of the floor are there
    assert report.holes == 0 and not report.boxed and report.triangles > 1500
    floor = next(p for p in model.parts if p.group == "พื้น")
    assert len(floor.mesh) > 400 and floor.cull
    # Z is up now: the frame under the floor, the gates and the headboard above it
    assert report.bounds == [[0, 0, 0], [1600, 1000, 650]] and report.up == "y" and not report.up_guessed
    assert _box_of(floor) == ((0, 0, 150), (1600, 1000, 155))
    assert _box_of(model.parts[3]) == ((0, 150, 0), (1600, 200, 100))
    # labels that do name the parts (one label a part, the same label only on the same item) are kept as names
    d = _Doc()
    for i, name in enumerate(("BOLT", "BOLT", "PLATE")):
        d.part(_box(100 * i, 0, 0, 50 + 100 * (name == "PLATE"), 20, 20), name, (1, 0, 0), "4")
    named = _name_levels(d.write_iges(tmp_path / "named_levels.igs"), {4: "ชุดน็อต"})
    model = ci.read_cad(named)
    assert [(p.name, p.group) for p in model.parts] == [("BOLT", "ชุดน็อต"), ("BOLT", "ชุดน็อต"), ("PLATE", "ชุดน็อต")]
    assert "ป้ายบนผิว" not in model.note


def test_up_axis_given_or_guessed(tmp_path):
    y_up, z_up = _real_tray(tmp_path, "y_up.igs"), _real_tray(tmp_path, "z_up.igs", y_up=False)
    as_drawn = ci.read_cad_report(z_up, up="z")
    assert as_drawn[1].bounds == [[0, 0, 0], [1600, 1000, 650]] and "Z ขึ้นตามไฟล์ (กำหนดเอง)" in as_drawn[0].note
    # not said: the floor - a big thin plate with the rest of the model above and below it - tells which way is up
    guessed, report = ci.read_cad_report(y_up)
    assert report.up == "y" and report.up_guessed and report.bounds == as_drawn[1].bounds
    assert "เดาอัตโนมัติ" in guessed.note and "แผ่นพื้นใหญ่ 1,600 × 1,000 มม." in guessed.note and "up=z" in guessed.note
    assert [(p.name, _box_of(p)) for p in guessed.parts] == [(p.name, _box_of(p)) for p in as_drawn[0].parts]
    assert [p.cull for p in guessed.parts] == [p.cull for p in as_drawn[0].parts]
    assert sum(p.cull for p in guessed.parts) == 8
    for p, q in zip(guessed.parts, as_drawn[0].parts):  # turned, not mirrored: the outside is still the outside
        assert _volume(p) == pytest.approx(_volume(q), rel=1e-3) and _volume(q) > 0
    same, report = ci.read_cad_report(z_up)
    assert report.up == "z" and report.up_guessed and report.bounds == as_drawn[1].bounds
    assert "ขวางแกน Z อยู่แล้ว" in same.note
    # said: done, whatever the model looks like; and the model lies on its side when the file was Y up and 'z' was said
    turned, report = ci.read_cad_report(y_up, up="Z")
    assert report.up == "z" and not report.up_guessed and report.bounds == [[0, 0, -1000], [1600, 650, 0]]
    # nothing to go by (a part alone, a gate that may stand or lie): the file is taken as it is, and the note says so
    alone, report = ci.read_cad_report(_write_step(tmp_path / "gate.step", _box(0, 0, 0, 1500, 20, 300)))
    assert report.up == "z" and report.up_guessed and report.bounds == [[0, 0, 0], [1500, 20, 300]]
    assert "up=y" in alone.note and "Y↔Z" in alone.note
    with pytest.raises(ci.CadImportError, match="แกนตั้ง"):
        ci.read_cad(y_up, up="x")
    assert ci.read_cad_isolated(y_up, up="z").to_dict() == turned.to_dict()  # the child process is told too


def test_a_tight_budget_takes_the_patterns_first_then_boxes_small_parts_never_big_ones(tmp_path):
    path = _real_tray(tmp_path)
    full, report = ci.read_cad_report(path, up="y")
    assert report.level == 0 and report.triangles > 2000
    seen = []
    coarse, report = ci.read_cad_report(path, 1500, lambda stage, fraction: seen.append(fraction), "y")
    assert report.level == 2 and report.holes == 0 and 1000 < report.triangles <= 1500  # a coarser mesh will do
    assert seen == sorted(seen) and seen[-1] == 1.0  # the coarsest mesh was tried first: the bar never goes back
    # 1. under what the coarsest mesh needs: the 9 holes of the headboard and the 40 chequers of the floor go,
    #    and every part keeps its shape
    model, report = ci.read_cad_report(path, max_faces=400, up="y")
    _check(model, 400)
    assert report.holes == 18 + 40 and report.hole_faces == 9 + 200 and report.hole_max == pytest.approx(20.0, abs=0.1)
    assert len(model.parts) == 9 and report.boxed == 0
    assert all(p.shape == "mesh" and p.cull for p in model.parts)  # closed skins again, the headboard too
    assert report.triangles == 9 * 12 < a3.face_count(coarse) and not report.over_budget
    for word in ("ตัดรู ช่องเจาะ และลายนูนที่เล็กกว่า 20 มม.", "58 จุด", "ผิวข้างใน 209 ผิว", "ใน 2 ชิ้น", "เหลือ 108 หน้า"):
        assert word in model.note, word
    # names, sizes and places are those of the full model: the size is the true one, with the chequers
    assert [(p.name, p.size, p.group) for p in model.parts] == [(p.name, p.size, p.group) for p in full.parts]
    assert all(_close(a.bounds(), b.bounds(), 2.01) for a, b in zip(model.parts, full.parts))
    # 2. a budget no honest mesh fits in: nothing here is small enough to be a box - given as it is, and said
    model, report = ci.read_cad_report(path, max_faces=60, up="y")
    assert len(model.parts) == 9 and report.boxed == 0 and report.over_budget and report.triangles == 108
    assert "ยังเกินงบ 60 หน้า (ใช้ 108)" in model.note and all(p.shape == "mesh" for p in model.parts)
    # … and one the model is more than four times over: refused
    with pytest.raises(ci.CadImportError, match="9 ชิ้น.*108 หน้า.*--max-faces 10,000"):
        ci.read_cad(path, max_faces=20, up="y")
    # 3. small parts with many faces are the first to be boxes; a plain small part stays what it is
    d = _Doc()
    d.part(_box(0, 0, 0, 800, 400, 20), "BASE", (0.5, 0.5, 0.5), "1")
    holes = [(8 + 8 * i, 8 + 8 * j) for i in range(4) for j in range(4)]
    d.part(_plate(100, 100, 20, 40, 40, 10, holes, 1.5), "LOCK", (1, 0, 0), "1")
    d.part(_box(300, 100, 20, 30, 30, 5), "SHIM", (0, 1, 0), "1")
    model, report = ci.read_cad_report(d.write_iges(tmp_path / "lock.igs"), max_faces=100)
    _check(model, 100)
    assert report.holes == 0  # (its holes of 3 mm go 10 mm deep: more than the 1 % of the model a hole may be)
    assert {p.name: p.shape for p in model.parts} == {"BASE": "mesh", "LOCK": "box", "SHIM": "mesh"}
    lock = next(p for p in model.parts if p.name == "LOCK")
    assert report.boxed == 1 and "แสดงชิ้นเล็ก 1 ชิ้น" in model.note and "กล่อง" in lock.note
    assert lock.dims == [40.0, 40.0, 10.0] and lock.size == "40×40×10"


# --------------------------------------------------------------------------- units
def test_inch_and_metre_files_come_out_in_mm(tmp_path):
    inch, report = ci.read_cad_report(_write_iges(tmp_path / "inch.igs", _four_shapes(), unit="IN"))
    assert report.unit == "นิ้ว" and "หน่วยในไฟล์: นิ้ว → มม." in inch.note
    assert ",1,4HINCH," in (tmp_path / "inch.igs").read_text("latin-1")[:800].replace("\n", "")  # the file really is in inches
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


def test_face_budget_meshes_coarser_then_boxes_only_small_parts_and_drops_nothing(tmp_path):
    path = _spheres(tmp_path)
    fine, report = ci.read_cad_report(path, max_faces=10 ** 6)
    _check(fine, 10 ** 6)
    assert len(fine.parts) == 60 and report.level == 0 and report.boxed == 0
    assert 60000 < report.triangles <= ci.MAX_FACES
    assert ci.read_cad(path).to_dict()["parts"] == fine.to_dict()["parts"]  # the budget of the program holds it
    # 1. a smaller budget: the same parts, a coarser mesh - and the room that is left goes to the biggest
    model, report = ci.read_cad_report(path, max_faces=60000)
    _check(model)
    assert len(model.parts) == 60 and report.level == 1 and report.boxed == 0 and 40000 < report.triangles <= 60000
    assert "ระดับ 2/4" in model.note and "ละเอียดขึ้นหนึ่งระดับ" in model.note and "งบ 60,000" in model.note
    sizes = sorted((p.bounds()[1][2], len(p.mesh)) for p in model.parts)
    assert sizes[-1][1] > 2 * sizes[0][1]  # the big sphere has the finer mesh, the small one the coarser
    # 2. a small budget: the coarsest mesh there is - still spheres, not blobs
    model, report = ci.read_cad_report(path, max_faces=4500)
    _check(model, 4500)
    assert len(model.parts) == 60 and report.level == 3 and report.boxed == 0 and report.triangles <= 4500
    assert all(p.shape == "mesh" and p.cull and len(p.mesh) >= 40 for p in model.parts) and "ระดับ 4/4 (หยาบสุด)" in model.note
    ball = min(model.parts, key=lambda p: p.bounds()[1][2])  # the smallest, 10 mm: its size kept, most of its volume
    assert 0.6 < _volume(ball) / (4 / 3 * 3.14159 * 1000) <= 1.0 and _close(ball.bounds(), ((-10, -10, -10), (10, 10, 10)), 1.5)
    assert ball.size == "20×20×20"  # the true size, not that of the coarse mesh
    coarsest = report.triangles
    # 3. a little under what the coarsest mesh needs: small parts are shown as their boxes, as few as will do
    budget = coarsest - 150
    model, report = ci.read_cad_report(path, max_faces=budget)
    _check(model, budget)
    boxes = [p for p in model.parts if p.shape == "box"]
    assert len(model.parts) == 60 and report.level == 3 and 0 < len(boxes) == report.boxed <= 4
    assert not report.over_budget
    assert f"แสดงชิ้นเล็ก {len(boxes)} ชิ้น" in model.note and "เป็นกล่อง" in model.note and all("กล่อง" in p.note for p in boxes)
    # where the sphere was, as big as it was
    assert all(abs(p.dims[0] - p.dims[1]) < 2 and 19 < p.dims[0] <= ci.BOX_MAX for p in boxes)
    assert sorted(p.name for p in model.parts) == sorted(p.name for p in fine.parts)  # nothing dropped
    # 4. half of it: every sphere up to 45 mm is a box, no bigger one ever is - the model is over its budget and says so
    budget = coarsest // 2
    model, report = ci.read_cad_report(path, max_faces=budget)
    boxes = [p for p in model.parts if p.shape == "box"]
    small = [p for p in fine.parts if p.bounds()[1][0] - p.bounds()[0][0] <= ci.BOX_MAX]
    assert len(model.parts) == 60 and len(boxes) == report.boxed == len(small) == 13
    assert max(p.dims[0] for p in boxes) <= ci.BOX_MAX
    assert report.over_budget and budget < report.triangles + 12 * len(boxes) < coarsest and "ยังเกินงบ" in model.note
    assert all(p.shape == "mesh" and len(p.mesh) >= 40 for p in model.parts if p not in boxes)
    # 5. a budget the model is many times over: refused with the number to ask for, not a model nobody can turn
    with pytest.raises(ci.CadImportError, match="60 ชิ้น.*เกินงบ 500 หน้า.*--max-faces"):
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
    source = Path(ci.__file__).read_text("utf-8").splitlines()
    assert not [line for line in source if line.startswith(("import OCP", "from OCP"))]  # only inside the functions


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
    assert "1%  อ่านไฟล์" in done.stderr and "100%" in done.stderr and "%  " not in done.stdout  # progress apart from the summary
    # an IGES file with levels, drawn Y up: the groups in the order of the steps, the axis, the budget of the program
    tray = str(_real_tray(tmp_path, "y_up.igs"))
    done = subprocess.run([*tool, tray, str(out), "--up", "y"], capture_output=True, text=True, encoding="utf-8")
    assert done.returncode == 0, done.stderr
    for word in ("9 ชิ้น ใน 4 กลุ่ม", f"งบ {ci.MAX_FACES:,}", "Y ของไฟล์ → หมุนเป็น Z ขึ้น (กำหนดเอง)", "1. โครงตัวล่าง",
                 "2. พื้น", "3. Layer 8", "4. ตะแกรงมีลาย", "1,600 × 1,000 × 650", "level ของ IGES"):
        assert word in done.stdout, word
    assert a3.AssemblyModel.load(out).groups() == ["โครงตัวล่าง", "พื้น", "Layer 8", "ตะแกรงมีลาย"]
    done = subprocess.run([*tool, tray, str(out), "--max-faces", "400"], capture_output=True, text=True, encoding="utf-8")
    assert done.returncode == 0 and "(เดาอัตโนมัติ)" in done.stdout and "ตัดรู/ลายนูนเล็กกว่า 20 มม. 58 จุด" in done.stdout
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
    for name, faces in (("iso", 3), ("iso2", 3), ("side", 1), ("top", 2)):  # 'top' looks down 89.9°: the top and a sliver
        view.set_view(name)
        view.render_image(600, 400)
        assert len(view.drawn_faces()) == 2 * faces, name  # only the faces towards the camera, two triangles each
        assert view.pick(300, 200) == part.id
    # the faces that are drawn are the near ones: the top (z = 100), never the bottom
    view.set_view("iso")
    view.render_image(600, 400)
    r, u, _d = view._basis()
    drawn = {(round(x), round(y)) for pts, _id in view.drawn_faces() for x, y in pts}
    corner = lambda x, y, z: (round(float((np.array([x, y, z]) - view.target) @ r) * view.zoom * 600 / max(view.width(), 1) + 300),  # noqa: E731
                              round(200 - float((np.array([x, y, z]) - view.target) @ u) * view.zoom * 600 / max(view.width(), 1)))
    assert corner(0, 0, 100) in drawn and corner(300, 200, 100) in drawn
    part.cull = False  # as an OBJ / STL comes in: both sides of every face, the far ones painted over
    view.set_model(model)
    view.render_image(600, 400)
    assert len(view.drawn_faces()) == 12
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
    assert len(model.parts) == parts and a3.face_count(model) <= ci.MAX_FACES
