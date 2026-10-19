"""Laser cutting (ตัดเลเซอร์) - from the flat patterns of the drawings to the files and the queue of the laser.

    DWG flat patterns ─► คลังรูปคลี่ (one per part code, kept from every drawing import)
      ─► what to cut: the Part List × beds, or the open jobs (pieces still before ตัด, minus the pieces
         already in a cut program)
      ─► checks before cutting: holes smaller than the thickness, holes too close to an edge, tiny parts,
         loops drawn twice, parts bigger than the sheet
      ─► nesting per material / thickness (nesting.plan) ─► cut programs (sheets laid out the same way are
         one program cut N times)
      ─► laser package: a DXF per program and per part (mm, holes as true circles, layers CUT_OUTER /
         CUT_INNER / MARK), PNG previews and the cut order (Excel)
      ─► queue: รอตัด → กำลังตัด → ตัดแล้ว - the job parts pass ตัด (so they show รอพับ) and a PD draft issues
         the sheets that were cut
Cutting time = cut length ÷ speed + pierces × pierce time, plus travel and sheet handling. The default speeds
are estimates for the company's HSG 12,000 W fiber laser (bed 8,000 × 2,500 mm); set them to the machine's own
cutting table.
"""

from __future__ import annotations

import bisect
import math
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path

from .cad_fix import FIX_LABELS, FIX_OPEN_IN_PART
from .dwg_io import outline_net_area
from .models import PartList
from .movements import DocLine, Ledger, StockDoc
from .nesting import NestGroup, NestParams, NestPart, Placement, nest_parts_from, place_point
from .stock import _key, material_family

CUT_STEP = "ตัด"
ST_WAIT = "รอตัด"
ST_CUTTING = "กำลังตัด"
ST_DONE = "ตัดแล้ว"
ST_CANCELLED = "ยกเลิก"
PROGRAM_STATUSES = [ST_WAIT, ST_CUTTING, ST_DONE, ST_CANCELLED]
OPEN = {ST_WAIT, ST_CUTTING}

ERROR = "error"
WARN = "warn"
INFO = "info"  # repaired by the check before cutting: nothing to do, only shown
LEVEL_TEXT = {ERROR: "ต้องแก้", WARN: "ควรตรวจ", INFO: "แก้แล้ว"}
MARK_BENDS = {"off": "ไม่มาร์ค", "ticks": "มาร์คปลายเส้นพับ (ขีดสั้นที่ขอบ)", "full": "มาร์คเส้นพับเต็มเส้น"}
JOINTS = {"off": "ไม่เว้น (ตัดขาดทุกชิ้น)", "small": "เฉพาะชิ้นเล็ก", "all": "ทุกชิ้น"}

# mm/min by material family and thickness (mm), and seconds per pierce by thickness.
# HSG 12,000 W (the company's machine): steel 2 mm from the machine's own technic "12000-Carbon Steel-2.000"
# (Big Graph 38,000 mm/min, N2 12 bar, pierce 40 ms); the other values are estimates - steel with air/N2 up to
# 12 mm and O2 above, SUS / AL with N2.
SPEEDS_12KW: dict[str, dict[float, float]] = {
    "STEEL": {1: 45000, 1.5: 40000, 2: 38000, 2.5: 30000, 3: 26000, 4: 20000, 5: 16000, 6: 12000, 8: 7500,
              10: 5000, 12: 3500, 14: 2600, 16: 2000, 20: 1400, 25: 1000, 30: 750},
    "GALV": {1: 40000, 1.5: 35000, 2: 30000, 3: 22000, 4: 16000, 5: 12000},
    "SUS": {1: 50000, 1.5: 45000, 2: 38000, 3: 26000, 4: 19000, 5: 14000, 6: 11000, 8: 6500, 10: 4500, 12: 3200,
            16: 1800, 20: 1100, 25: 650},
    "AL": {1: 40000, 2: 30000, 3: 20000, 4: 14000, 5: 10000, 6: 7500, 8: 4500, 10: 3200, 12: 2300, 16: 1200, 20: 700},
}
PIERCE_12KW: dict[float, float] = {1: 0.04, 2: 0.04, 3: 0.2, 5: 0.3, 8: 0.6, 12: 1.0, 16: 1.5, 20: 2.5, 25: 3.5, 30: 5.0}
# a typical 3 kW fiber laser (O2 for steel, N2 for SUS / AL): the defaults of the first version
SPEEDS_3KW: dict[str, dict[float, float]] = {
    "STEEL": {1: 25000, 1.5: 15000, 2: 8000, 2.5: 6000, 3: 4500, 4: 3500, 5: 3000, 6: 2500, 8: 1800, 10: 1400,
              12: 1100, 16: 800, 20: 600},
    "GALV": {1: 22000, 1.5: 14000, 2: 7000, 3: 4000},
    "SUS": {1: 25000, 1.5: 16000, 2: 10000, 3: 4500, 4: 2800, 5: 1800, 6: 1200, 8: 700},
    "AL": {1: 20000, 2: 8000, 3: 3500, 4: 2000, 5: 1200, 6: 800},
}
PIERCE_3KW: dict[float, float] = {1: 0.3, 3: 0.5, 5: 1.0, 8: 2.0, 12: 3.0, 20: 5.0}
# name -> (speeds, pierce, bed width, bed length mm)
MACHINES: dict[str, tuple[dict, dict, float, float]] = {
    "HSG 12,000W": (SPEEDS_12KW, PIERCE_12KW, 2500.0, 8000.0),
    "Fiber 3,000W (ทั่วไป)": (SPEEDS_3KW, PIERCE_3KW, 1500.0, 3000.0),
}
DEFAULT_MACHINE = "HSG 12,000W"
_OLD_SPEEDS_12KW = {f: dict(t) for f, t in SPEEDS_12KW.items()}
_OLD_SPEEDS_12KW["STEEL"][2] = 35000  # the first HSG table (estimates only)
_OLD_PIERCE_12KW = {1: 0.1, 3: 0.2, 5: 0.3, 8: 0.6, 12: 1.0, 16: 1.5, 20: 2.5, 25: 3.5, 30: 5.0}
DEFAULT_SPEEDS = SPEEDS_12KW
DEFAULT_PIERCE = PIERCE_12KW


def _interp(table: dict, x: float) -> float:
    pts = sorted((float(k), float(v)) for k, v in table.items())
    if not pts:
        return 0.0
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


