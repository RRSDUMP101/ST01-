"""นำเข้าโมเดล CAD จริง (IGES / STEP) เข้าคู่มือประกอบ 3 มิติ – อ่านด้วย OpenCascade (pip install cadquery-ocp → โมดูล OCP).

ไม่ใช้ Qt. OpenCascade is an optional dependency: it is imported when a file is read, so the program (and
`partlist_studio.core`) imports and runs without it. หน่วยของผลลัพธ์ = มม. เสมอ ไม่ว่าไฟล์จะเป็นนิ้ว เมตร หรือ มม.

* `read_cad(path, max_faces, progress)` – the file → `AssemblyModel` whose parts are the real parts
* `read_cad_report(...)` – the same, with what was done (`CadReport`: unit, how the parts were found, time)
* `read_cad_isolated(...)` – the same in a child process: OpenCascade keeps Python's lock while it works, so a
  thread alone would still freeze the window; and a crash or out-of-memory there does not take the program down

What is a part
    1. every instance of a leaf of the assembly tree (STEP through XDE: names, colours, placements);
    2. inside a leaf - or in a file without a tree, as IGES usually is - every solid, and every shell that is not
       part of a solid;
    3. faces that belong to no shell (IGES trimmed surfaces, type 144) are sewn (`SEW_TOL`), and every connected
       shell that comes out is a part; when more than `LOOSE_MAX` faces stay alone they are sewn again more
       loosely (`SEW_RETRY_TOL`), then linked by the edges they share (`LINK_GRID`), then put together by IGES
       level or by colour - so that a file of 5,000 loose surfaces does not become 5,000 "parts".
`AssemblyModel.note` tells which of these were used.

The view is a software renderer and a .rrsasm is JSON, so the whole model keeps within `max_faces` triangles:
the parts are meshed finer or coarser as a whole (`LEVELS`), and when the coarsest mesh is still too much the
smallest parts (bolts, washers) are shown as their bounding boxes. No part is dropped.
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
INSTALL_HINT = ("อ่านไฟล์ STEP / IGES ต้องติดตั้ง OpenCascade เพิ่ม (ครั้งเดียว) – เปิด Command Prompt แล้วพิมพ์\n\n"
                "    pip install cadquery-ocp\n\n"
                "แล้วเปิดโปรแกรมใหม่ · หรือส่งออกจาก CAD เป็น OBJ / STL ซึ่งไม่ต้องติดตั้งอะไรเพิ่ม")
SEW_TOL = 0.05  # mm: the gap between two trimmed surfaces of one part in a healthy IGES
SEW_RETRY_TOL = 0.5  # mm: the second try, for the faces the first left alone (still thinner than any sheet)
LINK_GRID = 2.0  # mm: two loose faces whose edges end and bend at the same places (to this) are one part
LOOSE_MAX = 200  # more single faces than this after sewing: they are grouped instead of being a part each
BOX_FACES = 12  # what a part shown as its bounding box costs
RAW_NAME_SECONDS = 20.0  # the most time spent on looking up IGES names that came through spoiled
# how fine the mesh is: (deflection as a share of the part's size, the most it may be in mm, angle in radians).
# The last one is the floor: a 50 mm bracket keeps its form (a hole is still six-sided), nothing coarser is tried.
LEVELS = ((0.004, 2.0, 0.35), (0.01, 4.0, 0.6), (0.025, 8.0, 0.9), (0.06, 15.0, 1.2))
MIN_DEFLECTION = 0.02
# memory the reader needs for a file of 1 byte (measured, see tests/test_cad_import.py::test_measure): below
# this much free memory the file is refused before the machine starts to swap or the system kills the program
MEMORY_PER_BYTE = {"IGES": 6.0, "STEP": 6.0}
BIG, SMALL = 1000.0, 100.0  # mm: parts without a name, a level or an assembly are grouped by their size
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
        from OCP.TopAbs import (TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX)
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS, TopoDS_Compound
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
    faces: int = 0
    count: int = 0  # triangles at the level that is meshed now
    tris: object = None  # (n, 3, 3) array in its own frame
    cull: bool = False
    extent: tuple = (0.0, 0.0, 0.0)
    uses: int = 0
    no: int = 0  # 'ชิ้นที่ N' when it has no name


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


@dataclass
class _Pool:
    """Faces of one leaf that are in no shell: sewn together once, placed for every instance of the leaf."""

    faces: list = field(default_factory=list)  # (face, name, colour, layer)
    uses: list = field(default_factory=list)  # (place, leaf id, leaf name, parent, colour, layer)


class _Import:
    def __init__(self, path: str | Path, max_faces: int, progress):
        self.path = Path(path)
        self.max_faces = max(int(max_faces), BOX_FACES)
        self.progress = progress
        self.o = _occ()
        self.report = CadReport(str(self.path))
        self.bodies: list[_Body] = []
        self.forms: dict[object, _Shape] = {}
        self.pools: dict[str, _Pool] = {}
        self.notes: list[str] = []
        self.stage = ""
        self._leaf_cache: dict[str, list] = {}
        self._raw_names: dict[object, str] = {}
        self._raw_spent = 0.0
        self._reader = None
        self._clock = time.perf_counter()
        self.tree = False  # the file has an assembly tree
        self.skipped = 0  # things in the file without a surface (curves, points)
        self.unmeshed = 0  # faces OpenCascade could not mesh

    # ---- progress
    def say(self, stage: str, fraction: float) -> None:
        now = time.perf_counter()
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
        need = size * MEMORY_PER_BYTE[self.report.kind]
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

    def _walk(self, label, loc, parent: str, colour: str, layer: str, top: bool, many: bool, path: str) -> None:
        o, tool = self.o, self.o.XCAFDoc_ShapeTool
        name = self._name(label)
        colour = self._colour(label) or colour
        layer = self._layer(label) or layer
        if tool.IsAssembly_s(label):
            self.tree = True
            comps = o.TDF_LabelSequence()
            tool.GetComponents_s(label, comps, False)
            below = name if (not top or many) else ""  # the one top assembly is the whole thing, not a group
            for i in range(1, comps.Length() + 1):
                comp, ref = comps.Value(i), o.TDF_Label()
                if tool.GetReferredShape_s(comp, ref):
                    self._walk(ref, loc.Multiplied(tool.GetLocation_s(comp)), below or parent,
                               self._colour(comp) or colour, self._layer(comp) or layer, False, many, f"{path}.{i}")
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
                pool.faces.append((face, name or own[0], colour or own[1], layer or own[2]))
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
        for key, pool in self.pools.items():
            groups = self._sew_faces(pool.faces, counts)
            for place, leaf, leaf_name, parent, colour, layer in pool.uses:
                for form, name, own_colour, own_layer in groups:
                    self.bodies.append(_Body(form, place, leaf, leaf_name, name, parent, own_colour or colour,
                                             own_layer or layer))
            done += len(pool.faces)
            self.say("เย็บผิว", 0.66 + 0.1 * done / total)
            pool.faces = []
        self.pools = {}
        gc.collect()
        said = [f"เย็บผิวอิสระ {total:,} ผิว (ค่าเผื่อ {SEW_TOL:g} มม.) ได้ {counts['sewn']:,} เปลือก"]
        if counts["retry"]:
            said.append(f"เย็บซ้ำแบบหลวม ({SEW_RETRY_TOL:g} มม.) ได้อีก {counts['retry']:,} เปลือก")
        for how, text in (("linked", "รวมผิวที่ขอบต่อกัน"), ("level", "รวมผิวตาม level ของ IGES"), ("colour", "รวมผิวตามสี"),
                          ("rest", "รวมผิวเดี่ยวที่เหลือเป็นชิ้นเดียว")):
            if counts[how]:
                said.append(f"{text} {counts[how + '_faces']:,} ผิว เป็น {counts[how]:,} ชิ้น")
        if counts["face"]:
            said.append(f"ผิวเดี่ยว {counts['face']:,} ผิว เป็นชิ้นละผิว")
        self.report.methods.append(" → ".join(said))

    def _attrs(self, faces: list, picked: list[int]) -> tuple[str, str, str]:
        """Name, colour and level of a group of faces: what most of them say."""
        out = []
        for col in (1, 2, 3):
            seen = Counter(faces[i][col] for i in picked if faces[i][col])
            out.append(seen.most_common(1)[0][0] if seen else "")
        return tuple(out)

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

    def _sew_faces(self, faces: list, counts: Counter) -> list[tuple[_Shape, str, str, str]]:
        """The loose faces of one pool → forms with their name, colour and level."""
        out = []
        alone = list(range(len(faces)))
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
                for col, by in ((3, "level"), (2, "colour")):
                    keys = {faces[i][col] for i in alone}
                    if len(keys) > 1:
                        groups, how = [[i for i in alone if faces[i][col] == k] for k in sorted(keys)], by
                        break
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
                out.append((self._form(faces[i][0], "face"), *faces[i][1:]))
            counts["face"] += len(alone)
        return out

    def _compound(self, shapes: list, how: str) -> _Shape:
        o = self.o
        compound = o.TopoDS_Compound()
        builder = o.BRep_Builder()
        builder.MakeCompound(compound)
        for s in shapes:
            builder.Add(compound, s)
        return self._form(compound, how)

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
        o = self.o
        for body in self.bodies:
            body.form.uses += 1
        number = 0
        for form in self.forms.values():
            if not form.uses:
                continue
            box = o.Bnd_Box()
            o.BRepBndLib.Add_s(form.shape, box, False)
            if not box.IsVoid():
                lo, hi = box.CornerMin(), box.CornerMax()
                form.diag = math.dist((lo.X(), lo.Y(), lo.Z()), (hi.X(), hi.Y(), hi.Z()))
            form.faces = len(_explore(o, form.shape, o.TopAbs_FACE))
            number += 1
            form.no = number
        self.report.faces_in_file = sum(f.faces for f in self.forms.values() if f.uses)

    def _mesh(self, level: int, clean: bool) -> int:
        """Meshes every form at a level; forms of about one size go in together, so that the faces of all of
        them are spread over the processors. Returns the triangles of the whole model."""
        o = self.o
        share, most, angle = LEVELS[level]
        batches: dict[float, list[_Shape]] = {}
        for form in self.forms.values():
            if form.uses:
                deflection = min(max(share * form.diag, MIN_DEFLECTION), most)
                step = 10 ** math.floor(math.log10(deflection))
                deflection = max(m for m in (1, 2, 5) if m * step <= deflection * 1.0001) * step
                batches.setdefault(deflection, []).append(form)
        done, count = 0, sum(len(b) for b in batches.values())
        for deflection, forms in sorted(batches.items()):
            compound = o.TopoDS_Compound()
            builder = o.BRep_Builder()
            builder.MakeCompound(compound)
            for form in forms:
                builder.Add(compound, form.shape)
            if clean:
                o.BRepTools.Clean_s(compound)  # or the finer mesh, good enough for the coarser one, would be kept
            o.BRepMesh_IncrementalMesh(compound, deflection, False, angle, True)
            done += len(forms)
            self.say(f"สร้างตาข่าย (ระดับ {level + 1}/{len(LEVELS)})", 0.78 + 0.04 * level + 0.04 * done / count)
        total = 0
        still = o.TopLoc_Location()
        for form in self.forms.values():
            if form.uses:
                form.count = 0
                for f in _explore(o, form.shape, o.TopAbs_FACE):
                    tri = o.BRep_Tool.Triangulation_s(o.face(f), still)
                    form.count += tri.NbTriangles() if tri is not None else 0
                total += form.count * form.uses
        return total

    def mesh(self) -> None:
        self.say(f"สร้างตาข่าย (ระดับ 1/{len(LEVELS)})", 0.78)
        last = len(LEVELS) - 1
        instances = sum(f.faces * f.uses for f in self.forms.values())
        # two triangles a face is the least there can be: when even that is over the budget, only the floor is tried
        level = last if 2 * instances > self.max_faces else 0
        clean = False
        while True:
            total = self._mesh(level, clean)
            if total <= self.max_faces or level == last:
                break
            level, clean = level + 1, True
        self.report.level = level
        if total > self.max_faces:
            total = self._box_small(total)
        self.say("เก็บตาข่าย", 0.94)
        for form in self.forms.values():
            if form.uses:
                self._triangles(form)
        text = f"ตาข่ายระดับ {level + 1}/{len(LEVELS)}"
        self.notes.append(text + (" (หยาบสุด)" if level == last and last else ""))

    def _box_small(self, total: int) -> int:
        """Still over the budget at the coarsest mesh: the smallest parts become their bounding boxes."""
        least = len(self.bodies) * BOX_FACES
        if least > self.max_faces:
            raise CadImportError(
                f"โมเดลมี {len(self.bodies):,} ชิ้น – แม้แสดงทุกชิ้นเป็นกล่องก็ต้องใช้ {least:,} หน้า เกินงบ {self.max_faces:,} หน้า · "
                f"เพิ่มงบ (tools/cad_to_rrsasm.py --max-faces {least * 2:,}) หรือส่งออกจาก CAD ทีละชุดประกอบย่อย")
        biggest = 0.0
        for body in sorted(self.bodies, key=lambda b: b.form.diag):
            if total <= self.max_faces:
                break
            if body.form.count > BOX_FACES:
                body.boxed = True
                total -= body.form.count - BOX_FACES
                biggest = max(biggest, body.form.diag)
                self.report.boxed += 1
        if total > self.max_faces:  # the parts that were left are those a box does not make cheaper
            raise CadImportError(f"ลดจำนวนหน้าให้อยู่ในงบ {self.max_faces:,} หน้าไม่ได้ – เพิ่มงบ --max-faces")
        self.notes.append(f"เกินงบ {self.max_faces:,} หน้าแม้ตาข่ายหยาบสุด: แสดงชิ้นเล็ก {self.report.boxed:,} ชิ้น "
                          f"(ไม่เกิน {biggest:,.0f} มม.) เป็นกล่อง")
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
            lo, hi = tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0)
            form.extent = tuple(sorted((float(v) for v in hi - lo), reverse=True))
            closed, volume = _closed(tris)
            if closed and volume < 0:  # a solid written inside out (IGES does that): turned
                tris = tris[:, ::-1]
            form.cull = closed and abs(volume) > 1e-6
        form.tris = tris
        o.BRepTools.Clean_s(form.shape)

    # ---- 5. the model
    def build(self) -> a3.AssemblyModel:
        import numpy as np

        self.say("จัดกลุ่มชิ้นส่วน", 0.96)
        names = self._names()
        layers = {b.layer for b in self.bodies if b.layer}
        parts: list[a3.Part3D] = []
        by_size = False
        empty = 0
        for body, name in zip(self.bodies, names):
            form = body.form
            m = _matrix(body.place)
            tris = form.tris
            if len(tris) and m is not None:
                tris = tris @ m[0].T + m[1]
                if np.linalg.det(m[0]) < 0:  # a mirrored instance: the same faces seen from the other side
                    tris = tris[:, ::-1]
            if name:
                group = body.parent or a3._group_of(name)
            elif body.layer and len(layers) > 1:
                group = f"เลเยอร์ {body.layer}"
            elif body.parent:
                group = body.parent
            else:
                group = SIZE_GROUPS[0 if form.diag >= BIG else 1 if form.diag >= SMALL else 2]
                by_size = True
            part = a3.Part3D(f"c{len(parts) + 1}", name or f"ชิ้นที่ {form.no}", group, "mesh", color=body.color or a3.STEEL,
                             size="×".join(f"{v:.0f}" for v in form.extent) if any(form.extent) else "")
            if not len(tris):  # OpenCascade made no triangle of it: its bounding box, so that it is not lost
                corners = self._box_corners(form, m)
                if corners is None:
                    empty += 1
                    continue
                tris, body.boxed = corners, True
                part.note = "สร้างตาข่ายไม่ได้ – แสดงเป็นกล่อง"
            if body.boxed:
                pts = tris.reshape(-1, 3)
                lo, hi = np.round(pts.min(axis=0), 2), np.round(pts.max(axis=0), 2)
                part.shape, part.pos = "box", [float(v) for v in lo]
                part.dims = [max(float(v), 0.01) for v in hi - lo]
                part.note = part.note or "ชิ้นเล็ก – แสดงเป็นกล่องเพื่อให้อยู่ในงบจำนวนหน้า"
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
        if not parts:
            raise CadImportError(f"สร้างตาข่ายจากไฟล์ {self.path.name} ไม่ได้เลย – รูปทรงในไฟล์เสีย")
        if by_size:  # big parts first: the frame is fitted before its bolts
            parts.sort(key=lambda p: SIZE_GROUPS.index(p.group) if p.group in SIZE_GROUPS else -1)
            for i, p in enumerate(parts, 1):
                p.id = f"c{i}"
        model = a3.AssemblyModel(self.path.stem, parts, source="file")
        a3.auto_steps(model)
        a3.auto_explode(model)
        report = self.report
        report.parts, report.groups = len(parts), len(model.groups())
        report.triangles = a3.face_count(model)
        report.bounds = [[round(float(v), 2) for v in corner] for corner in model.bounds()]
        solids = sum(1 for b in self.bodies if b.form.how == "solid")
        shells = sum(1 for b in self.bodies if b.form.how == "shell")
        how = ([f"solid {solids:,} ชิ้น"] if solids else []) + ([f"เปลือก (shell) {shells:,} ชิ้น"] if shells else [])
        if self.tree:
            how.insert(0, "ตามโครงสร้างชุดประกอบในไฟล์")
        report.methods[:0] = how
        if by_size:
            self.notes.append("ชิ้นที่ไม่มีชื่อจัดกลุ่มตามขนาด")
        if self.skipped:
            self.notes.append(f"ข้ามเส้น/จุดที่ไม่มีผิว {self.skipped:,} รายการ")
        if self.unmeshed:
            self.notes.append(f"ผิวที่สร้างตาข่ายไม่ได้ {self.unmeshed:,} ผิว")
        if empty:
            self.notes.append(f"ชิ้นที่ไม่มีรูปทรงให้แสดง {empty:,} ชิ้นถูกข้าม")
        model.note = " · ".join([f"นำเข้าจาก {report.kind} ({report.reader}) หน่วยในไฟล์: {report.unit} → มม.",
                                 f"แยกชิ้น: {report.method()}",
                                 f"{report.parts:,} ชิ้น {report.triangles:,} หน้า", *self.notes])
        return model

    def _box_corners(self, form: _Shape, m):
        import numpy as np

        box = self.o.Bnd_Box()
        self.o.BRepBndLib.Add_s(form.shape, box, False)
        if box.IsVoid():
            return None
        lo, hi = box.CornerMin(), box.CornerMax()
        pts = np.array([[x, y, z] for x in (lo.X(), hi.X()) for y in (lo.Y(), hi.Y()) for z in (lo.Z(), hi.Z())])
        return pts if m is None else pts @ m[0].T + m[1]

    def _names(self) -> list[str]:
        """The name of every body: its own, or that of its leaf - numbered when the leaf holds several different
        forms ('FRAME.1', 'FRAME.2'), the same for the same form so that the parts table counts them."""
        inside: dict[str, list] = {}
        for body in self.bodies:
            if not body.name:
                forms = inside.setdefault(body.leaf, [])
                if body.form.key not in forms:
                    forms.append(body.form.key)
        out = []
        for body in self.bodies:
            if body.name or not body.leaf_name:
                out.append(body.name)
            elif len(inside[body.leaf]) == 1:
                out.append(body.leaf_name)
            else:
                out.append(f"{body.leaf_name}.{inside[body.leaf].index(body.form.key) + 1}")
        return out


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
def read_cad_report(path: str | Path, max_faces: int = 60000, progress=None) -> tuple[a3.AssemblyModel, CadReport]:
    """An IGES or STEP file → the model (mm) and the report of what was done. `progress(stage, fraction)` is
    called with a Thai stage text and 0 … 1. Raises `CadImportError` with a message for the user."""
    start = time.perf_counter()
    run = None
    try:
        run = _Import(path, max_faces, progress)
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


def read_cad(path: str | Path, max_faces: int = 60000, progress=None) -> a3.AssemblyModel:
    """An IGES or STEP file exported from CAD → `AssemblyModel` in mm, at most `max_faces` triangles, with a step
    per group and an exploded position per part (see the top of this module for what a part is)."""
    return read_cad_report(path, max_faces, progress)[0]


_MARK = "@@rrs-cad "
_CHILD = ("import sys; sys.path[0] = sys.argv.pop(1); from partlist_studio.core.cad_import import _child; "
          "sys.exit(_child(sys.argv[1:]))")


def _child(argv: list[str]) -> int:
    """The other end of `read_cad_isolated`: progress and the outcome as marked lines of JSON on standard output."""
    source, target, max_faces = argv[0], argv[1], int(argv[2])

    def tell(kind: str, **data) -> None:
        sys.stdout.write(_MARK + json.dumps({"kind": kind, **data}) + "\n")  # ASCII: no code page in the way
        sys.stdout.flush()

    try:
        model, report = read_cad_report(source, max_faces, lambda stage, fraction: tell("progress", stage=stage, fraction=fraction))
        model.save(target)
        tell("done", report=asdict(report))
        return 0
    except CadImportError as e:
        tell("error", message=str(e))
        return 2


def read_cad_isolated(path: str | Path, max_faces: int = 60000, progress=None) -> a3.AssemblyModel:
    """`read_cad` in a child process (for a worker thread of the window): the thread only waits, so the window
    stays alive, and a file that crashes OpenCascade or eats all memory ends the child, not the program.
    In a frozen build there is no interpreter to start: the file is read here."""
    if getattr(sys, "frozen", False):
        return read_cad(path, max_faces, progress)
    if not have_ocp():
        raise CadImportError(INSTALL_HINT)
    handle, target = tempfile.mkstemp(prefix="rrs_cad_", suffix=".rrsasm")
    os.close(handle)
    root = str(Path(__file__).resolve().parents[2])
    command = [sys.executable, "-c", _CHILD, root, str(Path(path).resolve()), target, str(int(max_faces))]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    outcome, tail = None, []
    try:
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                              text=True, encoding="utf-8", errors="replace", creationflags=flags) as child:
            for line in child.stdout:
                if not line.startswith(_MARK):
                    tail = (tail + [line.rstrip()])[-5:]  # what OpenCascade or Python said before it died
                    continue
                message = json.loads(line[len(_MARK):])
                if message["kind"] == "progress":
                    if progress:
                        progress(message["stage"], message["fraction"])
                else:
                    outcome = message
            code = child.wait()
        if outcome and outcome["kind"] == "error":
            raise CadImportError(outcome["message"])
        if not outcome or code != 0:
            raise CadImportError(f"ตัวอ่าน CAD หยุดทำงานกลางคัน (รหัส {code}) – ไฟล์อาจเสีย หรือหน่วยความจำไม่พอสำหรับไฟล์ขนาดนี้"
                                 + (" · " + " | ".join(t for t in tail if t) if any(tail) else ""))
        return a3.AssemblyModel.load(target)
    finally:
        try:
            os.remove(target)
        except OSError:
            pass
