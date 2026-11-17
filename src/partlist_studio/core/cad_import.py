"""นำเข้าโมเดล CAD จริง (IGES / STEP) เข้าคู่มือประกอบ 3 มิติ – อ่านด้วย OpenCascade (pip install cadquery-ocp → โมดูล OCP).

ไม่ใช้ Qt. OpenCascade is an optional dependency: it is imported when a file is read, so the program (and
`partlist_studio.core`) imports and runs without it. หน่วยของผลลัพธ์ = มม. เสมอ ไม่ว่าไฟล์จะเป็นนิ้ว เมตร หรือ มม.

* `read_cad(path, max_faces, progress, up)` – the file → `AssemblyModel` whose parts are the real parts
* `read_cad_report(...)` – the same, with what was done (`CadReport`: unit, how the parts were found, time)
* `read_cad_isolated(...)` – the same in a child process: OpenCascade keeps Python's lock while it works, so a
  thread alone would still freeze the window; and a crash or out-of-memory there does not take the program down

What is a part
    1. every instance of a leaf of the assembly tree (STEP through XDE: names, colours, placements);
    2. inside a leaf - or in a file without a tree, as IGES usually is - every solid, and every shell that is not
       part of a solid;
    3. faces that belong to no shell (IGES trimmed surfaces, type 144) are sewn (`SEW_TOL`), and every connected
       shell that comes out is a part; when more than `LOOSE_MAX` faces stay alone they are sewn again more
       loosely (`SEW_RETRY_TOL`), then linked by the edges they share (`LINK_GRID`), then put together by
       colour - so that a file of 5,000 loose surfaces does not become 5,000 "parts".
    The surfaces of an IGES file are sewn level by level: what the designer drew on two levels is two parts.
`AssemblyModel.note` tells which of these were used.

Groups and names
    An IGES level is a group, under the name the CAD program gave it (property 406 form 3, read from the text of
    the file: OpenCascade passes on the number only); a STEP product (sub-assembly) is a group. A part keeps the
    name the file gives it. One without a name is called after its group, "<group> 01" from the biggest, and
    parts of one size and one number of faces share a name, so that the parts table counts them. The labels a
    CAD program hangs on single surfaces ("S1" of ZW3D, on the faces of a hundred unrelated parts) are no names.

The view is a software renderer and a .rrsasm is JSON, so the whole model keeps within `max_faces` triangles,
in this order: the parts are meshed coarser as a whole (`LEVELS`: a deflection in proportion to the part); then
the holes, cut-outs and embossed patterns too small to show in a picture of the whole (`HOLE_SHARE`) are left
out - a chequered plate is 10,000 triangles with its pattern and 100 without; then the small parts with the most
triangles (`BOX_MAX`: a lock, a threaded bolt) are shown as their bounding boxes. No part is dropped, nothing
bigger becomes a box: a model that still does not fit is given as it is, and the note says so.

Axes: the program has Z up and X along the vehicle. `up="y"` turns a model drawn with Y up, (x, y, z) → (x, -z, y);
without it the importer turns the model only when a big flat plate (a floor) says so, and the note tells.
"""

from __future__ import annotations

import gc
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import SimpleNamespace

from . import assembly3d as a3

CAD_SUFFIXES = (".step", ".stp", ".igs", ".iges")
INSTALL_HINT = ("โปรแกรมชุดนี้ไม่มีตัวอ่าน STEP / IGES (OpenCascade) – ใช้ตัวติดตั้งรุ่นล่าสุดซึ่งรวมไว้แล้ว "
                "หรือส่งออกจาก CAD เป็น OBJ / STL" if getattr(sys, "frozen", False) else
                "อ่านไฟล์ STEP / IGES ต้องติดตั้ง OpenCascade เพิ่ม (ครั้งเดียว) – เปิด Command Prompt แล้วพิมพ์\n\n"
                "    pip install cadquery-ocp-novtk\n\n"
                "แล้วเปิดโปรแกรมใหม่ · หรือส่งออกจาก CAD เป็น OBJ / STL ซึ่งไม่ต้องติดตั้งอะไรเพิ่ม")
SEW_TOL = 0.05  # mm: the gap between two trimmed surfaces of one part in a healthy IGES
SEW_RETRY_TOL = 0.5  # mm: the second try, for the faces the first left alone (still thinner than any sheet)
LINK_GRID = 2.0  # mm: two loose faces whose edges end and bend at the same places (to this) are one part
LOOSE_MAX = 200  # more single faces than this after sewing: they are grouped instead of being a part each
BOX_FACES = 12  # what a part shown as its bounding box costs
BOX_MAX = 45.0  # mm: only a part no longer than this ("about 40 mm": a bolt, a nut, a lock) may be shown as a box
# The view draws about 100,000 triangles a second: a still picture of a model at the budget takes about 1.2 s,
# half of that when its parts are closed skins (the back faces are skipped), and while it is turned the big
# parts are boxes. Twice the 60,000 of the sample models, because a real tray of 300 parts and 31,000 surfaces
# needs about 110,000 at the coarsest mesh that still shows round tubes and the diamonds of a grating.
MAX_FACES = 120000
OVER_BUDGET = 4  # a model that needs more than this many times its budget is refused, not given
HOLE_SHARE = 0.01  # of the diagonal of the model: holes and patterns under this do not show in a picture of the whole
HOLE_MAX = 40.0  # mm: … and never a hole bigger than this
HOLE_REGION = 400  # faces: what lies behind one hole (its wall, a countersink); more is no hole
SAME_SIZE = 0.5  # mm: two nameless parts whose three sizes differ by less (and with as many faces) are one item
RAW_NAME_SECONDS = 20.0  # the most time spent on looking up IGES names that came through spoiled
# how fine the mesh is: (deflection as a share of the part's size, the most it may be in mm, angle in radians).
# The last one is the floor: a 50 mm bracket keeps its form (a hole is still six-sided), nothing coarser is tried.
LEVELS = ((0.004, 2.0, 0.35), (0.01, 4.0, 0.6), (0.025, 8.0, 0.9), (0.06, 15.0, 1.2))
MIN_DEFLECTION = 0.02
# memory the reader needs: OpenCascade itself, and so much for every byte of the file. Measured on real files -
# a 265 MB IGES of 31,000 trimmed surfaces peaks at 2.06 GB, a 17 MB STEP of 33 solids at 0.51 GB - and on
# generated ones (tests/test_cad_import.py::test_measure). Below this much free memory the file is refused
# before the machine starts to swap or the system kills the program.
MEMORY_BASE = 350e6
MEMORY_PER_BYTE = {"IGES": 7.0, "STEP": 10.0}
BIG, SMALL = 1000.0, 100.0  # mm: parts without a name, a level or an assembly are grouped by their size
GROUPS_IN_NOTE = 30  # the note counts the parts of this many groups, and says how many more there are
SIZE_GROUPS = ("ชิ้นใหญ่ (ยาวกว่า 1 ม.)", "ชิ้นกลาง", "ชิ้นเล็ก (สลัก น็อต แหวน ขายึด)")
_IGES_UNITS = {1: "นิ้ว", 2: "มม.", 4: "ฟุต", 5: "ไมล์", 6: "เมตร", 7: "กม.", 8: "mil (0.001 นิ้ว)", 9: "ไมครอน", 10: "ซม.",
               11: "ไมโครนิ้ว"}
_STEP_PREFIX = {b"$": "เมตร", b".MILLI.": "มม.", b".CENTI.": "ซม.", b".DECI.": "เดซิเมตร", b".MICRO.": "ไมครอน", b".KILO.": "กม."}
_STEP_NAMED = {"INCH": "นิ้ว", "IN": "นิ้ว", "FOOT": "ฟุต", "FT": "ฟุต", "MIL": "mil (0.001 นิ้ว)", "YARD": "หลา"}


class CadImportError(ValueError):
    """The file cannot be imported; the message is for the user (Thai)."""


@dataclass
class CadReport:
    """What `read_cad` did, for the summary of the command line tool and for the tests."""

    path: str = ""
    kind: str = ""  # IGES · STEP
    reader: str = ""  # XDE (names, colours, tree) · basic (shapes only)
    unit: str = ""  # the unit the file was written in (the model is always mm)
    methods: list = field(default_factory=list)  # how the parts were found, in words
    parts: int = 0
    groups: int = 0
    triangles: int = 0
    boxed: int = 0  # small parts shown as their bounding box
    level: int = 0  # index in LEVELS of the mesh that was kept
    holes: int = 0  # small inner loops (holes, cut-outs, patterns) left out of the mesh
    hole_faces: int = 0  # faces behind them (the wall of a hole, the top of a chequer) left out
    hole_max: float = 0.0  # mm: the size under which they were left out
    budget: int = 0  # max_faces
    over_budget: bool = False  # the model has more triangles than the budget: nothing more could honestly go
    up: str = "z"  # the axis of the file that points up: 'y' = the model was turned
    up_guessed: bool = False
    levels: dict = field(default_factory=dict)  # IGES: level number → name, as written in the file
    group_counts: list = field(default_factory=list)  # [group, parts, triangles] in the order of the steps
    faces_in_file: int = 0  # B-rep faces
    loose_faces: int = 0  # of them, faces that were in no shell
    bounds: list = field(default_factory=list)  # [[x0, y0, z0], [x1, y1, z1]] mm
    seconds: dict = field(default_factory=dict)  # stage → seconds
    peak_mb: float = 0.0  # of this process, 0 where it cannot be measured

    def method(self) -> str:
        return " · ".join(self.methods)


def is_cad_file(path: str | Path) -> bool:
    return str(path).lower().endswith(CAD_SUFFIXES)


def have_ocp() -> bool:
    """Is OpenCascade installed? Asked before a file is sent to a worker, so that the answer is the install
    hint; it is only looked for, not loaded (loading it takes a second and 200 MB)."""
    import importlib.util

    try:
        return importlib.util.find_spec("OCP") is not None
    except (ImportError, ValueError):
        return False


# --------------------------------------------------------------------------- OpenCascade, where it differs by version
_OCC: SimpleNamespace | None = None