@dataclass
class LaserParams:
    gap: float = 5.0  # between parts on the sheet (kerf + bridge), mm
    margin: float = 10.0  # at the sheet edge, mm
    rotate: bool = True
    speeds: dict = field(default_factory=lambda: {f: dict(t) for f, t in DEFAULT_SPEEDS.items()})
    pierce: dict = field(default_factory=lambda: dict(DEFAULT_PIERCE))
    travel_pct: float = 15.0  # rapid moves and head lifts, % of the cutting time
    sheet_minutes: float = 3.0  # load and unload one sheet
    rate_per_hour: float = 0  # baht per machine hour (0 = do not show a cost)
    hole_factor: float = 1.0  # smallest hole = thickness × factor
    edge_factor: float = 1.0  # smallest web between a hole and the edge = thickness × factor
    small_part: float = 25.0  # parts smaller than this (mm) can tip up or fall through the slats
    dxf_version: str = "R2000"  # R12 for old laser software
    layer_outer: str = "CUT_OUTER"
    layer_inner: str = "CUT_INNER"
    layer_mark: str = "MARK"
    mark_codes: bool = False  # write the part code on the MARK layer (engraving)
    sheet_outline: bool = False  # draw the sheet border on layer SHEET (most laser software would cut it)
    machine: str = DEFAULT_MACHINE
    # DXF colour (AutoCAD index 1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white) of each layer:
    # laser software that sorts by colour puts the contours on its own layers by it
    color_outer: int = 1
    color_inner: int = 4
    color_mark: int = 3
    bed_w: float = 2500.0  # largest sheet the machine takes, mm
    bed_l: float = 8000.0
    # spacing (Gap between parts): at least the gap, thick plates thickness × gap_per_mm
    gap_per_mm: float = 1.0
    align_parts: bool = True  # turn a part drawn at an angle to its smallest blank before nesting
    # marks on the MARK layer (engraved, not cut through): bend lines for the press brake
    mark_bends: str = "off"  # off | ticks | full (MARK_BENDS)
    mark_tick: float = 10.0  # mm of each tick at the two ends of a bend line
    # Gap / micro-joint: short pieces of the outer contour left uncut so the part stays in the sheet
    joints: str = "off"  # off | small | all (JOINTS)
    joint_width: float = 0.5  # mm left uncut at each joint
    joint_count: int = 0  # joints per part, 0 = by size (2 up to 600 mm around, then 1 per 600 mm, at most 8)
    joint_small: float = 150.0  # "small" parts: longest side under this, mm

    def nest_params(self) -> NestParams:
        return NestParams(self.gap, self.margin, self.rotate, self.gap_per_mm, self.align_parts)

    def joints_for(self, part) -> int:
        """Number of micro-joints on the outer contour of this part (0 = cut free)."""
        if self.joints == "off" or self.joint_width <= 0:
            return 0
        if self.joints == "small" and max(part.width, part.height) >= self.joint_small:
            return 0
        if self.joint_count > 0:
            return self.joint_count
        around = loop_length(part.outline[0]) if part.outline else 2 * (part.width + part.height)
        return max(2, min(8, math.ceil(around / 600)))

    def speed(self, family: str, thickness: float) -> float:
        table = self.speeds.get(family) or self.speeds.get("STEEL") or DEFAULT_SPEEDS["STEEL"]
        return _interp(table, thickness)

    def pierce_seconds(self, thickness: float) -> float:
        return _interp(self.pierce, thickness)

    def fits_bed(self, w: float, h: float) -> bool:
        return not (self.bed_w and self.bed_l) or (min(w, h) <= self.bed_w and max(w, h) <= self.bed_l)

    def use_machine(self, name: str) -> None:
        """Speeds, pierce times and bed of a machine of MACHINES."""
        speeds, pierce, bed_w, bed_l = MACHINES[name]
        self.machine, self.bed_w, self.bed_l = name, bed_w, bed_l
        self.speeds = {f: dict(t) for f, t in speeds.items()}
        self.pierce = dict(pierce)

    def in_table(self, family: str, thickness: float) -> bool:
        table = self.speeds.get(family) or {}
        return bool(table) and thickness <= max(float(k) for k in table)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["speeds"] = {f: {f"{float(k):g}": v for k, v in t.items()} for f, t in self.speeds.items()}
        data["pierce"] = {f"{float(k):g}": v for k, v in self.pierce.items()}
        return data

    @classmethod
    def from_dict(cls, data: dict) -> LaserParams:
        p = cls()
        for key, value in (data or {}).items():
            if key == "speeds" and isinstance(value, dict):
                p.speeds = {str(f): {float(k): float(v) for k, v in t.items()} for f, t in value.items() if t}
            elif key == "pierce" and isinstance(value, dict):
                p.pierce = {float(k): float(v) for k, v in value.items()}
            elif hasattr(p, key):
                default = getattr(p, key)
                try:
                    setattr(p, key, type(default)(value) if not isinstance(default, bool) else bool(value))
                except (TypeError, ValueError):
                    pass
        if "machine" not in (data or {}) and _same_table(p.speeds, SPEEDS_3KW) and _same_table(
                {"": p.pierce}, {"": PIERCE_3KW}):
            p.use_machine(DEFAULT_MACHINE)  # saved by the first version, never tuned: the company's machine
        elif p.machine == DEFAULT_MACHINE and _same_table(p.speeds, _OLD_SPEEDS_12KW) and _same_table(
                {"": p.pierce}, {"": _OLD_PIERCE_12KW}):
            p.speeds = {f: dict(t) for f, t in SPEEDS_12KW.items()}  # the estimates before the machine's own values
            p.pierce = dict(PIERCE_12KW)
        return p


def _norm_table(table: dict) -> dict:
    return {f: {float(k): float(v) for k, v in t.items()} for f, t in table.items()}


def _same_table(a: dict, b: dict) -> bool:
    return _norm_table(a) == _norm_table(b)


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------
def loop_length(loop) -> float:
    pts = [(float(x), float(y)) for x, y in loop]
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:] + pts[:1])) if len(pts) > 1 else 0.0


def _signed_area(loop) -> float:
    pts = [(float(x), float(y)) for x, y in loop]
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])) / 2


def circle_of(loop, tol: float = 0.05) -> tuple[float, float, float] | None:
    """(cx, cy, r) when the loop is a flattened circle (every vertex on one circle)."""
    pts = [(float(x), float(y)) for x, y in loop]
    if len(pts) > 2 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts = pts[:-1]
    if len(pts) < 8:
        return None
    cx = sum(x for x, _ in pts) / len(pts)
    cy = sum(y for _, y in pts) / len(pts)
    radii = [math.dist((cx, cy), p) for p in pts]
    r = sum(radii) / len(radii)
    if r <= 0 or max(abs(d - r) for d in radii) > max(tol, 0.005 * r):
        return None
    return cx, cy, r


def cut_metrics(outline: list) -> tuple[float, int]:
    """(cut length mm, pierces) of one piece: every loop is cut and pierced once."""
    return sum(loop_length(loop) for loop in outline), len(outline)


def cut_minutes(length: float, pierces: int, family: str, thickness: float, params: LaserParams) -> float:
    speed = params.speed(family, thickness)
    cutting = (length / speed if speed else 0.0) + pierces * params.pierce_seconds(thickness) / 60
    return cutting * (1 + params.travel_pct / 100)


def _bbox(loop) -> tuple[float, float, float, float]:
    xs = [float(p[0]) for p in loop]
    ys = [float(p[1]) for p in loop]
    return min(xs), min(ys), max(xs), max(ys)


def _seg_dist(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == dy == 0:
        return math.dist(p, a)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.dist(p, (ax + t * dx, ay + t * dy))


def web_to_edge(outline: list) -> float:
    """Smallest distance between a hole and the outer contour (mm); inf without holes."""
    if len(outline) < 2:
        return math.inf
    outer = [(float(x), float(y)) for x, y in outline[0]]
    segs = list(zip(outer, outer[1:] + outer[:1]))
    best = math.inf
    for hole in outline[1:]:
        for p in hole:
            q = (float(p[0]), float(p[1]))
            for a, b in segs:
                d = _seg_dist(q, a, b)
                if d < best:
                    best = d
    return best


# --------------------------------------------------------------------------
# คลังรูปคลี่ - flat patterns by part code
# --------------------------------------------------------------------------
@dataclass
class FlatPattern:
    code: str
    name: str = ""
    material: str = ""
    thickness: float = 0
    outline: list = field(default_factory=list)  # [outer, hole ...] mm, origin at the bbox corner
    drawing_no: str = ""
    revision: str = ""
    source: str = ""  # drawing file it came from
    saved: str = field(default_factory=lambda: date.today().isoformat())
    bend_lines: list = field(default_factory=list)  # [[(x, y), (x, y)], ...] in the outline's coordinates
    fixes: list = field(default_factory=list)  # what the import repaired in its drawing

    @property
    def size(self) -> tuple[float, float]:
        if not self.outline:
            return 0.0, 0.0
        x0, y0, x1, y1 = _bbox(self.outline[0])
        return x1 - x0, y1 - y0

    @property
    def net_area(self) -> float:
        return outline_net_area(self.outline)

    @property
    def cut_length(self) -> float:
        return cut_metrics(self.outline)[0]

    @property
    def holes(self) -> int:
        return max(0, len(self.outline) - 1)


@dataclass
class FlatLibrary:
    flats: dict[str, FlatPattern] = field(default_factory=dict)  # _key(code) -> pattern

    def get(self, code: str, xref_lookup=None) -> FlatPattern | None:
        if not code:
            return None
        flat = self.flats.get(_key(code))
        if flat is None and xref_lookup is not None:
            for other in xref_lookup(code) or []:
                flat = self.flats.get(_key(other))
                if flat:
                    break
        return flat

    def add_parts(self, parts, drawing_no: str = "", revision: str = "", source: str = "") -> int:
        """Keep the flat pattern of every part with a code (a newer drawing replaces the older one)."""
        n = 0
        for part in parts:
            code = (part.part_no or "").strip()
            if not code or not getattr(part, "outline", None):
                continue
            self.flats[_key(code)] = FlatPattern(
                code=code, name=part.name, material=part.material, thickness=part.thickness,
                outline=[[(float(x), float(y)) for x, y in loop] for loop in part.outline],
                drawing_no=part.drawing_no or drawing_no, revision=revision, source=source,
                bend_lines=[[(float(x), float(y)) for x, y in line] for line in getattr(part, "bend_lines", [])],
                fixes=list(getattr(part, "cad_fixes", [])))
            n += 1
        return n

    def remove(self, codes: list[str]) -> None:
        for code in codes:
            self.flats.pop(_key(code), None)

    def items(self) -> list[FlatPattern]:
        return sorted(self.flats.values(), key=lambda f: f.code)

    def to_dict(self) -> dict:
        return {"flats": [asdict(f) for f in self.items()]}

    @classmethod
    def from_dict(cls, data: dict) -> FlatLibrary:
        lib = cls()
        for raw in (data or {}).get("flats", []):
            kw = {k: v for k, v in raw.items() if k in FlatPattern.__dataclass_fields__}
            kw["outline"] = [[(float(x), float(y)) for x, y in loop] for loop in kw.get("outline") or []]
            kw["bend_lines"] = [[(float(x), float(y)) for x, y in line] for line in kw.get("bend_lines") or []]
            kw["thickness"] = float(kw.get("thickness") or 0)
            flat = FlatPattern(**kw)
            if flat.code:
                lib.flats[_key(flat.code)] = flat
        return lib


# --------------------------------------------------------------------------
# What to cut
# --------------------------------------------------------------------------
@dataclass
class Demand:
    parts: list[NestPart] = field(default_factory=list)
    missing: list[tuple[str, str, str, float, str]] = field(default_factory=list)  # (job, code, name, qty, why)
    skipped: list[str] = field(default_factory=list)  # Part List rows left out
    source: str = ""


def demand_from_partlist(partlist: PartList, build_qty: int, default_thickness: float = 0) -> Demand:
    parts, skipped = nest_parts_from(partlist, build_qty, default_thickness)
    for p in parts:
        p.key = f"pl:{p.key}"
    info = partlist.info
    label = " ".join(x for x in (info.so_no, info.job_type, info.drawing_no) if x) or "Part List"
    return Demand(parts, [], [s.part_no or s.name for s in skipped], f"Part List {label} × {build_qty} คัน")


def job_key(job_no: str, index: int) -> str:
    return f"job|{job_no}|{index}"


def parse_job_key(key: str) -> tuple[str, int] | None:
    if not key.startswith("job|"):
        return None
    job_no, _sep, idx = key[4:].rpartition("|")
    return (job_no, int(idx)) if idx.isdigit() else None


def planned_pieces(programs: list[CutProgram]) -> dict[str, float]:
    """Pieces of each part key in programs not cut yet (so they are not planned twice)."""
    out: dict[str, float] = {}
    for prog in programs:
        if prog.status not in OPEN:
            continue
        left = prog.repeat - prog.cut_sheets
        for key, n in prog.counts().items():
            out[key] = out.get(key, 0) + n * left
    return out


def demand_from_jobs(jobs, library: FlatLibrary, programs: list[CutProgram] | None = None, xref_lookup=None,
                     default_thickness: float = 0, job_nos: list[str] | None = None) -> Demand:
    """Pieces of the open jobs still to cut: to make − passed ตัด − already in a cut program."""
    from .production import CLOSED

    planned = planned_pieces(programs or [])
    out = Demand(source="งาน " + ", ".join(job_nos) if job_nos else "งานผลิตที่ยังตัดไม่ครบ")
    for job in jobs:
        if job.status in CLOSED or (job_nos and job.job_no not in job_nos):
            continue
        for i, p in enumerate(job.parts):
            if p.to_make <= 0 or CUT_STEP not in p.route:
                continue
            key = job_key(job.job_no, i)
            left = p.to_make - p.done_at(CUT_STEP) - planned.get(key, 0)
            if left <= 0:
                continue
            flat = library.get(p.code, xref_lookup)
            if flat is None or not flat.outline:
                out.missing.append((job.job_no, p.code, p.name, left, "ไม่มีรูปคลี่ในคลัง (นำเข้าแบบ DWG ของชิ้นนี้)"))
                continue
            thickness = flat.thickness or default_thickness
            if not thickness:
                out.missing.append((job.job_no, p.code, p.name, left, "รูปคลี่ไม่มีความหนา"))
                continue
            w, h = flat.size
            material = flat.material or "SS400"
            out.parts.append(NestPart(key=key, code=p.code, name=p.name or flat.name, material=material,
                                      thickness=thickness, width=w, height=h, qty=math.ceil(left),
                                      net_area=flat.net_area, outline=flat.outline, job=job.job_no,
                                      bend_lines=flat.bend_lines, fixes=flat.fixes))
    return out


# --------------------------------------------------------------------------
# Checks before cutting
# --------------------------------------------------------------------------
@dataclass
class Issue:
    level: str  # ERROR | WARN
    code: str
    name: str
    text: str
    key: str = ""


def check_part(part: NestPart, params: LaserParams) -> list[Issue]:
    out: list[Issue] = []
    t, outline = part.thickness, part.outline

    def add(level: str, text: str) -> None:
        out.append(Issue(level, part.code, part.name, text, part.key))

    if not t:
        add(ERROR, "ไม่มีความหนา")
    family = material_family(part.material)
    if t and not params.in_table(family, t):
        add(WARN, f"ความหนา {t:g} มม. ไม่อยู่ในตารางความเร็วของ {family} – เวลาตัดเป็นค่าประมาณ")
    if not outline:
        add(WARN, "ไม่มีรูปคลี่ – วางเป็นสี่เหลี่ยมตามขนาด")
        return out
    if part.fixes:  # the check before cutting repaired its drawing: say what, and what still needs a look
        open_label = FIX_LABELS[FIX_OPEN_IN_PART]
        unfixed = [t for t in part.fixes if t.startswith(open_label)]
        done = [t for t in part.fixes if not t.startswith(open_label)]
        if unfixed:
            add(WARN, " · ".join(unfixed) + " – ไม่ถูกตัด ตรวจว่าขาดรูหรือไม่")
        if done:
            add(INFO, "แก้แบบอัตโนมัติ: " + " · ".join(done))
    if t:
        small = []
        for hole in outline[1:]:
            x0, y0, x1, y1 = _bbox(hole)
            size = min(x1 - x0, y1 - y0)
            if size < t * params.hole_factor:
                small.append(size)
        if small:
            add(WARN, f"รู {len(small)} รูเล็กกว่าความหนา (เล็กสุด {min(small):.1f} มม. < {t * params.hole_factor:g}) "
                      "– รูอาจไม่กลม/ไม่ทะลุ พิจารณาเจาะแทน")
        web = web_to_edge(outline)
        if web < t * params.edge_factor:
            add(WARN, f"รูห่างขอบชิ้นงานเพียง {web:.1f} มม. (น้อยกว่า {t * params.edge_factor:g}) – ขอบอาจละลาย/บิด")
    w, h = part.width, part.height
    if not params.fits_bed(w, h):
        add(ERROR, f"ใหญ่กว่าโต๊ะเครื่อง {w:.0f}x{h:.0f} มม. (เครื่องรับได้ {params.bed_w:.0f}x{params.bed_l:.0f})")
    if max(w, h) < params.small_part:
        if params.joints_for(part):
            add(INFO, f"ชิ้นเล็ก {w:.0f}x{h:.0f} มม. – เว้น Gap/micro-joint {params.joints_for(part)} จุดให้แล้ว")
        else:
            add(WARN, f"ชิ้นเล็ก {w:.0f}x{h:.0f} มม. – อาจกระดก/ตกร่องโต๊ะตัด ใช้ micro-joint")
    seen: dict[tuple, int] = {}
    for loop in outline:
        sig = tuple(sorted((round(float(x), 1), round(float(y), 1)) for x, y in loop))
        seen[sig] = seen.get(sig, 0) + 1
    dup = sum(n - 1 for n in seen.values() if n > 1)
    if dup:
        add(WARN, f"เส้นซ้อนกัน {dup} วง – เลเซอร์จะตัดซ้ำ ลบเส้นซ้ำในแบบ")
    return out


def check_parts(parts: list[NestPart], params: LaserParams, groups: list[NestGroup] | None = None) -> list[Issue]:
    out: list[Issue] = []
    done: set[tuple] = set()
    for p in parts:
        sig = (p.code or p.name, p.thickness, p.width, p.height, len(p.outline))
        if sig in done:  # the same part for two jobs
            continue
        done.add(sig)
        out += check_part(p, params)
    for g in groups or []:
        for size in {s.size: s for s in g.sheets}.values():
            if not params.fits_bed(size.width, size.height):
                out.append(Issue(ERROR, "", f"แผ่น {g.family} หนา {g.thickness:g}",
                                 f"แผ่น {size.width:.0f}x{size.height:.0f} ใหญ่กว่าโต๊ะเครื่อง "
                                 f"{params.bed_w:.0f}x{params.bed_l:.0f} มม.", ""))
        for p in g.too_big:
            out.append(Issue(ERROR, p.code, p.name, f"ใหญ่กว่าแผ่น {p.width:.0f}x{p.height:.0f} มม. – ไม่มีแผ่นที่วางได้",
                             p.key))
    return out


# --------------------------------------------------------------------------
# Cut programs and the laser queue
# --------------------------------------------------------------------------
@dataclass
class CutProgram:
    no: str
    material: str
    family: str
    thickness: float
    sheet_w: float
    sheet_h: float
    sheet_code: str = ""
    sheet_name: str = ""
    repeat: int = 1  # sheets laid out this same way
    items: dict = field(default_factory=dict)  # key -> {code, name, job, width, height, outline}
    placements: list = field(default_factory=list)  # {key, x, y, w, h, rotated}
    cut_length: float = 0  # one sheet, mm
    pierces: int = 0  # one sheet
    minutes: float = 0  # one sheet, cutting + travel + handling
    utilization: float = 0
    status: str = ST_WAIT
    cut_sheets: int = 0
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="minutes"))
    cut_at: str = ""
    operator: str = ""
    remnant: str = ""  # usable offcut left, e.g. "1219x600"
    source: str = ""
    pd_doc: str = ""
    files: list = field(default_factory=list)
    note: str = ""

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for pl in self.placements:
            out[pl["key"]] = out.get(pl["key"], 0) + 1
        return out

    @property
    def pieces(self) -> int:
        return len(self.placements)

    @property
    def jobs(self) -> list[str]:
        return sorted({it.get("job", "") for it in self.items.values() if it.get("job")})

    @property
    def left_sheets(self) -> int:
        return max(0, self.repeat - self.cut_sheets) if self.status != ST_CANCELLED else 0

    @property
    def total_minutes(self) -> float:
        return self.minutes * self.repeat

    @property
    def sheet_size(self) -> str:
        return f"{self.sheet_w:.0f}x{self.sheet_h:.0f}"

    @property
    def label(self) -> str:
        return f"{self.material} t{self.thickness:g}"

    def nest_part(self, key: str) -> NestPart:
        it = self.items[key]
        return NestPart(key=key, code=it.get("code", ""), name=it.get("name", ""), material=self.material,
                        thickness=self.thickness, width=it["width"], height=it["height"], qty=1,
                        outline=it.get("outline") or [], job=it.get("job", ""), bend_lines=it.get("bends") or [])

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> CutProgram:
        kw = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        for it in (kw.get("items") or {}).values():
            it["outline"] = [[(float(x), float(y)) for x, y in loop] for loop in it.get("outline") or []]
            it["bends"] = [[(float(x), float(y)) for x, y in line] for line in it.get("bends") or []]
        return cls(**kw)