def _occ() -> SimpleNamespace:
    """Everything used from OpenCascade, imported on first use. Written against cadquery-ocp 7.8 and 8.0: the
    few names that moved between them are looked up here and nowhere else."""
    global _OCC
    if _OCC is not None:
        return _OCC
    try:
        from OCP.Bnd import Bnd_Box
        from OCP.BRep import BRep_Builder, BRep_Tool
        from OCP.BRepAdaptor import BRepAdaptor_Curve
        from OCP.BRepBndLib import BRepBndLib
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.BRepTools import BRepTools
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.IGESCAFControl import IGESCAFControl_Reader
        from OCP.Interface import Interface_Static
        from OCP.Message import Message, Message_Gravity
        from OCP.Quantity import Quantity_Color
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDF import TDF_Label, TDF_Tool
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopAbs import (TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID,
                                TopAbs_VERTEX, TopAbs_WIRE)
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Iterator
        from OCP.XCAFDoc import (XCAFDoc_ColorCurv, XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool,
                                 XCAFDoc_ShapeTool)
        try:
            from OCP.TDF import TDF_LabelSequence  # 7.8
        except ImportError:
            from OCP.collections import Sequence_TDF_Label as TDF_LabelSequence  # 8.0
    except ImportError as e:
        raise CadImportError(INSTALL_HINT) from e
    o = SimpleNamespace(**locals())
    o.face = getattr(TopoDS, "Face_s", None) or TopoDS.Face  # the casts lost their _s in 8.0
    o.edge = getattr(TopoDS, "Edge_s", None) or TopoDS.Edge
    o.vertex = getattr(TopoDS, "Vertex_s", None) or TopoDS.Vertex
    _OCC = o
    return o


def _either(obj, name: str, *args):
    """A method that is static in one version of the binding (`name_s`) and of the object in another."""
    for f in (getattr(obj, name + "_s", None), getattr(obj, name, None)):
        if f is not None:
            try:
                return f(*args)
            except TypeError:
                continue
    raise CadImportError(f"OpenCascade รุ่นนี้ไม่มีคำสั่ง {name} – ใช้ cadquery-ocp 7.8 ขึ้นไป")


def _explore(o, shape, what, avoid=None) -> list:
    exp = o.TopExp_Explorer(shape, what) if avoid is None else o.TopExp_Explorer(shape, what, avoid)
    out = []
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def _matrix(loc):
    """The 3 × 3 turn (with its scale) and the shift of a location; None when it moves nothing."""
    import numpy as np

    if loc is None or loc.IsIdentity():
        return None
    t = loc.Transformation()
    m = np.array([[t.Value(r, c) for c in (1, 2, 3, 4)] for r in (1, 2, 3)])
    return m[:, :3], m[:, 3]


def _quiet(o) -> None:
    """OpenCascade prints its statistics on standard output: only failures are let through."""
    try:
        for printer in o.Message.DefaultMessenger_s().Printers():
            printer.SetTraceLevel(o.Message_Gravity.Message_Fail)
    except Exception:  # noqa: BLE001 - a missing accessor in some version only means more chatter
        pass


def _children(o, shape) -> list:
    it, out = o.TopoDS_Iterator(shape), []
    while it.More():
        out.append(it.Value())
        it.Next()
    return out


def _compound_of(o, shapes):
    compound, builder = o.TopoDS_Compound(), o.BRep_Builder()
    builder.MakeCompound(compound)
    for s in shapes:
        builder.Add(compound, s)
    return compound


def _box_size(o, shapes) -> tuple[float, float, float] | None:
    """The size of the box around shapes, from their geometry (no mesh needed): quick and a little generous.
    Right for edges and wires; far too big for a trimmed face, whose surface reaches beyond its border."""
    box = o.Bnd_Box()
    for s in shapes:
        o.BRepBndLib.Add_s(s, box, False)
    if box.IsVoid():
        return None
    lo, hi = box.CornerMin(), box.CornerMax()
    gap = 2 * box.GetGap()
    return tuple(max(b - a - gap, 0.0) for a, b in ((lo.X(), hi.X()), (lo.Y(), hi.Y()), (lo.Z(), hi.Z())))


# --------------------------------------------------------------------------- small holes and patterns
def _drop_small_loops(o, shape, hole_max: float) -> tuple[object, int, int]:
    """The shape without its small holes, cut-outs and embossed patterns: a new shape of the same faces, less
    the inner loops no bigger than `hole_max` and the small faces behind them (the wall of a hole, the top of
    a chequer). It is what makes a perforated or chequered plate cost a hundred triangles instead of ten
    thousand, and it takes away nothing that shows in a picture of the whole assembly.

    A loop goes only together with everything behind it: when what lies across its edges is not small faces
    closed off by other small loops (a tube welded into the hole, a rim that runs out into the border), it all
    stays. No surface is computed: the faces are put together again from their own wires, so it costs
    nothing and cannot fail. Returns the new shape (the old one when nothing was dropped) and how many loops
    and faces were dropped."""
    faces = _explore(o, shape, o.TopAbs_FACE)
    wires: list[list] = []  # per face: (wire, keys of its edges, size)
    edge_faces: dict[object, list[int]] = {}
    small: list[bool] = []
    loop_at: dict[tuple, int] = {}  # (face, edge) → the droppable loop of the face that holds the edge
    for i, face in enumerate(faces):
        mine, sizes = [], []
        for wire in _children(o, face.Oriented(o.TopAbs_FORWARD)):
            if wire.ShapeType() != o.TopAbs_WIRE:
                continue
            keys = list({e.TShape() for e in _explore(o, wire, o.TopAbs_EDGE)})
            size = _box_size(o, [wire])
            mine.append((wire, keys, math.hypot(*size) if size else math.inf))
            sizes.append(size)
            for k in keys:
                seen = edge_faces.setdefault(k, [])
                if i not in seen:
                    seen.append(i)
        wires.append(mine)
        # (the biggest wire stands for the face: the others lie inside it)
        whole = [max(s[a] for s in sizes) for a in range(3)] if sizes and all(sizes) else None
        small.append(whole is not None and math.hypot(*whole) <= hole_max)
        if len(mine) > 1:
            outer = o.BRepTools.OuterWire_s(o.face(face))
            # a hole is small beside the face it is in: the two rims of a tube are no holes of its wall
            limit = max((w[2] for w in mine if w[0].IsSame(outer)), default=0.0) / 2
            for n, (wire, keys, size) in enumerate(mine):
                if size <= hole_max and size < limit and not wire.IsSame(outer):
                    for k in keys:
                        loop_at[(i, k)] = n
    if not loop_at:
        return shape, 0, 0
    dropped_loops: set[tuple[int, int]] = set()
    dropped_faces: set[int] = set()
    tried: set[tuple[int, int]] = set()
    for start in sorted(set((i, n) for (i, _k), n in loop_at.items())):
        if start in tried:
            continue
        loops, region, todo, fine = {start}, set(), [("loop", start)], True
        while todo and fine:
            kind, item = todo.pop()
            if kind == "loop":
                owner, keys = item[0], wires[item[0]][item[1]][1]
            else:
                owner, keys = item, [k for w in wires[item] for k in w[1]]
            for k in keys:
                for other in edge_faces[k]:
                    if other == owner or other in region:
                        continue
                    n = loop_at.get((other, k))
                    if n is not None:  # the rim of the hole on its other side
                        if (other, n) not in loops:
                            loops.add((other, n))
                            todo.append(("loop", (other, n)))
                    elif small[other] and len(region) < HOLE_REGION:
                        region.add(other)
                        todo.append(("face", other))
                    else:
                        fine = False
        tried |= loops
        if fine and not {i for i, _n in loops} & region:
            dropped_loops |= loops
            dropped_faces |= region
    if not dropped_loops or len(dropped_faces) >= len(faces):
        return shape, 0, 0
    builder, kept = o.BRep_Builder(), []
    for i, face in enumerate(faces):
        if i in dropped_faces:
            continue
        gone = {n for j, n in dropped_loops if j == i}
        if gone:
            new = face.EmptyCopied()
            new.Orientation(o.TopAbs_FORWARD)
            for n, (wire, _keys, _size) in enumerate(wires[i]):
                if n not in gone:
                    builder.Add(new, wire)
            new.Orientation(face.Orientation())
            face = new
        kept.append(face)
    return _compound_of(o, kept), len(dropped_loops), len(dropped_faces)


# --------------------------------------------------------------------------- text
def _fix_text(text: str) -> str:
    """A name that was read byte for byte (Thai written in the Windows code page 874, or UTF-8 taken as
    Latin-1, once or twice) → Thai. One accented letter alone ('Ø50') is left as it is."""
    for _ in range(3):
        if not text or max(map(ord, text)) > 255 or max(map(ord, text)) < 128:
            return text
        raw = text.encode("latin-1")
        try:
            text = raw.decode("utf-8")
            continue
        except UnicodeDecodeError:
            pass
        if sum(b > 127 for b in raw) < 2:
            return text
        try:
            return raw.decode("cp874")
        except UnicodeDecodeError:
            return text
    return text


def _garbled(text: str) -> bool:
    """Letters that are neither ASCII nor Thai: most likely Thai bytes that were decoded as something else."""
    return any(ord(c) > 127 and not 0x0E00 <= ord(c) <= 0x0E7F for c in text)


def _clean(text: str | None) -> str:
    """The name of a label; '' for none and for the names the reader makes up itself."""
    text = re.sub(r"\s+", " ", _fix_text(text or "")).strip()
    if text.startswith("=>[") or text.startswith("Open CASCADE") or text in _MADE_UP:
        return ""
    return text


_DEFAULT_LAYER = re.compile(r"(?i)^(layer\s*\d*|\d+|default)$")  # a layer nobody named
_MADE_UP = {"COMPOUND", "COMPSOLID", "SOLID", "SHELL", "FACE", "WIRE", "EDGE", "VERTEX", "SHAPE", "NAUO", "UNNAMED"}


def _scan_step(path: Path) -> tuple[str, bool]:
    """One pass over the text of a STEP file: the length unit(s) it declares, and whether it holds bytes that are
    not UTF-8 (names written in a Windows code page - the reader must then not convert them)."""
    units: list[str] = []
    legacy = False
    pattern = re.compile(rb"SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)|CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'"
                         rb"|([\x80-\xff][\x80-\xff ]*)")
    with open(path, "rb") as f:
        tail = b""
        while True:
            block = f.read(8 << 20)
            if not block:
                break
            data = tail + block
            for m in pattern.finditer(data):
                if m.group(1):
                    name = _STEP_PREFIX.get(m.group(1), m.group(1).decode("ascii", "replace"))
                elif m.group(2) is not None:
                    name = _STEP_NAMED.get(m.group(2).decode("ascii", "replace").strip().upper(), "")
                else:
                    if not legacy and m.end() < len(data):  # a run cut by the end of the block is seen again
                        try:
                            m.group(3).decode("utf-8")
                        except UnicodeDecodeError:
                            legacy = True
                    continue
                if name and name not in units:
                    units.append(name)
            tail = data[-256:]
    named = [u for u in units if u in _STEP_NAMED.values()]  # an inch is declared as so many mm: the inch is the unit
    return " + ".join(named or units) or "ไม่ระบุ (ถือเป็น มม.)", legacy