@dataclass
class CutQueue:
    programs: list[CutProgram] = field(default_factory=list)
    counters: dict[str, int] = field(default_factory=dict)

    def next_no(self, when: str | None = None) -> str:
        """LC6910-0001: LC + Buddhist year (2 digits) + month + running number."""
        d = date.fromisoformat((when or date.today().isoformat())[:10])
        prefix = f"LC{(d.year + 543) % 100:02d}{d.month:02d}"
        n = self.counters.get(prefix, 0) + 1
        used = {p.no for p in self.programs}
        while f"{prefix}-{n:04d}" in used:
            n += 1
        self.counters[prefix] = n
        return f"{prefix}-{n:04d}"

    def open_programs(self) -> list[CutProgram]:
        return [p for p in self.programs if p.status in OPEN]

    def find(self, no: str) -> CutProgram | None:
        return next((p for p in self.programs if p.no == no), None)

    def to_dict(self) -> dict:
        return {"programs": [p.to_dict() for p in self.programs], "counters": dict(self.counters)}

    @classmethod
    def from_dict(cls, data: dict) -> CutQueue:
        data = data or {}
        return cls([CutProgram.from_dict(p) for p in data.get("programs", [])],
                   {k: int(v) for k, v in (data.get("counters") or {}).items()})


def _layout_signature(g: NestGroup, sheet) -> tuple:
    return (round(sheet.width), round(sheet.height),
            tuple(sorted((g.parts[pl.part].key, round(pl.x), round(pl.y), pl.rotated) for pl in sheet.placements)))


def make_programs(groups: list[NestGroup], queue: CutQueue, params: LaserParams, source: str = "") -> list[CutProgram]:
    """One program per sheet layout; the same layout on several sheets is one program × N."""
    out: list[CutProgram] = []
    for g in groups:
        runs: list[tuple[tuple, object, int]] = []
        for sheet in g.sheets:
            sig = _layout_signature(g, sheet)
            if runs and runs[-1][0] == sig:
                runs[-1] = (sig, runs[-1][1], runs[-1][2] + 1)
            else:
                runs.append((sig, sheet, 1))
        for _sig, sheet, repeat in runs:
            prog = CutProgram(no=queue.next_no(), material=g.material, family=g.family, thickness=g.thickness,
                              sheet_w=sheet.width, sheet_h=sheet.height, sheet_code=sheet.code or g.sheet_code,
                              sheet_name=sheet.name or g.sheet_name, repeat=repeat, source=source)
            length = pierces = area = 0.0
            for pl in sheet.placements:
                p = g.parts[pl.part]
                prog.items.setdefault(p.key, {"code": p.code, "name": p.name, "job": p.job, "width": p.width,
                                              "height": p.height, "outline": p.outline, "bends": p.bend_lines})
                prog.placements.append({"key": p.key, "x": pl.x, "y": pl.y, "w": pl.w, "h": pl.h,
                                        "rotated": pl.rotated})
                if p.outline:
                    lp, n = cut_metrics(p.outline)
                else:
                    lp, n = 2 * (p.width + p.height), 1
                length += lp
                pierces += n
                area += p.area
            prog.cut_length, prog.pierces = length, int(pierces)
            prog.minutes = cut_minutes(length, int(pierces), g.family, g.thickness, params) + params.sheet_minutes
            prog.utilization = area / (sheet.width * sheet.height) if sheet.width and sheet.height else 0
            out.append(prog)
    queue.programs.extend(out)
    return out


def apply_cut(prog: CutProgram, sheets: int, jobs, ledger: Ledger | None = None, operator: str = "",
              remnant: str = "", when: str | None = None) -> tuple[int, StockDoc | None]:
    """Sheets of a program were cut: its job parts pass ตัด (→ รอพับ) and a PD draft issues the sheets.
    Returns (pieces recorded on jobs, the PD draft)."""
    n = max(0, min(int(sheets), prog.repeat - prog.cut_sheets))
    if n <= 0:
        return 0, None
    recorded = 0.0
    by_no = {j.job_no: j for j in jobs}
    for key, count in prog.counts().items():
        ref = parse_job_key(key)
        if ref is None:
            continue
        job_no, idx = ref
        job = by_no.get(job_no)
        if job is None:
            continue
        code = prog.items.get(key, {}).get("code", "")
        part = job.parts[idx] if idx < len(job.parts) else None
        if part is None or (code and _key(part.code) != _key(code)):
            part = next((p for p in job.parts if code and _key(p.code) == _key(code)), None)
        if part is not None:
            recorded += job.record(part, CUT_STEP, count * n, f"ตัดเลเซอร์ {prog.no}")
    prog.cut_sheets += n
    prog.status = ST_DONE if prog.cut_sheets >= prog.repeat else ST_CUTTING
    prog.cut_at = (when or datetime.now().isoformat(timespec="minutes"))
    prog.operator = operator or prog.operator
    prog.remnant = remnant or prog.remnant
    doc = None
    if ledger is not None:
        name = prog.sheet_name or f"แผ่น{prog.material} {prog.thickness:g}มม. {prog.sheet_size}"
        doc = ledger.new_doc("PD", [DocLine(prog.sheet_code, name, n, "แผ่น", remark=prog.no)],
                             job=", ".join(prog.jobs), remark=f"ตัดเลเซอร์ {prog.no}"
                             + ("" if prog.sheet_code else " (เลือกรหัสแผ่นก่อนบันทึก)"))
        prog.pd_doc = ", ".join(x for x in (prog.pd_doc, doc.doc_no) if x)
    return int(recorded), doc


# --------------------------------------------------------------------------
# Files for the laser
# --------------------------------------------------------------------------
def _safe(text: str, fallback: str = "PART") -> str:
    """ASCII file names: some laser software cannot open Thai file names."""
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", text or "").strip("-.")
    return text[:60] or fallback