def _iges_text(raw: bytes) -> str:
    """Text of an IGES file is bytes: UTF-8 when it is, else Thai of Windows (code page 874, which holds TIS-620)."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp874", "replace")


def _iges_level_names(path: Path) -> dict[int, str]:
    """IGES level number → the name the CAD program gave it. A level is only a number on every entity; its name
    is a property entity of its own (type 406 form 3, 'level function': "406,2,0,6Hfloor,0,0;") that sits on
    that level. OpenCascade reads the numbers and drops the names, so they are taken from the text of the file:
    the directory section (two lines of ten 8-column fields per entity) tells where the parameters are."""
    import numpy as np

    wanted: list[tuple[int, int, int]] = []  # (level, first parameter line, lines)

    def entry(first: bytes, second: bytes) -> None:
        try:
            if int(first[0:8]) == 406 and int(second[32:40] or 0) == 3 and int(first[32:40] or 0) > 0:
                wanted.append((int(first[32:40]), int(first[8:16]), int(second[24:32] or 1)))
        except ValueError:
            pass

    params: dict[int, bytes] = {}
    with open(path, "rb") as f:
        width = len(f.readline())
        size = os.fstat(f.fileno()).st_size
        f.seek(max(size - 200, 0))
        tail = [line for line in f.read().splitlines() if line.strip()]
        # the last line counts the lines of the others: "S      1G      4D  12346P   6789      …      T      1"
        ends = bool(tail) and tail[-1][72:73] == b"T"
        counts = re.match(rb"S\s*(\d+)G\s*(\d+)D\s*(\d+)P\s*(\d+)", tail[-1]) if ends else None
        lines = sum(int(v) for v in counts.groups()) + 1 if counts else 0
        if counts and width in (81, 82) and size in (lines * width, lines * width - (width - 80)):
            # lines of one length (as every writer makes them): the directory is one block, a parameter one seek
            start, glob, directory, _p = (int(v) for v in counts.groups())
            f.seek((start + glob) * width)
            block = np.frombuffer(f.read(directory * width), dtype=np.uint8)
            block = block[:len(block) // (2 * width) * 2 * width].reshape(-1, 2 * width)
            is_406 = (block[:, 5:8] == np.frombuffer(b"406", dtype=np.uint8)).all(axis=1)
            hit = is_406 & (block[:, width + 39] == ord("3"))  # the form, right-justified in its field
            for row in block[hit]:
                entry(row[:width].tobytes(), row[width:].tobytes())
            for _level, first, count in wanted:
                f.seek((start + glob + directory + first - 1) * width)
                for n, line in enumerate(f.read(count * width).splitlines()):
                    params[first + n] = line
        else:  # lines of any length: read through, the directory comes before the parameters
            f.seek(0)
            held = None
            need: set[int] = set()
            for raw in f:
                line = raw.rstrip(b"\r\n")
                kind = line[72:73]
                if kind == b"D":
                    if held is None:
                        held = line
                    else:
                        entry(held, line)
                        held = None
                elif kind == b"P":
                    if not need:
                        need = {first + n for _level, first, count in wanted for n in range(count)}
                        if not need:
                            break
                    try:
                        number = int(line[73:80])
                    except ValueError:
                        continue
                    if number in need:
                        params[number] = line
    names: dict[int, str] = {}
    for level, first, count in wanted:
        data = b"".join(params.get(first + n, b"")[:64] for n in range(count))
        m = re.match(rb"\s*406\s*,[^,]*,[^,]*,\s*(\d+)H", data)
        if m:
            name = _clean(_iges_text(data[m.end():m.end() + int(m.group(1))]))
            if name:
                names.setdefault(level, name)
    return names


def _free_memory() -> int | None:
    """Bytes of memory that can still be used without swapping; None where it cannot be asked."""
    try:
        if sys.platform.startswith("linux"):
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
        elif sys.platform == "win32":
            import ctypes

            class _Status(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                    (n, ctypes.c_ulonglong) for n in ("total", "avail", "t_page", "a_page", "t_virt", "a_virt", "a_ext")]

            status = _Status()
            status.length = ctypes.sizeof(_Status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.avail)
    except Exception:  # noqa: BLE001 - only a safety check
        return None
    return None


def peak_memory_mb() -> float:
    """The most memory this process has held so far (MB); 0 where the system does not tell."""
    try:
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak / (1 << 20) if sys.platform == "darwin" else peak / 1024
    except Exception:  # noqa: BLE001 - Windows has no resource module
        return 0.0


# --------------------------------------------------------------------------- the parts before they are meshed
@dataclass
class _Shape:
    """One form (a solid, a shell, sewn or grouped faces) in its own frame; drawn once, placed many times."""

    shape: object
    how: str  # solid · shell · sewn · face · linked · level · colour · rest
    key: object = None  # its TShape: two instances of one form have the same
    diag: float = 0.0
    faces: int = 0  # as the file has them (before small holes are left out)
    count: int = 0  # triangles at the level that is meshed now
    tris: object = None  # (n, 3, 3) array in its own frame
    cull: bool = False
    box: tuple | None = None  # its true corners (lo, hi) in its own frame
    extent: tuple = (0.0, 0.0, 0.0)  # its true size, the longest side first
    uses: int = 0
    no: int = 0  # 'ชิ้นที่ N' when it has no name and no group to be called after


@dataclass
class _Body:
    """A part: a form at a place, with what the file says about it."""

    form: _Shape
    place: object = None  # TopLoc_Location · None = where it is
    leaf: str = ""  # the label of the tree it came from (+ the instance)
    leaf_name: str = ""
    name: str = ""  # its own name (a named solid or surface inside the leaf)
    parent: str = ""  # the sub-assembly it sits in
    color: str = ""
    layer: str = ""
    boxed: bool = False
    labels: int = -1  # sewn from loose faces: how many different labels they had (-1: no faces, a solid or shell)


@dataclass
class _Pool:
    """Faces of one leaf that are in no shell: sewn together once, placed for every instance of the leaf."""

    faces: list = field(default_factory=list)  # (face, its label, colour, layer, name of the top shape it is in)
    uses: list = field(default_factory=list)  # (place, leaf id, leaf name, parent, colour, layer)


class _Import:
    def __init__(self, path: str | Path, max_faces: int, progress, up: str | None = None):
        self.path = Path(path)
        self.max_faces = max(int(max_faces), BOX_FACES)
        self.progress = progress
        self.up = (up or "").strip().lower() or None  # 'y' · 'z' · None = guessed
        if self.up not in (None, "y", "z"):
            raise CadImportError(f"แกนตั้ง (up) ต้องเป็น y หรือ z – ได้รับ “{up}”")
        self.level_names: dict[int, str] = {}  # IGES: level → its name in the file
        self.model_diag = 0.0
        self.o = _occ()
        self.report = CadReport(str(self.path), budget=self.max_faces)
        self.bodies: list[_Body] = []
        self.forms: dict[object, _Shape] = {}
        self.pools: dict[str, _Pool] = {}
        self.notes: list[str] = []
        self.simplified: list[str] = []  # what was done to keep within the budget, for the note
        self.stage = ""
        self._leaf_cache: dict[str, list] = {}
        self._raw_names: dict[object, str] = {}
        self._raw_spent = 0.0
        self._reader = None
        self._clock = time.perf_counter()
        self._fraction = 0.0
        self.tree = False  # the file has an assembly tree
        self.skipped = 0  # things in the file without a surface (curves, points)
        self.unmeshed = 0  # faces OpenCascade could not mesh

    # ---- progress
    def say(self, stage: str, fraction: float) -> None:
        now = time.perf_counter()
        fraction = self._fraction = max(fraction, self._fraction)  # a mesh tried again does not go backwards
        if stage != self.stage:
            if self.stage:
                self.report.seconds[self.stage] = round(self.report.seconds.get(self.stage, 0.0) + now - self._clock, 2)
            self.stage, self._clock = stage, now
        if self.progress and stage:
            self.progress(stage, min(max(fraction, 0.0), 1.0))

    # ---- 1. the file
    def check_file(self) -> None:
        path = self.path
        suffix = path.suffix.lower()
        if suffix not in CAD_SUFFIXES:
            raise CadImportError(f"ไม่รู้จักชนิดไฟล์ {suffix or path.name} – ต้องเป็น STEP (.step .stp) หรือ IGES (.igs .iges)")
        self.report.kind = "IGES" if suffix in (".igs", ".iges") else "STEP"
        if not path.is_file():
            raise CadImportError(f"ไม่พบไฟล์ {path}")
        size = path.stat().st_size
        if size == 0:
            raise CadImportError(f"ไฟล์ {path.name} ว่างเปล่า (0 ไบต์) – ดาวน์โหลดหรือส่งออกจาก CAD ใหม่")
        free = _free_memory()
        need = MEMORY_BASE + size * MEMORY_PER_BYTE[self.report.kind]
        if free is not None and need > free:
            raise CadImportError(
                f"ไฟล์ {path.name} ใหญ่ {size / 1e6:,.0f} MB ต้องใช้หน่วยความจำราว {need / 1e9:.1f} GB แต่เครื่องเหลือว่าง "
                f"{free / 1e9:.1f} GB – ปิดโปรแกรมอื่น ใช้เครื่องที่มี RAM มากกว่า หรือส่งออกจาก CAD เป็นหลายไฟล์ย่อย")

    def read(self) -> None:
        o, kind = self.o, self.report.kind
        self.say("อ่านไฟล์", 0.01)
        _quiet(o)
        reader = o.IGESCAFControl_Reader() if kind == "IGES" else o.STEPCAFControl_Reader()
        for mode in ("SetNameMode", "SetColorMode", "SetLayerMode"):
            getattr(reader, mode)(True)
        for mode in ("SetPropsMode", "SetGDTMode", "SetMatMode", "SetViewMode", "SetSHUOMode"):
            if hasattr(reader, mode):  # nothing of it is shown: less to build and to keep
                getattr(reader, mode)(False)
        statics = {"xstep.cascade.unit": "MM"}  # whatever the unit of the file, the shapes come in mm
        if kind == "STEP":
            self.report.unit, legacy = _scan_step(self.path)
            statics["read.step.codepage"] = "NoConversion" if legacy else "UTF8"
        before = {k: o.Interface_Static.CVal_s(k) for k in statics}
        naming = o.XCAFDoc_ShapeTool.AutoNaming_s()
        for k, v in statics.items():
            o.Interface_Static.SetCVal_s(k, v)
        o.XCAFDoc_ShapeTool.SetAutoNaming_s(False)  # no made-up 'SOLID', 'COMPOUND' for what has no name
        try:
            if reader.ReadFile(str(self.path)) != o.IFSelect_RetDone:
                raise CadImportError(f"อ่านไฟล์ {self.path.name} ไม่ได้ – ไม่ใช่ไฟล์ {kind} ที่สมบูรณ์ (ไฟล์เสีย ดาวน์โหลดไม่ครบ "
                                     "หรือนามสกุลไม่ตรงกับเนื้อไฟล์)")
            self._reader = reader
            if kind == "IGES":
                self.report.unit = self._iges_unit(reader)
                try:
                    self.level_names = _iges_level_names(self.path)
                except (OSError, ValueError):  # the names are a help, not a need
                    self.level_names = {}
                self.report.levels = dict(self.level_names)
            self.say("แปลงรูปทรง", 0.3)
            doc = None
            try:
                doc = self._transfer_xde(reader)
                self.report.reader = "XDE"
                self.say("แยกชิ้นส่วน", 0.62)
                self._walk_document(doc)
            except CadImportError:
                raise
            except Exception as e:  # noqa: BLE001 - any failure of the XDE reader: the plain one is tried
                self.notes.append(f"ตัวอ่าน XDE ล้มเหลว ({type(e).__name__}) – อ่านเฉพาะรูปทรง ไม่มีชื่อ/สี")
                self.bodies, self.pools, self._leaf_cache, self.forms, self.tree = [], {}, {}, {}, False
            if not self.bodies and not self.pools:
                self.say("แปลงรูปทรง", 0.5)
                self._read_plain(reader)
        finally:
            for k, v in before.items():
                if v:
                    o.Interface_Static.SetCVal_s(k, v)
            o.XCAFDoc_ShapeTool.SetAutoNaming_s(naming)
            self._reader = None
        del reader, doc  # the text of the file and the tree: only the shapes are needed from here on
        self._leaf_cache.clear()
        gc.collect()
        if not self.bodies and not self.pools:
            raise CadImportError(f"ไม่พบผิวหรือชิ้นส่วน 3 มิติในไฟล์ {self.path.name}"
                                 + (f" (มีแต่เส้น/จุด {self.skipped} รายการ)" if self.skipped else ""))

    def _iges_unit(self, reader) -> str:
        try:
            g = reader.IGESModel().GlobalSection()
            flag = g.UnitFlag()
            name = g.UnitName()
            return _IGES_UNITS.get(flag) or (name.ToCString() if name is not None else "") or "ไม่ระบุ (ถือเป็น มม.)"
        except Exception:  # noqa: BLE001 - only for the note
            return "ไม่ทราบ"

    def _transfer_xde(self, reader):
        o = self.o
        doc = o.TDocStd_Document(o.TCollection_ExtendedString("XmlXCAF"))
        if self.report.kind == "IGES" and hasattr(reader, "TransferOneRoot"):
            # root by root, to tell how far it is; the transfer into the document then finds them done
            count = reader.NbRootsForTransfer()
            last = time.perf_counter()
            for i in range(1, count + 1):
                reader.TransferOneRoot(i)
                if time.perf_counter() - last > 0.5:
                    last = time.perf_counter()
                    self.say("แปลงรูปทรง", 0.3 + 0.3 * i / count)
            if hasattr(reader, "ClearShapes"):
                reader.ClearShapes()
        if not reader.Transfer(doc):
            raise RuntimeError("nothing transferred")
        return doc

    def _read_plain(self, reader) -> None:
        """Without XDE: all the shapes of the file as one nameless leaf (the file is not read again)."""
        o = self.o
        plain = reader if self.report.kind == "IGES" else reader.ChangeReader()
        if hasattr(plain, "ClearShapes"):
            plain.ClearShapes()
        plain.TransferRoots()
        shape = plain.OneShape()
        self.report.reader = "basic"
        if shape is None or shape.IsNull():
            return
        for form, inner, _name, _colour, _layer in self._content("root", shape, {}, ("", "", ""), top=True):
            self.bodies.append(_Body(form, inner, "root"))
        self._use("root", o.TopLoc_Location(), "root", "", "")

    # ---- 2. the tree → bodies and pools of loose faces
    def _name(self, label) -> str:
        o = self.o
        if not label.IsAttribute(o.TDataStd_Name.GetID_s()):  # FindAttribute crashes in 8.0 when there is none
            return ""
        attr = o.TDataStd_Name()
        if not label.FindAttribute(o.TDataStd_Name.GetID_s(), attr):
            return ""
        text = attr.Get().ToExtString()
        if self.report.kind == "IGES" and _garbled(text):
            text = self._raw_name(label) or text
        return _clean(text)

    def _raw_name(self, label) -> str:
        """IGES names are bytes; the reader takes them as UTF-8 and spoils Thai of code page 874. The bytes are
        still in the entity the shape came from. Finding that entity is a search through all of them, so it is
        given `RAW_NAME_SECONDS` in all: after that the names stay as the reader gave them."""
        o = self.o
        try:
            shape = o.XCAFDoc_ShapeTool.GetShape_s(label)
            key = shape.TShape()
            if key not in self._raw_names:
                if self._raw_spent > RAW_NAME_SECONDS:
                    return ""
                start = time.perf_counter()
                entity = self._reader.WS().TransferReader().EntityFromShapeResult(shape, 1)
                text = ""
                if entity is not None and hasattr(entity, "HasName") and entity.HasName():
                    h = entity.NameValue()
                    text = "".join(h.Value(i) for i in range(1, h.Length() + 1))  # a byte each, as Latin-1
                self._raw_names[key] = text
                self._raw_spent += time.perf_counter() - start
            return self._raw_names[key]
        except Exception:  # noqa: BLE001 - the name stays as the reader gave it
            return ""

    def _colour(self, label) -> str:
        o = self.o
        colour = o.Quantity_Color()
        for kind in (o.XCAFDoc_ColorSurf, o.XCAFDoc_ColorGen, o.XCAFDoc_ColorCurv):
            if _either(self.colours, "GetColor", label, kind, colour):
                try:
                    return o.Quantity_Color.ColorToHex_s(colour).ToCString().upper()
                except Exception:  # noqa: BLE001 - an older binding: linear RGB → sRGB by hand
                    def srgb(v: float) -> int:
                        v = 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
                        return min(255, max(0, round(v * 255)))
                    return "#%02X%02X%02X" % (srgb(colour.Red()), srgb(colour.Green()), srgb(colour.Blue()))
        return ""

    def _layer(self, label) -> str:
        try:
            names = self.layers.GetLayers(label)
            return _clean(names.Value(1).ToExtString()) if names is not None and names.Length() else ""
        except Exception:  # noqa: BLE001 - no layers in this file
            return ""

    def _entry(self, label) -> str:
        text = self.o.TCollection_AsciiString()
        self.o.TDF_Tool.Entry_s(label, text)
        return text.ToCString()

    def _walk_document(self, doc) -> None:
        o = self.o
        self.shapes = o.XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
        self.colours = o.XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
        self.layers = o.XCAFDoc_DocumentTool.LayerTool_s(doc.Main())
        free = o.TDF_LabelSequence()
        self.shapes.GetFreeShapes(free)
        many = free.Length() > 1
        for i in range(1, free.Length() + 1):
            self._walk(free.Value(i), o.TopLoc_Location(), "", "", "", top=True, many=many, path=str(i))
        del self.shapes, self.colours, self.layers

    def _walk(self, label, loc, parent: str, colour: str, layer: str, top: bool, many: bool, path: str,
              given: str = "") -> None:
        o, tool = self.o, self.o.XCAFDoc_ShapeTool
        name = self._name(label) or given
        colour = self._colour(label) or colour
        layer = self._layer(label) or layer
        if tool.IsAssembly_s(label):
            self.tree = True
            comps = o.TDF_LabelSequence()
            tool.GetComponents_s(label, comps, False)
            refs = []
            for i in range(1, comps.Length() + 1):
                comp, ref = comps.Value(i), o.TDF_Label()
                if tool.GetReferredShape_s(comp, ref):
                    refs.append((i, comp, ref))
            # ZW3D writes a part as a named product that holds its bodies as nameless shapes: that is one part
            # with that name, not a group of nameless parts
            is_part = bool(name) and not (top and not many) and bool(refs) and all(
                not tool.IsAssembly_s(ref) and not self._name(ref) and not self._name(comp) for _i, comp, ref in refs)
            below = name if (not top or many) else ""  # the one top assembly is the whole thing, not a group
            for i, comp, ref in refs:
                self._walk(ref, loc.Multiplied(tool.GetLocation_s(comp)), parent if is_part else (below or parent),
                           self._colour(comp) or colour, self._layer(comp) or layer, False, many, f"{path}.{i}",
                           given=name if is_part else "")
            return
        shape = tool.GetShape_s(label)
        if shape is None or shape.IsNull():
            return
        entry = self._entry(label)
        key = "root" if top else entry  # loose faces of the top level are sewn all together, whatever shape they were in
        if entry not in self._leaf_cache:
            subs = self._sub_labels(label)
            self._leaf_cache[entry] = self._content(key, shape, subs, (name if top else "", colour, layer), top)
        for form, inner, own_name, own_colour, own_layer in self._leaf_cache[entry]:
            self.bodies.append(_Body(form, loc.Multiplied(inner), f"{entry}@{path}", name, own_name, parent,
                                     own_colour or colour, own_layer or layer))
        if not top:
            self._use(key, loc, f"{entry}@{path}", name, parent, colour, layer)
        elif "root" in self.pools and not self.pools["root"].uses:
            self._use("root", o.TopLoc_Location(), "root", "", "", "", "")

    def _use(self, key: str, loc, leaf: str, name: str, parent: str, colour: str = "", layer: str = "") -> None:
        if key in self.pools:
            self.pools[key].uses.append((loc, leaf, name, parent, colour, layer))

    def _sub_labels(self, label) -> dict:
        """What the file says about the solids and faces inside a leaf: TShape → (name, colour, layer)."""
        o = self.o
        subs = o.TDF_LabelSequence()
        o.XCAFDoc_ShapeTool.GetSubShapes_s(label, subs)
        out = {}
        for i in range(1, subs.Length() + 1):
            sub = subs.Value(i)
            shape = o.XCAFDoc_ShapeTool.GetShape_s(sub)
            if shape is not None and not shape.IsNull():
                out[shape.TShape()] = (self._name(sub), self._colour(sub), self._layer(sub))
        return out

    def _form(self, shape, how: str) -> _Shape:
        key = shape.TShape()
        if key not in self.forms:
            self.forms[key] = _Shape(shape, how, key)
        return self.forms[key]

    def _content(self, pool_key: str, shape, subs: dict, own: tuple, top: bool) -> list:
        """A leaf taken apart: its solids and shells (each with where it sits in the leaf), and its loose faces
        into the pool. `own` = name, colour, layer that the loose faces take when they have none themselves."""
        o = self.o
        still = o.TopLoc_Location()
        items = []
        found = False

        def first_face_colour(body) -> str:
            if subs:
                for f in _explore(o, body, o.TopAbs_FACE):
                    colour = subs.get(f.TShape(), ("", "", ""))[1]
                    if colour:
                        return colour
            return ""

        for solid in _explore(o, shape, o.TopAbs_SOLID):
            name, colour, layer = subs.get(solid.TShape(), ("", "", ""))
            items.append((self._form(solid.Located(still), "solid"), solid.Location(), name,
                          colour or first_face_colour(solid), layer))
        loose = []
        for shell in _explore(o, shape, o.TopAbs_SHELL, o.TopAbs_SOLID):
            faces = _explore(o, shell, o.TopAbs_FACE)
            if len(faces) < 2:  # a shell of one face is a loose face
                loose += faces
                continue
            name, colour, layer = subs.get(shell.TShape(), ("", "", ""))
            items.append((self._form(shell.Located(still), "shell"), shell.Location(), name,
                          colour or first_face_colour(shell), layer))
        loose += _explore(o, shape, o.TopAbs_FACE, o.TopAbs_SHELL)
        if loose:
            pool = self.pools.setdefault(pool_key, _Pool())
            for face in loose:
                name, colour, layer = subs.get(face.TShape(), ("", "", ""))
                pool.faces.append((face, name, colour or own[1], layer or own[2], own[0]))
            found = True
        if not items and not found:
            self.skipped += 1
        return items

    # ---- 3. loose faces → shells
    def sew(self) -> None:
        total = sum(len(p.faces) for p in self.pools.values())
        self.report.loose_faces = total
        if not total:
            return
        self.say("เย็บผิว", 0.66)
        counts = Counter()
        done = 0
        levels: set[str] = set()
        for key, pool in self.pools.items():
            # level by level: two parts that touch are two parts when the designer drew them on two levels
            by_level: dict[str, list[int]] = {}
            for i, face in enumerate(pool.faces):
                by_level.setdefault(face[3], []).append(i)
            levels.update(k for k in by_level if k)
            groups = []
            for level in sorted(by_level, key=lambda k: (len(k), k)):  # '2' before '10'
                groups += self._sew_faces(pool.faces, by_level[level], counts)
                done += len(by_level[level])
                self.say("เย็บผิว", 0.66 + 0.1 * done / total)
            for place, leaf, leaf_name, parent, colour, layer in pool.uses:
                for form, label, own_colour, own_layer, top, labels in groups:
                    # (a face without a label of its own goes by the name of the top shape it is in)
                    self.bodies.append(_Body(form, place, leaf, leaf_name or top, label or top, parent,
                                             own_colour or colour, own_layer or layer, labels=labels))
            pool.faces = []
        self.pools = {}
        gc.collect()
        said = [f"เย็บผิวอิสระ {total:,} ผิว (ค่าเผื่อ {SEW_TOL:g} มม.) ได้ {counts['sewn']:,} เปลือก"]
        if len(levels) > 1:
            said[0] = said[0].replace("เย็บผิวอิสระ", f"เย็บผิวอิสระแยกตาม level ของ IGES {len(levels):,} level รวม")
        if counts["retry"]:
            said.append(f"เย็บซ้ำแบบหลวม ({SEW_RETRY_TOL:g} มม.) ได้อีก {counts['retry']:,} เปลือก")
        for how, text in (("linked", "รวมผิวที่ขอบต่อกัน"), ("colour", "รวมผิวตามสี"), ("rest", "รวมผิวเดี่ยวที่เหลือเป็นชิ้นเดียว")):
            if counts[how]:
                said.append(f"{text} {counts[how + '_faces']:,} ผิว เป็น {counts[how]:,} ชิ้น")
        if counts["face"]:
            said.append(f"ผิวเดี่ยว {counts['face']:,} ผิว เป็นชิ้นละผิว")
        self.report.methods.append(" → ".join(said))

    def _attrs(self, faces: list, picked: list[int]) -> tuple[str, str, str, str, int]:
        """Label, colour, level and top shape of a group of faces: what most of them say; and how many
        different labels they had."""
        out = []
        for col in (1, 2, 3, 4):
            seen = Counter(faces[i][col] for i in picked if faces[i][col])
            out.append(seen.most_common(1)[0][0] if seen else "")
        return (*out, len({faces[i][1] or faces[i][4] for i in picked}))

    def _sewing(self, faces: list, picked: list[int], tol: float) -> tuple[list[tuple[object, list[int]]], list[int]]:
        """Sews the picked faces: the shells that come out (each with the faces it was made of) and the faces
        that stayed alone."""
        o = self.o
        sewing = o.BRepBuilderAPI_Sewing(tol)
        for i in picked:
            sewing.Add(faces[i][0])
        sewing.Perform()
        result = sewing.SewedShape()
        if result is None or result.IsNull():
            return [], list(picked)
        source = {}
        for i in picked:
            new = sewing.ModifiedSubShape(faces[i][0])
            if new is not None and not new.IsNull():
                source[new.TShape()] = i
            source.setdefault(faces[i][0].TShape(), i)
        shells, used = [], set()
        for shell in _explore(o, result, o.TopAbs_SHELL):
            members = [source[f.TShape()] for f in _explore(o, shell, o.TopAbs_FACE) if f.TShape() in source]
            if len(members) < 2:
                continue
            shells.append((shell, members))
            used.update(members)
        return shells, [i for i in picked if i not in used]

    def _sew_faces(self, faces: list, picked: list[int], counts: Counter) -> list[tuple]:
        """Loose faces of one pool (those of one level) → (form, label, colour, level, top shape, number of labels)."""
        out = []
        alone = list(picked)
        for tol, how in ((SEW_TOL, "sewn"), (SEW_RETRY_TOL, "retry")):
            if len(alone) < 2 or (how == "retry" and len(alone) <= LOOSE_MAX):
                break
            shells, alone = self._sewing(faces, alone, tol)
            for shell, members in shells:
                out.append((self._form(shell, "sewn"), *self._attrs(faces, members)))
            counts[how] += len(shells)
        if len(alone) > LOOSE_MAX:
            groups = self._linked(faces, alone)
            how = "linked"
            if len(groups) > LOOSE_MAX:
                keys = {faces[i][2] for i in alone}
                if len(keys) > 1:
                    groups, how = [[i for i in alone if faces[i][2] == k] for k in sorted(keys)], "colour"
                else:  # nothing tells them apart: the groups that hold together stay, the single faces are one part
                    single = [g[0] for g in groups if len(g) == 1]
                    groups = [g for g in groups if len(g) > 1]
                    if single:
                        out.append((self._compound([faces[i][0] for i in single], "rest"), *self._attrs(faces, single)))
                        counts["rest"] += 1
                        counts["rest_faces"] += len(single)
            for g in groups:
                form = self._compound([faces[i][0] for i in g], how) if len(g) > 1 else self._form(faces[g[0]][0], how)
                out.append((form, *self._attrs(faces, g)))
            counts[how] += len(groups)
            counts[how + "_faces"] += sum(len(g) for g in groups)
        else:
            for i in alone:
                out.append((self._form(faces[i][0], "face"), *faces[i][1:], 1))  # (its four columns are in that order)
            counts["face"] += len(alone)
        return out

    def _compound(self, shapes: list, how: str) -> _Shape:
        return self._form(_compound_of(self.o, shapes), how)

    def _linked(self, faces: list, picked: list[int]) -> list[list[int]]:
        """Faces that share an edge - the same two ends and the same middle, to `LINK_GRID` - are one group.
        (Sewing asks for more: the whole edge within its tolerance.) Two grids half a cell apart, so that two
        points on either side of a cell border still meet in one of them."""
        o = self.o
        parent = {i: i for i in picked}

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        seen: dict[tuple, int] = {}
        for i in picked:
            for e in _explore(o, faces[i][0], o.TopAbs_EDGE):
                try:
                    curve = o.BRepAdaptor_Curve(o.edge(e))
                    a, b = curve.FirstParameter(), curve.LastParameter()
                    pts = [curve.Value(a), curve.Value((a + b) / 2), curve.Value(b)]
                except Exception:  # noqa: BLE001 - an edge without a curve (the pole of a sphere)
                    continue
                for shift in (0.0, 0.5):
                    cells = [tuple(math.floor(v / LINK_GRID + shift) for v in (p.X(), p.Y(), p.Z())) for p in pts]
                    key = (shift, min(cells[0], cells[2]), cells[1], max(cells[0], cells[2]))
                    j = seen.setdefault(key, i)
                    if j != i:
                        parent[find(i)] = find(j)
        groups: dict[int, list[int]] = {}
        for i in picked:
            groups.setdefault(find(i), []).append(i)
        return list(groups.values())

    # ---- 4. mesh within the budget
    def measure(self) -> None:
        """The true size of every form and of the whole model. From the geometry, exactly: the quick box of a
        trimmed surface is that of the whole surface under it (metres, for a bracket), and a size read off a
        coarse mesh makes a 50 mm tube 43 mm wide."""
        import numpy as np

        o = self.o
        self.say("วัดขนาด", 0.765)
        for body in self.bodies:
            body.form.uses += 1
        number = 0
        used = [f for f in self.forms.values() if f.uses]
        for n, form in enumerate(used):
            box = o.Bnd_Box()
            try:
                o.BRepBndLib.AddOptimal_s(form.shape, box, False, False)
            except Exception:  # noqa: BLE001 - a surface it cannot work out: the quick box, too big rather than none
                box = o.Bnd_Box()
                o.BRepBndLib.Add_s(form.shape, box, False)
            if not box.IsVoid():
                lo, hi = box.CornerMin(), box.CornerMax()
                form.box = ((lo.X(), lo.Y(), lo.Z()), (hi.X(), hi.Y(), hi.Z()))
                form.diag = math.dist(*form.box)
                form.extent = tuple(sorted((b - a for a, b in zip(*form.box)), reverse=True))
            form.faces = len(_explore(o, form.shape, o.TopAbs_FACE))
            number += 1
            form.no = number
            if n % 50 == 49:
                self.say("วัดขนาด", 0.765 + 0.015 * n / len(used))
        self.report.faces_in_file = sum(f.faces for f in used)
        lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
        for body in self.bodies:
            corners = self._box_corners(body.form, _matrix(body.place))
            if corners is not None:
                lo, hi = np.minimum(lo, corners.min(axis=0)), np.maximum(hi, corners.max(axis=0))
        self.model_diag = float(np.linalg.norm(hi - lo)) if np.isfinite(lo).all() else 0.0

    def _mesh(self, level: int, clean: bool, only: list | None = None) -> int:
        """Meshes every form (or `only` some) at a level; forms of about one size go in together, so that the
        faces of all of them are spread over the processors. Returns the triangles of the whole model."""
        o = self.o
        share, most, angle = LEVELS[level]
        batches: dict[float, list[_Shape]] = {}
        chosen = [f for f in self.forms.values() if f.uses] if only is None else only
        for form in chosen:
            deflection = min(max(share * form.diag, MIN_DEFLECTION), most)
            step = 10 ** math.floor(math.log10(deflection))
            deflection = max(m for m in (1, 2, 5) if m * step <= deflection * 1.0001) * step
            batches.setdefault(deflection, []).append(form)
        done, count = 0, sum(len(b) for b in batches.values())
        for deflection, forms in sorted(batches.items()):
            compound = _compound_of(o, [form.shape for form in forms])
            if clean:
                o.BRepTools.Clean_s(compound)  # or the finer mesh, good enough for the coarser one, would be kept
            o.BRepMesh_IncrementalMesh(compound, deflection, False, angle, True)
            done += len(forms)
            self.say(f"สร้างตาข่าย (ระดับ {level + 1}/{len(LEVELS)})", 0.78 + 0.04 * level + 0.04 * done / max(count, 1))
        still = o.TopLoc_Location()
        for form in chosen:
            form.count = 0
            for f in _explore(o, form.shape, o.TopAbs_FACE):
                tri = o.BRep_Tool.Triangulation_s(o.face(f), still)
                form.count += tri.NbTriangles() if tri is not None else 0
        return sum(f.count * f.uses for f in self.forms.values())

    def mesh(self) -> None:
        self.say(f"สร้างตาข่าย (ระดับ 1/{len(LEVELS)})", 0.78)
        last = len(LEVELS) - 1
        used = [f for f in self.forms.values() if f.uses]
        instances = sum(f.faces * f.uses for f in used)
        level, clean, finer, total = 0, False, None, None
        if 2 * instances > self.max_faces:  # two triangles a face is the least there can be: only the floor is tried
            level = last
        elif 8 * instances > self.max_faces:  # most likely too much: the coarsest mesh is quick, and tells
            total, clean = self._mesh(last, False), True
            if total > self.max_faces:
                level = last
            else:
                total = None
        while True:
            if total is None:
                total = self._mesh(level, clean)
            if total <= self.max_faces or level == last:
                break
            finer = {key: form.count for key, form in self.forms.items()}  # what the level that was too much cost
            level, clean, total = level + 1, True, None
        self.report.level = level
        text = f"ตาข่ายระดับ {level + 1}/{len(LEVELS)}" + (" (หยาบสุด)" if level == last else "")
        if total > self.max_faces:
            total, changed = self._drop_holes(total)
            if finer and changed and total <= self.max_faces:  # what a finer mesh of them would cost now: a guess
                same = [f for f in used if f.key not in changed]
                ratio = max(sum(finer[f.key] for f in same) / max(sum(f.count for f in same), 1), 1.0)
                for key in changed:
                    finer[key] = int(self.forms[key].count * ratio)
        if total > self.max_faces:
            total = self._box_small(total)
        elif finer:  # room is left: the biggest parts, which fill the picture, get the finer mesh back
            better, spare = [], self.max_faces - total
            for form in sorted(used, key=lambda f: -f.diag):
                extra = (finer[form.key] - form.count) * form.uses
                if 0 < extra <= spare:
                    better.append(form)
                    spare -= extra
            if better and self._mesh(level - 1, True, better) > self.max_faces:  # the guess was too low: back
                self._mesh(level, True, better)
                better = []
            if better:
                text += f" ชิ้นใหญ่ {len(better):,} แบบละเอียดขึ้นหนึ่งระดับ"
        self.simplified.insert(0, text)
        self.say("เก็บตาข่าย", 0.94)
        for form in used:
            self._triangles(form)

    def _drop_holes(self, total: int) -> tuple[int, set]:
        """Over the budget at the coarsest mesh: the small holes, cut-outs and embossed patterns are left out
        (see `_drop_small_loops`) and the forms that had them are meshed again."""
        o = self.o
        last = len(LEVELS) - 1
        self.say("ลดรายละเอียด (รู ลายนูน)", 0.9)
        hole_max = min(HOLE_SHARE * self.model_diag, HOLE_MAX)
        changed = []
        for form in self.forms.values():
            if not form.uses or form.faces < 2:
                continue
            try:
                shape, loops, faces = _drop_small_loops(o, form.shape, hole_max)
            except Exception:  # noqa: BLE001 - a broken face: the form stays as it is
                continue
            if loops:
                o.BRepTools.Clean_s(form.shape)
                form.shape = shape
                changed.append(form)
                self.report.holes += loops * form.uses
                self.report.hole_faces += faces * form.uses
        if not changed:
            return total, set()
        before, total = total, self._mesh(last, True, changed)
        self.report.hole_max = round(hole_max, 1)
        self.simplified.append(
            f"ตัดรู ช่องเจาะ และลายนูนที่เล็กกว่า {hole_max:,.0f} มม. ออกจากตาข่าย {self.report.holes:,} จุด "
            f"(ผิวข้างใน {self.report.hole_faces:,} ผิว) ใน {len(changed):,} ชิ้น ลดจาก {before:,} เหลือ {total:,} หน้า "
            "– รูปร่างและขนาดของชิ้นคงเดิม")
        return total, {form.key for form in changed}

    def _box_small(self, total: int) -> int:
        """Still over the budget: small parts (no longer than `BOX_MAX`) become their bounding boxes, those
        with the most triangles first - a lock of 1,400 faces before a plain washer - so that few do. A part
        that is bigger is never a box: when that is not enough the model stays over its budget, and says so."""
        small = [b for b in self.bodies if b.form.count > BOX_FACES and 0 < b.form.extent[0] <= BOX_MAX]
        biggest = 0.0
        for body in sorted(small, key=lambda b: (-b.form.count, b.form.diag)):
            if total <= self.max_faces:
                break
            body.boxed = True
            total -= body.form.count - BOX_FACES
            biggest = max(biggest, body.form.extent[0])
            self.report.boxed += 1
        if self.report.boxed:
            self.simplified.append(f"แสดงชิ้นเล็ก {self.report.boxed:,} ชิ้น (ยาวไม่เกิน {biggest:,.0f} มม. "
                                   "ที่มีหน้ามากที่สุด) เป็นกล่อง")
        if total > self.max_faces * OVER_BUDGET:
            raise CadImportError(
                f"โมเดลมี {len(self.bodies):,} ชิ้น ต้องใช้อย่างน้อย {total:,} หน้าแม้ตาข่ายหยาบสุด – เกินงบ {self.max_faces:,} หน้า"
                f"ไปกว่า {OVER_BUDGET} เท่า · เพิ่มงบ (tools/cad_to_rrsasm.py --max-faces {-(-total // 10000) * 10000:,}) "
                "หรือส่งออกจาก CAD ทีละชุดประกอบย่อย")
        if total > self.max_faces:
            self.report.over_budget = True
            self.simplified.append(f"ยังเกินงบ {self.max_faces:,} หน้า (ใช้ {total:,}) – ไม่ลดต่อ "
                                   "เพราะจะต้องทิ้งรูปทรงจริงของชิ้นใหญ่ ภาพ 3 มิติจะหมุนช้าลง")
        return total

    def _triangles(self, form: _Shape) -> None:
        """The triangles of a form in its own frame, wound so that the outside of a solid is the front; and
        whether they close (then the view may hide the back faces)."""
        import numpy as np

        o = self.o
        parts = []
        for f in _explore(o, form.shape, o.TopAbs_FACE):
            face = o.face(f)
            loc = o.TopLoc_Location()
            tri = o.BRep_Tool.Triangulation_s(face, loc)
            if tri is None or not tri.NbTriangles():
                self.unmeshed += 1
                continue
            nodes = (tri.Node(i) for i in range(1, tri.NbNodes() + 1))
            pts = np.array([(p.X(), p.Y(), p.Z()) for p in nodes])
            idx = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)], dtype=np.int64) - 1
            flip = face.Orientation() == o.TopAbs_REVERSED
            m = _matrix(loc)
            if m is not None:
                pts = pts @ m[0].T + m[1]
                flip ^= bool(np.linalg.det(m[0]) < 0)
            parts.append(pts[idx[:, ::-1] if flip else idx])
        tris = np.concatenate(parts) if parts else np.zeros((0, 3, 3))
        if len(tris):
            if not any(form.extent):  # no box from the geometry: that of the mesh
                lo, hi = tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0)
                form.extent = tuple(sorted((float(v) for v in hi - lo), reverse=True))
            closed, volume = _closed(tris)
            if closed and volume < 0:  # a solid written inside out (IGES does that): turned
                tris = tris[:, ::-1]
            form.cull = closed and abs(volume) > 1e-6
        form.tris = tris
        o.BRepTools.Clean_s(form.shape)

    # ---- 5. the model
    def _level_group(self, layer: str) -> str:
        """The group of an IGES level: its name in the file, 'Layer N' when it has none."""
        if layer.isdigit():
            return self.level_names.get(int(layer)) or f"Layer {int(layer)}"
        return layer

    def _labels_are_names(self) -> bool:
        """Do the labels on the loose faces name the parts? They do when every part sewn of them has one label
        and the parts under one label are one item (the same part drawn several times). ZW3D writes the label of
        a 'shape' on every surface of it - 'S1' on ten thousand faces of a hundred parts: those are no names."""
        seen: dict[str, _Shape] = {}
        for body in self.bodies:
            if body.labels < 0 or not body.name:
                continue
            first = seen.setdefault(body.name, body.form)
            if body.labels != 1 or not _same_item(first, body.form):
                return False
        return True

    def build(self) -> a3.AssemblyModel:
        import numpy as np

        self.say("จัดกลุ่มชิ้นส่วน", 0.96)
        if not self._labels_are_names():
            self.notes.append("ป้ายบนผิว (เช่น S1 ของ ZW3D) ใช้ร่วมกันหลายชิ้น จึงไม่ใช้เป็นชื่อชิ้นส่วน")
            for body in self.bodies:
                if body.labels >= 0:
                    body.name = ""
        layers = {b.layer for b in self.bodies if b.layer}
        # 1. where every part is, and which way is up
        placed, boxes = [], []
        for body in self.bodies:
            form = body.form
            m = _matrix(body.place)
            tris = form.tris
            if len(tris) and m is not None:
                tris = tris @ m[0].T + m[1]
                if np.linalg.det(m[0]) < 0:  # a mirrored instance: the same faces seen from the other side
                    tris = tris[:, ::-1]
            failed = not len(tris)
            if failed:  # OpenCascade made no triangle of it: its bounding box, so that it is not lost
                corners = self._box_corners(form, m)
                tris = corners if corners is not None else tris
            placed.append((tris, failed))
            if len(tris):
                pts = tris.reshape(-1, 3)
                boxes.append((pts.min(axis=0), pts.max(axis=0)))
        up, why = (self.up, "กำหนดเอง") if self.up else _guess_up(boxes)
        self.report.up, self.report.up_guessed = up, not self.up
        # 2. the parts
        parts: list[a3.Part3D] = []
        kept: list[_Body] = []
        by_size = False
        empty = 0
        for body, (tris, failed) in zip(self.bodies, placed):
            form = body.form
            if not len(tris):
                empty += 1
                continue
            if up == "y":  # (x, y, z) → (x, -z, y): a turn, so the faces keep their front
                tris = np.stack([tris[..., 0], -tris[..., 2], tris[..., 1]], axis=-1)
            name = body.name or body.leaf_name
            if body.layer and (self.level_names or (not name and len(layers) > 1)
                               or (len(layers) > 1 and not _DEFAULT_LAYER.match(body.layer))):
                group = self._level_group(body.layer)  # the levels have names: the designer's own grouping
            elif name:
                group = body.parent or a3._group_of(name)
            elif body.parent:
                group = body.parent
            else:
                group = SIZE_GROUPS[0 if form.diag >= BIG else 1 if form.diag >= SMALL else 2]
                by_size = True
            part = a3.Part3D("", "", group, "mesh", color=body.color or a3.STEEL)
            if failed:
                body.boxed = True
                part.note = "สร้างตาข่ายไม่ได้ – แสดงเป็นกล่อง"
            if body.boxed:
                pts = tris.reshape(-1, 3)
                lo, hi = np.round(pts.min(axis=0), 2), np.round(pts.max(axis=0), 2)
                part.shape, part.pos = "box", [float(v) for v in lo]
                part.dims = [max(float(v), 0.01) for v in hi - lo]
                if not failed:  # its real shape goes along: not drawn with the whole model, shown for the part alone
                    part.detail = np.round(tris, 2).tolist()
                part.note = part.note or "ชิ้นเล็ก – ในภาพรวมแสดงเป็นกล่องเพื่อให้อยู่ในงบจำนวนหน้า · ซูมเข้าใกล้หรือแตะชิ้นเพื่อดูรูปทรงจริง"
            else:
                tris = np.round(tris, 2)
                a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
                keep = ~((a == b).all(axis=1) | (b == c).all(axis=1) | (a == c).all(axis=1))  # flat after rounding
                part.mesh = tris[keep].tolist()
                part.cull = form.cull
                if not part.mesh:
                    empty += 1
                    continue
            parts.append(part)
            kept.append(body)
        if not parts:
            raise CadImportError(f"สร้างตาข่ายจากไฟล์ {self.path.name} ไม่ได้เลย – รูปทรงในไฟล์เสีย")
        self._name_parts(parts, kept)
        # 3. the order: a step per group, from the bottom up - a first draft of the assembly order
        if by_size:  # no groups in the file: big parts first, the frame is fitted before its bolts
            order = {g: (SIZE_GROUPS.index(g) if g in SIZE_GROUPS else -1) for g in {p.group for p in parts}}
        else:
            height: dict[str, list[float]] = {}
            for p in parts:
                lo, hi = p.bounds()
                weight = math.dist(lo, hi) + 1.0  # a big part says more about where its group is than a bolt
                h = height.setdefault(p.group, [0.0, 0.0])
                h[0] += weight * (lo[2] + hi[2]) / 2
                h[1] += weight
            order = {g: round(h[0] / h[1]) for g, h in height.items()}
        parts.sort(key=lambda p: order[p.group])  # stable: inside a group the order of the file
        for i, p in enumerate(parts, 1):
            p.id = f"c{i}"
        model = a3.AssemblyModel(self.path.stem, parts, source="file")
        a3.auto_steps(model)
        a3.auto_explode(model)
        self._describe(model, by_size, empty, up, why)
        return model

    def _name_parts(self, parts: list, bodies: list) -> None:
        """Name and size of every part: the name the file gives, else '<leaf or group> 01' … from the biggest,
        one name for the parts that are one item (see `_same_item`) so that the parts table counts them."""
        nameless: dict[str, list[int]] = {}
        for i, (part, body) in enumerate(zip(parts, bodies)):
            if body.name:
                part.name, part.size = body.name, _size_text(body.form.extent)
                continue
            leveled = bool(body.layer) and part.group == self._level_group(body.layer)
            base = (body.leaf_name if not leveled else "") or ("" if part.group in SIZE_GROUPS else part.group)
            nameless.setdefault(base, []).append(i)
        for base, members in nameless.items():
            if not base:
                for i in members:
                    parts[i].name, parts[i].size = f"ชิ้นที่ {bodies[i].form.no}", _size_text(bodies[i].form.extent)
                continue
            items: list[list[int]] = []  # parts that are one item, the biggest item first
            for i in sorted(members, key=lambda i: (bodies[i].form.extent, bodies[i].form.faces), reverse=True):
                for item in items:
                    if _same_item(bodies[item[0]].form, bodies[i].form):
                        item.append(i)
                        break
                else:
                    items.append([i])
            # the name of a leaf with one form in it is the name of that form; a group is not the name of a part
            bare = len(items) == 1 and all(bodies[i].leaf_name == base for i in members)
            digits = max(2, len(str(len(items))))
            for n, item in enumerate(items, 1):
                for i in item:
                    parts[i].name = base if bare else f"{base} {n:0{digits}d}"
                    parts[i].size = _size_text(bodies[item[0]].form.extent)

    def _describe(self, model: a3.AssemblyModel, by_size: bool, empty: int, up: str, why: str) -> None:
        """The report and the note of the model: file, unit, how the parts were found, the groups with their
        parts and triangles, the axes, what was simplified."""
        report, parts = self.report, model.parts
        report.parts, report.groups = len(parts), len(model.groups())
        report.triangles = a3.face_count(model)
        report.bounds = [[round(float(v), 2) for v in corner] for corner in model.bounds()]
        solids = sum(1 for b in self.bodies if b.form.how == "solid")
        shells = sum(1 for b in self.bodies if b.form.how == "shell")
        how = ([f"solid {solids:,} ชิ้น"] if solids else []) + ([f"เปลือก (shell) {shells:,} ชิ้น"] if shells else [])
        if self.tree:
            how.insert(0, "ตามโครงสร้างชุดประกอบในไฟล์")
        report.methods[:0] = how
        counts: dict[str, list[int]] = {}
        for p in parts:
            c = counts.setdefault(p.group, [0, 0])
            c[0] += 1
            c[1] += len(p.mesh) if p.shape == "mesh" else BOX_FACES
        report.group_counts = [[g, *c] for g, c in counts.items()]
        shown = [f"{g} {n:,} ชิ้น {t:,} หน้า" for g, n, t in report.group_counts[:GROUPS_IN_NOTE]]
        if len(counts) > GROUPS_IN_NOTE:
            shown.append(f"… และอีก {len(counts) - GROUPS_IN_NOTE:,} กลุ่ม")
        if self.level_names:
            grouped = f"กลุ่ม = level ของ IGES ตามชื่อในไฟล์ ({len(self.level_names):,} level มีชื่อ)"
        elif by_size:
            grouped = "ชิ้นที่ไม่มีชื่อจัดกลุ่มตามขนาด"
        else:
            grouped = "กลุ่มตามชื่อ/ชุดประกอบย่อย/level ในไฟล์"
        lo, hi = report.bounds
        if up == "y":
            axis = f"แกนตั้ง: หมุนโมเดลจาก Y ขึ้น เป็น Z ขึ้น ({why})"
        else:
            axis = f"แกนตั้ง: Z ขึ้นตามไฟล์ ({why})"
        if self.skipped:
            self.notes.append(f"ข้ามเส้น/จุดที่ไม่มีผิว {self.skipped:,} รายการ")
        if self.unmeshed:
            self.notes.append(f"ผิวที่สร้างตาข่ายไม่ได้ {self.unmeshed:,} ผิว")
        if empty:
            self.notes.append(f"ชิ้นที่ไม่มีรูปทรงให้แสดง {empty:,} ชิ้นถูกข้าม")
        model.note = " · ".join([
            f"นำเข้าจาก {report.kind} ({report.reader}) ไฟล์ {self.path.name} หน่วยในไฟล์: {report.unit} → มม.",
            f"แยกชิ้น: {report.method()}",
            f"{report.parts:,} ชิ้น {report.triangles:,} หน้า (งบ {self.max_faces:,}) ขนาดรวม "
            + " × ".join(f"{b - a:,.0f}" for a, b in zip(lo, hi)) + " มม.",
            f"{grouped}: " + ", ".join(shown),
            "ขั้นประกอบ: กลุ่มละขั้น " + ("เรียงจากชิ้นใหญ่ไปเล็ก" if by_size else "เรียงจากกลุ่มที่อยู่ต่ำสุดขึ้นไป") + " (ร่างแรก แก้ลำดับได้)",
            axis,
            "การลดรายละเอียด: " + "; ".join(self.simplified),
            *self.notes])

    def _box_corners(self, form: _Shape, m):
        """The eight corners of the true box of a form, where a body with the placement `m` has it."""
        import numpy as np

        if form.box is None:
            return None
        lo, hi = form.box
        pts = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        return pts if m is None else pts @ m[0].T + m[1]


def _same_item(a: _Shape, b: _Shape) -> bool:
    """One item of the parts table: the same form, or as many faces and the same three sizes (to `SAME_SIZE`)."""
    return a is b or (a.faces == b.faces and all(abs(x - y) <= SAME_SIZE for x, y in zip(a.extent, b.extent)))


def _size_text(extent: tuple) -> str:
    """'2600×100×50': length × width × height in mm, the longest first."""
    return "×".join(f"{v:.0f}" for v in extent) if any(extent) else ""


def _guess_up(boxes: list) -> tuple[str, str]:
    """Which axis of the file points up, when nobody said: 'y' only when the file itself shows it - a big flat
    plate (a floor: thin, at least 40 % of the model long and wide, with the rest of the model above or below
    it) lies across Y, and twice the area of the plates that lie across Z (walls, gates). Else the file is
    taken as it is. Returns the axis and the reason, for the note."""
    import numpy as np

    if not boxes:
        return "z", "เดา: ไม่มีชิ้นส่วนให้ดู"
    lo = np.min([b[0] for b in boxes], axis=0)
    hi = np.max([b[1] for b in boxes], axis=0)
    size = np.maximum(hi - lo, 1e-9)
    area = {1: 0.0, 2: 0.0}
    best = {1: None, 2: None}
    for a, b in boxes:
        d = b - a
        for axis in (1, 2):
            u, v = [i for i in range(3) if i != axis]
            if (d[axis] <= 0.1 * min(d[u], d[v]) and d[axis] <= 0.05 * size[axis]
                    and d[u] >= 0.4 * size[u] and d[v] >= 0.4 * size[v]):
                area[axis] += d[u] * d[v]
                if best[axis] is None or d[u] * d[v] > best[axis][0] * best[axis][1]:
                    best[axis] = (d[u], d[v])
    if area[1] > 0 and area[1] >= 2 * area[2]:
        return "y", (f"เดาอัตโนมัติ: พบแผ่นพื้นใหญ่ {best[1][0]:,.0f} × {best[1][1]:,.0f} มม. วางขวางแกน Y ของไฟล์ "
                     "(ใหญ่กว่าแผ่นที่ขวางแกน Z เกินสองเท่า) – ถ้าไม่ถูกให้ระบุ up=z หรือกดปุ่ม Y↔Z ในแท็บประกอบ 3D")
    if area[2] > 0:
        return "z", "เดาอัตโนมัติ: แผ่นพื้นใหญ่วางขวางแกน Z อยู่แล้ว"
    return "z", "เดาอัตโนมัติ: ไม่พบแผ่นพื้นใหญ่ที่บอกว่าเป็น Y ขึ้น – ถ้าโมเดลนอนตะแคงให้ระบุ up=y หรือกดปุ่ม Y↔Z ในแท็บประกอบ 3D"


def _closed(tris) -> tuple[bool, float]:
    """Is every edge of the mesh walked once in each direction (a closed skin with one side out)? And the
    volume it holds: negative when the triangles wind inwards."""
    import numpy as np

    flat = tris.reshape(-1, 3)
    centre = flat.mean(axis=0)
    _points, index = np.unique(np.round((flat - centre) * 1000).astype(np.int64), axis=0, return_inverse=True)
    v = index.reshape(-1, 3)
    v = v[(v[:, 0] != v[:, 1]) & (v[:, 1] != v[:, 2]) & (v[:, 0] != v[:, 2])]
    if not len(v):
        return False, 0.0
    n = int(v.max()) + 1
    forward = np.concatenate([v[:, 0] * n + v[:, 1], v[:, 1] * n + v[:, 2], v[:, 2] * n + v[:, 0]])
    back = np.concatenate([v[:, 1] * n + v[:, 0], v[:, 2] * n + v[:, 1], v[:, 0] * n + v[:, 2]])
    closed = bool(np.array_equal(np.sort(forward), np.sort(back)))
    t = tris - centre
    volume = float(np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() / 6)
    return closed, volume


# --------------------------------------------------------------------------- the calls
def read_cad_report(path: str | Path, max_faces: int = MAX_FACES, progress=None,
                    up: str | None = None) -> tuple[a3.AssemblyModel, CadReport]:
    """An IGES or STEP file → the model (mm) and the report of what was done. `progress(stage, fraction)` is
    called with a Thai stage text and 0 … 1. `up`: the axis of the file that points up, 'y' or 'z' (None: guessed,
    see `_guess_up`). Raises `CadImportError` with a message for the user."""
    start = time.perf_counter()
    run = None
    try:
        run = _Import(path, max_faces, progress, up)
        run.check_file()
        run.read()
        run.sew()
        run.measure()
        run.mesh()
        model = run.build()
    except CadImportError:
        raise
    except MemoryError as e:
        raise CadImportError(f"หน่วยความจำไม่พอสำหรับไฟล์ {Path(path).name} – ปิดโปรแกรมอื่น หรือส่งออกจาก CAD "
                             "เป็นหลายไฟล์ย่อย") from e
    except Exception as e:  # noqa: BLE001 - OpenCascade raises its own classes: the user gets the stage and the cause
        stage = run.stage if run else ""
        raise CadImportError(f"นำเข้า {Path(path).name} ไม่สำเร็จ (ขั้น “{stage}”): {type(e).__name__}: {e}") from e
    run.say("", 1.0)
    run.report.seconds["รวม"] = round(time.perf_counter() - start, 2)
    run.report.peak_mb = round(peak_memory_mb(), 1)
    if progress:
        progress("เสร็จ", 1.0)
    return model, run.report


def read_cad(path: str | Path, max_faces: int = MAX_FACES, progress=None, up: str | None = None) -> a3.AssemblyModel:
    """An IGES or STEP file exported from CAD → `AssemblyModel` in mm, Z up, within `max_faces` triangles where
    that can honestly be done, with a step per group from the bottom up and an exploded position per part
    (see the top of this module for what a part and a group are)."""
    return read_cad_report(path, max_faces, progress, up)[0]


_MARK = "@@rrs-cad "
CHILD_FLAG = "--cad-import"  # the program started with this as its first argument reads one CAD file and ends
_CHILD = ("import sys; sys.path[0] = sys.argv.pop(1); from partlist_studio.core.cad_import import _child; "
          "sys.exit(_child(sys.argv[1:]))")


def _child(argv: list[str]) -> int:
    """The other end of `read_cad_isolated`: source, target, face budget, up axis, and the file that takes the
    progress and the outcome as marked lines of JSON (no file: standard output). A program built as a window has
    no standard output on Windows, so the builds always get the file."""
    source, target, max_faces = argv[0], argv[1], int(argv[2])
    up = argv[3] if len(argv) > 3 and argv[3] else None
    log = open(argv[4], "a", encoding="utf-8") if len(argv) > 4 and argv[4] else sys.stdout  # noqa: SIM115 - open for the run

    def tell(kind: str, **data) -> None:
        log.write(_MARK + json.dumps({"kind": kind, **data}) + "\n")  # ASCII: no code page in the way
        log.flush()

    try:
        model, report = read_cad_report(source, max_faces,
                                        lambda stage, fraction: tell("progress", stage=stage, fraction=fraction), up)
        model.save(target)
        tell("done", report=asdict(report))
        return 0
    except CadImportError as e:
        tell("error", message=str(e))
        return 2
    except Exception as e:  # noqa: BLE001 - a full disk, no memory left: the parent must hear of it, whatever it is.
        # Nothing may leave here: a program built as a window would show it in a box of a process nobody sees.
        import traceback

        traceback.print_exc()
        try:
            tell("error", message=f"ตัวอ่าน CAD ทำงานไม่สำเร็จ – {type(e).__name__}: {e}")
        except OSError:
            pass
        return 3


_CHILDREN: set = set()  # the readers that are running now
_STOPPED = False


def stop_children() -> None:
    """End every reader that is running (the program is closing): else the program would stay, without a window,
    until a long import is through – or for ever, should OpenCascade hang on a broken file."""
    global _STOPPED
    _STOPPED = True
    for child in list(_CHILDREN):
        try:
            child.kill()
        except OSError:
            pass


def read_cad_isolated(path: str | Path, max_faces: int = MAX_FACES, progress=None,
                      up: str | None = None) -> a3.AssemblyModel:
    """`read_cad` in a child process (for a worker thread of the window): the thread only waits, so the window
    stays alive, and a file that crashes OpenCascade or eats all memory ends the child, not the program.
    From source the child is the Python that runs this; a built program starts itself again with CHILD_FLAG
    (see `__main__`). The child writes what it has to say to a file: that works the same for both."""
    if not have_ocp():
        raise CadImportError(INSTALL_HINT)
    handle, target = tempfile.mkstemp(prefix="rrs_cad_", suffix=".rrsasm")
    os.close(handle)
    log, said = target + ".log", target + ".out"
    Path(log).write_bytes(b"")
    args = [str(Path(path).resolve()), target, str(int(max_faces)), up or "", log]
    if getattr(sys, "frozen", False):
        command = [sys.executable, CHILD_FLAG, *args]
    else:
        command = [sys.executable, "-c", _CHILD, str(Path(__file__).resolve().parents[2]), *args]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    # what the child prints goes to a file: without this Python keeps it in a buffer, and a crash takes it along
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    outcome = None

    pending = b""

    def read_messages(stream) -> None:
        nonlocal outcome, pending
        *lines, pending = (pending + stream.read()).split(b"\n")  # the last piece is a line still being written
        for line in lines:
            text = line.decode("utf-8", "replace")
            if not text.startswith(_MARK):
                continue
            message = json.loads(text[len(_MARK):])
            if message["kind"] == "progress":
                if progress:
                    progress(message["stage"], message["fraction"])
            else:
                outcome = message

    try:
        with open(said, "wb") as out, open(log, "rb") as messages:
            with subprocess.Popen(command, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                  creationflags=flags, env=env) as child:
                _CHILDREN.add(child)
                try:
                    while child.poll() is None:
                        read_messages(messages)
                        time.sleep(0.05)
                except BaseException:  # the progress callback raised: do not wait for the reader to finish
                    child.kill()
                    raise
                finally:
                    _CHILDREN.discard(child)
                code = child.wait()
            read_messages(messages)
        if _STOPPED:
            raise CadImportError("ยกเลิกการนำเข้า – โปรแกรมกำลังปิด")
        if outcome and outcome["kind"] == "error":
            raise CadImportError(outcome["message"])
        if not outcome or code != 0:
            text = Path(said).read_text(encoding="utf-8", errors="replace")  # what OpenCascade or Python said before it died
            tail = [t.strip() for t in text.splitlines() if t.strip() and not t.startswith(_MARK)][-5:]
            raise CadImportError(f"ตัวอ่าน CAD หยุดทำงานกลางคัน (รหัส {code}) – ไฟล์อาจเสีย หรือหน่วยความจำไม่พอสำหรับไฟล์ขนาดนี้"
                                 + (" · " + " | ".join(tail) if tail else ""))
        return a3.AssemblyModel.load(target)
    finally:
        for leftover in (target, log, said):
            try:
                os.remove(leftover)
            except OSError:
                pass