def _new_doc(params: LaserParams):
    import ezdxf

    version = params.dxf_version if params.dxf_version in ("R12", "R2000", "R2004", "R2007", "R2010") else "R2000"
    doc = ezdxf.new(version)
    doc.header["$INSUNITS"] = 4  # mm
    if version != "R12":
        doc.header["$MEASUREMENT"] = 1
    for name, color in ((params.layer_outer, params.color_outer), (params.layer_inner, params.color_inner),
                        (params.layer_mark, params.color_mark), ("SHEET", 8)):
        if name not in doc.layers:
            doc.layers.add(name, color=color)
    return doc


def _oriented(pts: list[tuple[float, float]], ccw: bool) -> list[tuple[float, float]]:
    return pts if (_signed_area(pts) > 0) == ccw else list(reversed(pts))


def micro_joints(loop: list, count: int, width: float) -> list[list[tuple[float, float]]]:
    """The closed loop as open pieces with `count` gaps of `width` mm left uncut (Gap / micro-joint).
    The gaps go in the middle of the longest straight edges, spread around the part (evenly on a curve)."""
    pts = [(float(x), float(y)) for x, y in loop]
    if len(pts) > 2 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts = pts[:-1]
    n = len(pts)
    cum = [0.0]
    for i in range(n):
        cum.append(cum[-1] + math.dist(pts[i], pts[(i + 1) % n]))
    total = cum[-1]
    if count <= 0 or n < 2 or total <= count * width * 4:
        return [pts + pts[:1]]

    def apart(pos: float, chosen: list[float], sep: float) -> bool:
        return all(min(abs(pos - c), total - abs(pos - c)) >= sep for c in chosen)

    chosen: list[float] = []
    sep = total / (2 * count)
    for i in sorted(range(n), key=lambda k: cum[k] - cum[k + 1]):  # longest edges first
        if cum[i + 1] - cum[i] < max(4 * width, 3.0) or len(chosen) == count:
            break
        pos = (cum[i] + cum[i + 1]) / 2
        if apart(pos, chosen, sep):
            chosen.append(pos)
    k = 0
    while len(chosen) < count and k < 4 * count:  # round parts: spread evenly
        pos = (k % count + 0.5) * total / count + (k // count) * sep / 2
        if apart(pos, chosen, sep / 2):
            chosen.append(pos % total)
        k += 1
    chosen.sort()

    def point_at(d: float) -> tuple[float, float]:
        d %= total
        i = min(n - 1, max(0, bisect.bisect_right(cum, d) - 1))
        a, b = pts[i], pts[(i + 1) % n]
        length = cum[i + 1] - cum[i]
        t = (d - cum[i]) / length if length else 0.0
        return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t

    pieces = []
    for j, pos in enumerate(chosen):
        start = pos + width / 2
        end = chosen[(j + 1) % len(chosen)] - width / 2 + (total if j == len(chosen) - 1 else 0)
        if end - start <= 0:
            continue
        corners = sorted((cum[i] + m * total, pts[i]) for m in (0, 1) for i in range(n)
                         if start < cum[i] + m * total < end)
        pieces.append([point_at(start)] + [p for _d, p in corners] + [point_at(end)])
    return pieces


def _add_loops(msp, outline: list, transform, params: LaserParams, joints: int = 0) -> None:
    for k, loop in enumerate(outline):
        pts = [transform(p) for p in loop]
        if len(pts) > 2 and math.dist(pts[0], pts[-1]) < 1e-6:
            pts = pts[:-1]
        layer = params.layer_outer if k == 0 else params.layer_inner
        if k == 0 and joints:
            for piece in micro_joints(_oriented(pts, ccw=True), joints, params.joint_width):
                piece = [(round(x, 3), round(y, 3)) for x, y in piece]
                if params.dxf_version == "R12":
                    msp.add_polyline2d(piece, dxfattribs={"layer": layer})
                else:
                    msp.add_lwpolyline(piece, dxfattribs={"layer": layer})
            continue
        circle = circle_of(pts)
        if circle:
            cx, cy, r = circle
            msp.add_circle((round(cx, 3), round(cy, 3)), round(r, 3), dxfattribs={"layer": layer})
            continue
        pts = [(round(x, 3), round(y, 3)) for x, y in _oriented(pts, ccw=k == 0)]
        if params.dxf_version == "R12":
            msp.add_polyline2d(pts, close=True, dxfattribs={"layer": layer})
        else:
            msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer})


def _ascii(text: str) -> str:
    return re.sub(r"[^\x20-\x7E]", "", text or "").strip()


def _add_mark(msp, text: str, cx: float, cy: float, w: float, h: float, params: LaserParams) -> None:
    from ezdxf.enums import TextEntityAlignment

    text = _ascii(text)
    if not params.mark_codes or not text:
        return
    height = max(3.0, min(10.0, min(w, h) / 4, w / max(1, len(text)) * 1.2))
    msp.add_text(text, height=height, dxfattribs={"layer": params.layer_mark}).set_placement(
        (cx, cy), align=TextEntityAlignment.MIDDLE_CENTER)


def _add_bends(msp, bends: list, transform, params: LaserParams) -> None:
    """Bend lines on the MARK layer: short ticks at both edges of the part, or the whole line."""
    if params.mark_bends not in ("ticks", "full"):
        return
    for line in bends or []:
        if len(line) < 2:
            continue
        (ax, ay), (bx, by) = transform(line[0]), transform(line[-1])
        length = math.hypot(bx - ax, by - ay)
        if length < 1:
            continue
        if params.mark_bends == "full":
            ends = [((ax, ay), (bx, by))]
        else:
            t = min(params.mark_tick, length / 3) / length
            ends = [((ax, ay), (ax + (bx - ax) * t, ay + (by - ay) * t)),
                    ((bx, by), (bx - (bx - ax) * t, by - (by - ay) * t))]
        for a, b in ends:
            msp.add_line((round(a[0], 3), round(a[1], 3)), (round(b[0], 3), round(b[1], 3)),
                         dxfattribs={"layer": params.layer_mark})


def _add_part(msp, part: NestPart, transform, params: LaserParams) -> None:
    outline = part.outline or _rect(part.width, part.height)
    _add_loops(msp, outline, transform, params, params.joints_for(part))
    _add_bends(msp, part.bend_lines, transform, params)


def _rect(w: float, h: float) -> list:
    return [[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]]


def export_program_dxf(prog: CutProgram, path: str | Path, params: LaserParams) -> Path:
    """One sheet of the program: every part at its place (mm, sheet corner at 0,0)."""
    doc = _new_doc(params)
    msp = doc.modelspace()
    if params.sheet_outline:
        msp.add_lwpolyline([(0, 0), (prog.sheet_w, 0), (prog.sheet_w, prog.sheet_h), (0, prog.sheet_h)], close=True,
                           dxfattribs={"layer": "SHEET"})
    for raw in prog.placements:
        part = prog.nest_part(raw["key"])
        pl = Placement(0, raw["x"], raw["y"], raw["w"], raw["h"], raw["rotated"])
        outline = part.outline or _rect(part.width, part.height)
        if not part.outline:
            part.outline = outline
        _add_part(msp, part, lambda pt, part=part, pl=pl: place_point(pt, part, pl, 0, 0), params)
        _add_mark(msp, part.code, pl.x + pl.w / 2, pl.y + pl.h / 2, pl.w, pl.h, params)
    path = Path(path)
    doc.saveas(path)
    return path


def export_part_dxf(part: NestPart, path: str | Path, params: LaserParams) -> Path:
    """One part at the origin - for nesting in the laser's own software."""
    doc = _new_doc(params)
    msp = doc.modelspace()
    outline = part.outline or _rect(part.width, part.height)
    x0, y0, _x1, _y1 = _bbox(outline[0])
    _add_part(msp, part, lambda pt: (float(pt[0]) - x0, float(pt[1]) - y0), params)
    _add_mark(msp, part.code, part.width / 2, part.height / 2, part.width, part.height, params)
    path = Path(path)
    doc.saveas(path)
    return path


def export_drawing_dxf(data, path: str | Path, params: LaserParams, codes: dict[int, str] | None = None) -> int:
    """The drawing as the laser should get it: only the closed cut lines of its parts (outer / holes on their
    layers), where they are in the drawing, bend lines and codes on the MARK layer when marking is on.
    Texts, dimensions, the frame and every line taken out by the check are left out. Returns the parts written."""
    doc = _new_doc(params)
    msp = doc.modelspace()
    n = 0
    for i, prof in enumerate(data.profiles):
        if not prof.is_outer:
            continue
        outline = [prof.points] + [data.profiles[h].points for h in prof.holes]
        part = NestPart(str(i), (codes or {}).get(i, prof.info.get("part_no", "")), "", "", 0,
                        prof.size[0], prof.size[1], 1, outline=outline, bend_lines=[list(b) for b in prof.bends])
        _add_part(msp, part, lambda pt: (float(pt[0]), float(pt[1])), params)
        x0, y0, x1, y1 = prof.bbox
        _add_mark(msp, part.code, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, params)
        n += 1
    path = Path(path)
    doc.saveas(path)
    return n


def program_png(prog: CutProgram, path: str | Path, width_px: int = 900, params: LaserParams | None = None) -> Path:
    """Picture of the sheet with the parts (for the cut order and the operator)."""
    from PIL import Image, ImageDraw

    scale = width_px / max(prog.sheet_w, prog.sheet_h, 1)
    w, h = max(1, int(prog.sheet_w * scale)), max(1, int(prog.sheet_h * scale))
    img = Image.new("RGB", (w + 20, h + 20), (15, 27, 43))
    draw = ImageDraw.Draw(img)
    draw.rectangle([10, 10, 10 + w, 10 + h], fill=(22, 40, 62), outline=(159, 179, 204))

    def to_px(pt):
        return 10 + pt[0] * scale, 10 + h - pt[1] * scale

    for raw in prog.placements:
        part = prog.nest_part(raw["key"])
        pl = Placement(0, raw["x"], raw["y"], raw["w"], raw["h"], raw["rotated"])
        outline = part.outline or _rect(part.width, part.height)
        if not part.outline:
            part.outline = outline
        for k, loop in enumerate(outline):
            pts = [to_px(place_point(pt, part, pl, 0, 0)) for pt in loop]
            if len(pts) >= 3:
                if k == 0:
                    draw.polygon(pts, fill=(120, 72, 30), outline=(242, 140, 40))
                else:
                    draw.polygon(pts, fill=(22, 40, 62), outline=(79, 195, 247))
        if params is not None and params.mark_bends in ("ticks", "full"):
            for line in part.bend_lines:
                draw.line([to_px(place_point(pt, part, pl, 0, 0)) for pt in line[:2]], fill=(46, 204, 113), width=1)
        label = _ascii(part.code)[:18]
        if label:
            cx, cy = to_px((pl.x + pl.w / 2, pl.y + pl.h / 2))
            x0, y0, x1, y1 = draw.textbbox((0, 0), label)
            if x1 - x0 < pl.w * scale:  # only when it fits on the part
                draw.text((cx - (x1 - x0) / 2, cy - (y1 - y0) / 2), label, fill=(230, 237, 246))
    path = Path(path)
    img.save(path)
    return path


PROGRAM_HEADERS = ["เลขที่โปรแกรม", "วัสดุ", "หนา", "ขนาดแผ่น", "รหัสแผ่น", "แผ่น", "ตัดแล้ว",
                   "ชิ้น/แผ่น", "ระยะตัด/แผ่น ม.", "เจาะ/แผ่น", "นาที/แผ่น", "นาทีรวม",
                   "ใช้เหล็ก %", "งาน / SO", "สถานะ", "ไฟล์"]


def program_rows(programs: list[CutProgram]) -> list[list]:
    return [[p.no, p.material, p.thickness, p.sheet_size, p.sheet_code, p.repeat, p.cut_sheets, p.pieces,
             round(p.cut_length / 1000, 2), p.pierces, round(p.minutes, 1), round(p.total_minutes, 1),
             round(p.utilization * 100, 1), ", ".join(p.jobs), p.status, ", ".join(Path(f).name for f in p.files)]
            for p in programs]


def program_part_rows(programs: list[CutProgram]) -> list[list]:
    rows = []
    for p in programs:
        for key, n in p.counts().items():
            it = p.items.get(key, {})
            rows.append([p.no, it.get("code", ""), it.get("name", ""), it.get("job", "") or "Part List", n,
                         n * p.repeat])
    return rows


def part_rows(parts: list[NestPart], params: LaserParams, files: dict[str, str] | None = None) -> list[list]:
    rows = []
    for p in parts:
        length, pierces = cut_metrics(p.outline) if p.outline else (2 * (p.width + p.height), 1)
        minutes = cut_minutes(length, pierces, material_family(p.material), p.thickness, params)
        rows.append([p.code, p.name, p.job or "Part List", p.material, p.thickness,
                     f"{p.width:.0f} x {p.height:.0f}", p.qty, round(length / 1000, 3), pierces,
                     round(minutes, 2), round(minutes * p.qty, 1), Path((files or {}).get(p.key, "")).name])
    return rows


PART_HEADERS = ["รหัส", "ชิ้นส่วน", "งาน / SO", "วัสดุ", "หนา (มม.)", "ขนาด (มม.)", "จำนวน", "ระยะตัด/ชิ้น (ม.)",
                "เจาะ/ชิ้น", "เวลา/ชิ้น (นาที)", "เวลารวม (นาที)", "ไฟล์ DXF"]
ISSUE_HEADERS = ["ระดับ", "รหัส", "ชิ้นส่วน", "ปัญหา"]


def issue_rows(issues: list[Issue]) -> list[list]:
    return [[LEVEL_TEXT.get(i.level, i.level), i.code, i.name, i.text] for i in issues]


def export_cut_order(programs: list[CutProgram], path: str | Path, params: LaserParams,
                     parts: list[NestPart] | None = None, issues: list[Issue] | None = None,
                     images: dict[str, str] | None = None, title: str = "") -> Path:
    """ใบสั่งตัดเลเซอร์ (Excel): programs with a picture of each sheet, parts per program, checks, settings."""
    from .tabular import Sheet, write_workbook

    images = images or {}
    rows = program_rows(programs)
    head = [[title or "ใบสั่งตัดเลเซอร์"],
            [f"{len(programs)} โปรแกรม · {sum(p.repeat for p in programs)} แผ่น · "
             f"{sum(p.pieces * p.repeat for p in programs)} ชิ้น · เวลาประมาณ "
             f"{sum(p.total_minutes for p in programs) / 60:.1f} ชม."]]
    if params.rate_per_hour:
        head.append([f"ค่าเครื่องโดยประมาณ {sum(p.total_minutes for p in programs) / 60 * params.rate_per_hour:,.0f} บาท"
                     f" ({params.rate_per_hour:,.0f} บาท/ชม.)"])
    pics = {i: images.get(p.no, "") for i, p in enumerate(programs)}
    sheets = [Sheet("โปรแกรมตัด", PROGRAM_HEADERS + ["ภาพแผ่น"], [r + [""] for r in rows], title_rows=head,
                    images=pics, image_col=len(PROGRAM_HEADERS)),
              Sheet("ชิ้นงานในโปรแกรม", ["เลขที่โปรแกรม", "รหัส", "ชิ้นส่วน", "งาน / SO", "ต่อแผ่น", "รวม"],
                    program_part_rows(programs))]
    if parts:
        sheets.append(Sheet("รายการชิ้น (วางเองในโปรแกรมเลเซอร์)", PART_HEADERS, part_rows(parts, params)))
    if issues:
        sheets.append(Sheet("ตรวจก่อนตัด", ISSUE_HEADERS, issue_rows(issues)))
    sheets.append(Sheet("ค่าที่ใช้", ["ค่า", "ใช้"], [
        ["ระยะห่างชิ้นงาน (มม.)", params.gap], ["ขอบแผ่น (มม.)", params.margin],
        ["เครื่องตัด", f"{params.machine} · โต๊ะ {params.bed_w:.0f} x {params.bed_l:.0f} มม."],
        ["หมุน 90°", "ได้" if params.rotate else "ไม่หมุน"], ["เผื่อเวลาเคลื่อนที่ (%)", params.travel_pct],
        ["เวลาวาง/เก็บแผ่น (นาที)", params.sheet_minutes], ["DXF", params.dxf_version],
        ["เลเยอร์", f"{params.layer_outer} (รอบนอก) · {params.layer_inner} (รู) · {params.layer_mark} (แกะสลัก)"],
        *[[f"ความเร็ว {fam} หนา {float(k):g} มม. (มม./นาที)", v] for fam, t in params.speeds.items()
          for k, v in sorted(t.items(), key=lambda kv: float(kv[0]))]]))
    path = Path(path)
    write_workbook(path, sheets)
    return path


def export_package(programs: list[CutProgram], folder: str | Path, params: LaserParams,
                   parts: list[NestPart] | None = None, issues: list[Issue] | None = None, title: str = "") -> dict:
    """The laser package in `folder`:
        programs/<วัสดุ_หนา>/<LC…>_x<แผ่น>.dxf + .png   one DXF per sheet layout
        parts/<วัสดุ_หนา>/<รหัส>_t<หนา>_x<จำนวน>.dxf     each part alone, for nesting in the laser software
        ใบสั่งตัดเลเซอร์.xlsx"""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    images: dict[str, str] = {}
    written: list[Path] = []
    for prog in programs:
        sub = folder / "programs" / _safe(f"{prog.family}_t{prog.thickness:g}")
        sub.mkdir(parents=True, exist_ok=True)
        dxf = export_program_dxf(prog, sub / f"{prog.no}_x{prog.repeat}.dxf", params)
        png = program_png(prog, sub / f"{prog.no}.png", params=params)
        prog.files = [str(dxf)]
        images[prog.no] = str(png)
        written += [dxf, png]
    files: dict[str, str] = {}
    used: set[str] = set()
    for p in parts or []:
        sub = folder / "parts" / _safe(f"{material_family(p.material)}_t{p.thickness:g}")
        sub.mkdir(parents=True, exist_ok=True)
        base = _safe(f"{p.code or p.name}_t{p.thickness:g}_x{p.qty}" + (f"_{p.job}" if p.job else ""))
        name, n = base, 1
        while name in used:
            n += 1
            name = f"{base}-{n}"
        used.add(name)
        files[p.key] = str(export_part_dxf(p, sub / f"{name}.dxf", params))
        written.append(Path(files[p.key]))
    order = export_cut_order(programs, folder / "ใบสั่งตัดเลเซอร์.xlsx", params, parts, issues, images, title)
    if parts:  # the part list with file names
        from .tabular import Sheet, write_workbook

        write_workbook(folder / "รายการชิ้นงาน_DXF.xlsx", [Sheet("ชิ้นงาน", PART_HEADERS, part_rows(parts, params, files))])
    return {"folder": str(folder), "order": str(order), "files": [str(p) for p in written],
            "programs": len(programs), "parts": len(files)}


ACI_NAMES = {1: "แดง", 2: "เหลือง", 3: "เขียว", 4: "ฟ้า", 5: "น้ำเงิน", 6: "ม่วงชมพู", 7: "ขาว/ดำ"}


def export_layer_test(path, params: LaserParams) -> Path:
    """A test file for the laser software: which of its layers each DXF layer / colour lands on.
    Row 1 (left to right): the 3 layers the program writes (outer, holes, mark).
    Row 2: one square on each of the 7 standard colours 1 red … 7 white, left to right. All squares 100 mm."""
    doc = _new_doc(params)
    msp = doc.modelspace()
    square = [(0, 0), (100, 0), (100, 100), (0, 100)]

    def add(layer: str, x: float, y: float) -> None:
        pts = [(x + px, y + py) for px, py in square]
        if params.dxf_version == "R12":
            msp.add_polyline2d(pts, close=True, dxfattribs={"layer": layer})
        else:
            msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer})

    for i, layer in enumerate((params.layer_outer, params.layer_inner, params.layer_mark)):
        add(layer, i * 150, 200)
    for aci in range(1, 8):
        name = f"COLOR_{aci}"
        if name not in doc.layers:
            doc.layers.add(name, color=aci)
        add(name, (aci - 1) * 150, 0)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(path)
    return path

