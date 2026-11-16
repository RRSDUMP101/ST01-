"""คู่มือประกอบ 3 มิติ: ชิ้นส่วน (แยกกลุ่ม) → ขั้นตอนประกอบ → ตำแหน่งที่แยกชิ้น (explode) สำหรับสาธิตการประกอบ.

ไม่ใช้ Qt. หน่วย มม. แกน: X = ตามยาวรถ (0 = หน้าตัวถังด้านหลังเก๋ง → ท้ายรถ), Y = ขวาง (0 = กึ่งกลางรถ),
Z = ขึ้น (0 = หน้าแท่นยึดบนแชสซี).

* `Part3D` – ชิ้นส่วน 1 ชิ้น: รูปทรงพื้นฐาน (กล่อง, เหล็กราง C, เหล็กฉาก, แท่ง/น็อตหลายเหลี่ยม) หรือ mesh ที่นำเข้า
* `Step` – ขั้นตอนประกอบ 1 ขั้น (ชื่อ วิธีทำ คำเตือน แรงขัน เครื่องมือ จุดตรวจ อ้างอิง BEMM)
* `AssemblyModel` – ชิ้นส่วน + ขั้นตอน, บันทึก/เปิดเป็น JSON (.rrsasm)
* `build_for_job(job)` – โมเดลตัวอย่างจากขนาดในงานติดตั้ง (กระบะพื้นเรียบ / ตู้ทึบ)
* `load_obj` / `load_stl` – โมเดลจริงที่ส่งออกจาก CAD (ZW3D / ZWCAD: Export → OBJ หรือ STL)
"""

from __future__ import annotations

import json
import math
import re
import struct
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

Vec = tuple[float, float, float]
Face = tuple[list[Vec], list[bool]]  # the corners, and which of its sides are real edges of the part (drawn as lines)

STEEL, PLATE, VEHICLE, BOLT, LAMP = "#8FA3B5", "#B9C4CE", "#C9CED6", "#E0A63A", "#D64545"
REF_GROUP = "รถ (อ้างอิง)"


# --------------------------------------------------------------------------- shapes
def _ngon(r: float, n: int) -> list[tuple[float, float]]:
    return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def _rect(h0: float, v0: float, h1: float, v1: float) -> list[tuple[float, float]]:
    return [(h0, v0), (h1, v0), (h1, v1), (h0, v1)]


def extrude(profile: list[tuple[float, float]], axis: str, length: float, smooth: bool = False) -> list[Face]:
    """A convex profile (horizontal, vertical; counter-clockwise) pushed along x, y or z. Faces wind outwards.
    `smooth`: a round bar - no lines between its side faces."""
    prof = [(v, h) for h, v in reversed(profile)] if axis == "y" else list(profile)

    def at(p, w) -> Vec:
        u, v = p
        return (w, u, v) if axis == "x" else (v, w, u) if axis == "y" else (u, v, w)

    faces: list[Face] = []
    for i, p in enumerate(prof):
        q = prof[(i + 1) % len(prof)]
        faces.append(([at(p, 0.0), at(q, 0.0), at(q, length), at(p, length)], [True, not smooth, True, not smooth]))
    faces.append(([at(p, 0.0) for p in reversed(prof)], [True] * len(prof)))
    faces.append(([at(p, length) for p in prof], [True] * len(prof)))
    return faces


def box_faces(lx: float, ly: float, lz: float) -> list[Face]:
    """A box from (0, 0, 0) to (lx, ly, lz)."""
    return extrude(_rect(0, 0, ly, lz), "x", lx)


def _section(shape: str, b: float, h: float, t: float, flip: bool) -> list[list[tuple[float, float]]]:
    """A channel (web + 2 flanges) or an angle (2 legs) as rectangles: each is a convex piece, which the 3D view
    needs to draw near and far pieces in the right order."""
    rects = [_rect(0, 0, t, h), _rect(t, 0, b, t)] + ([_rect(t, h - t, b, h)] if shape == "channel" else [])
    return [[(-x, v) for x, v in reversed(r)] for r in rects] if flip else rects


# --------------------------------------------------------------------------- model
@dataclass
class Part3D:
    id: str
    name: str
    group: str
    shape: str = "box"  # box · channel · angle · rod · mesh
    dims: list = field(default_factory=list)  # box: lx, ly, lz · channel/angle: length, flange, height, t · rod: length, r, sides
    axis: str = "x"  # channel / angle / rod: the direction of its length
    pos: list = field(default_factory=lambda: [0.0, 0.0, 0.0])
    flip: bool = False  # channel / angle: the open side to the other direction
    color: str = STEEL
    explode: list = field(default_factory=lambda: [0.0, 0.0, 0.0])  # where it waits before it is fitted
    step: int = 0  # the step that fits it (1 …) · 0 = there from the start (the vehicle)
    part_no: str = ""
    size: str = ""  # 'C100×50×5 L=2600'
    note: str = ""
    mesh: list = field(default_factory=list)  # shape 'mesh': [[(x, y, z), …], …] faces
    cull: bool = False  # shape 'mesh': a closed skin whose faces all wind outwards – the view hides its back faces

    def chunks(self) -> list[list[Face]]:
        """The faces in convex pieces (a box: one; a channel: three; an imported mesh: one, of any form)."""
        if self.shape == "mesh":
            return [[([tuple(p) for p in f], [False] * len(f)) for f in self.mesh]]
        if self.shape == "box":
            local = [box_faces(*self.dims[:3])]
        elif self.shape == "rod":
            sides = int(self.dims[2]) if len(self.dims) > 2 else 12
            local = [extrude(_ngon(self.dims[1], sides), self.axis, self.dims[0], smooth=sides > 8)]
        else:
            local = [extrude(r, self.axis, self.dims[0]) for r in _section(self.shape, *self.dims[1:4], self.flip)]
        x, y, z = self.pos
        return [[([(p[0] + x, p[1] + y, p[2] + z) for p in pts], edges) for pts, edges in piece] for piece in local]

    def faces(self) -> list[Face]:
        return [f for piece in self.chunks() for f in piece]

    def bounds(self) -> tuple[Vec, Vec]:
        pts = [p for f, _e in self.faces() for p in f] or [tuple(self.pos)]
        return (tuple(min(p[i] for p in pts) for i in range(3)), tuple(max(p[i] for p in pts) for i in range(3)))

    def centre(self) -> Vec:
        lo, hi = self.bounds()
        return tuple((lo[i] + hi[i]) / 2 for i in range(3))

    @classmethod
    def from_dict(cls, d: dict) -> Part3D:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


@dataclass
class Step:
    title: str
    detail: str = ""
    warning: str = ""
    torque: str = ""
    tools: str = ""
    check: str = ""  # what to look at / measure before the next step
    ref: str = ""  # BEMM section
    no_parts: bool = False  # a step of work or checking that fits no new part (it is not a mistake that it is empty)
    phase: str = ""  # the part of the work the step belongs to: 'งานบนจิ๊ก' · 'ยกขึ้นรถ' · 'งานบนรถ'

    @classmethod
    def from_dict(cls, d: dict) -> Step:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


@dataclass
class BomLine:
    no: int
    name: str
    part_no: str
    size: str
    qty: int
    group: str


@dataclass
class AssemblyModel:
    name: str = ""
    parts: list[Part3D] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)
    source: str = "auto"  # 'auto' = built from the job (rebuilt when the job changes) · 'file' = imported / edited
    note: str = ""

    def groups(self) -> list[str]:
        out: list[str] = []
        for p in self.parts:
            if p.group not in out:
                out.append(p.group)
        return out

    def part(self, part_id: str) -> Part3D | None:
        return next((p for p in self.parts if p.id == part_id), None)

    def parts_of_step(self, n: int) -> list[Part3D]:
        return [p for p in self.parts if p.step == n]

    def bom(self, step: int | None = None, group: str | None = None) -> list[BomLine]:
        """Same parts on one line (name + part number + size), numbered in the order they are met."""
        lines: dict[tuple, BomLine] = {}
        for p in self.parts:
            if (step is not None and p.step != step) or (group is not None and p.group != group):
                continue
            if step is None and p.step == 0:
                continue
            key = (p.name, p.part_no, p.size)
            if key not in lines:
                lines[key] = BomLine(len(lines) + 1, p.name, p.part_no, p.size, 0, p.group)
            lines[key].qty += 1
        return list(lines.values())

    def bom_no(self, part: Part3D) -> int:
        return next((b.no for b in self.bom(part.step) if (b.name, b.part_no, b.size) == (part.name, part.part_no, part.size)), 0)

    def bounds(self, parts: list[Part3D] | None = None) -> tuple[Vec, Vec]:
        boxes = [p.bounds() for p in (self.parts if parts is None else parts)] or [((0, 0, 0), (1, 1, 1))]
        return (tuple(min(b[0][i] for b in boxes) for i in range(3)), tuple(max(b[1][i] for b in boxes) for i in range(3)))

    def problems(self) -> list[str]:
        out = []
        for n, s in enumerate(self.steps, 1):
            if not s.no_parts and not self.parts_of_step(n):
                out.append(f"ขั้นที่ {n} “{s.title}” ไม่มีชิ้นส่วน")
        late = sorted({p.step for p in self.parts if p.step > len(self.steps)})
        if late:
            out.append(f"มีชิ้นส่วนอยู่ในขั้นที่ {', '.join(map(str, late))} ซึ่งยังไม่มีคำอธิบายขั้นตอน")
        ids = [p.id for p in self.parts]
        if len(ids) != len(set(ids)):
            out.append("รหัสชิ้นส่วน (id) ซ้ำกัน")
        return out

    # ---- file
    def to_dict(self) -> dict:
        return {"format": "rrs-assembly/1", "name": self.name, "source": self.source, "note": self.note,
                "steps": [asdict(s) for s in self.steps], "parts": [asdict(p) for p in self.parts]}

    @classmethod
    def from_dict(cls, d: dict) -> AssemblyModel:
        if not isinstance(d.get("parts"), list):
            raise ValueError("ไม่ใช่ไฟล์โมเดลประกอบ (ไม่มี parts)")
        return cls(str(d.get("name", "")), [Part3D.from_dict(p) for p in d["parts"]],
                   [Step.from_dict(s) for s in d.get("steps", [])], str(d.get("source", "file")), str(d.get("note", "")))

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> AssemblyModel:
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


# --------------------------------------------------------------------------- imported models
def auto_steps(model: AssemblyModel) -> None:
    """One step per group, in the order of the groups (a start for an imported model; then edited)."""
    groups = [g for g in model.groups() if g != REF_GROUP]
    model.steps = [Step(f"ประกอบกลุ่ม {g}", "ตรวจชิ้นส่วนให้ครบตามตาราง แล้วประกอบตามตำแหน่งในภาพ 3 มิติ") for g in groups]
    for p in model.parts:
        p.step = groups.index(p.group) + 1 if p.group in groups else 0


def auto_explode(model: AssemblyModel, factor: float = 0.6, least: float = 150.0) -> None:
    """Every part moves away from the middle of the assembly, mostly along the direction it is already off-centre
    (like the exploded view of the CAD program)."""
    parts = [p for p in model.parts if p.step > 0]
    if not parts:
        return
    lo, hi = model.bounds(parts)
    mid = [(lo[i] + hi[i]) / 2 for i in range(3)]
    for p in parts:
        c = p.centre()
        v = [c[i] - mid[i] for i in range(3)]
        length = math.sqrt(sum(x * x for x in v))
        if length < 1e-6:
            p.explode = [0.0, 0.0, least]
            continue
        scale = max(factor, least / length)
        p.explode = [round(x * scale, 1) for x in v]


# --------------------------------------------------------------------------- editing the steps
EXPLODE_DIRECTIONS = {"ขึ้น (+Z)": (0, 0, 1), "ลง (−Z)": (0, 0, -1), "ไปท้ายรถ (+X)": (1, 0, 0), "ไปหน้ารถ (−X)": (-1, 0, 0),
                      "ไปทางซ้าย (+Y)": (0, 1, 0), "ไปทางขวา (−Y)": (0, -1, 0)}


def insert_step(model: AssemblyModel, at: int, step: Step | None = None) -> dict[int, int]:
    """A new, empty step at position `at` (1 … number of steps + 1); the steps from there on move one later.
    Returns {old number: new number} of the steps that moved (for what is kept by step number, like done marks)."""
    at = min(max(at, 1), len(model.steps) + 1)
    moved = {n: n + 1 for n in range(at, len(model.steps) + 1)}
    model.steps.insert(at - 1, step or Step("ขั้นตอนใหม่"))
    for p in model.parts:
        p.step = moved.get(p.step, p.step)
    return moved


def remove_step(model: AssemblyModel, n: int) -> dict[int, int | None]:
    """Step `n` goes; its parts join the step before it (the first step's parts join the next). The last
    remaining step cannot be removed. Returns {old number: new number, n: None}."""
    if not 1 <= n <= len(model.steps) or len(model.steps) < 2:
        return {}
    moved: dict[int, int | None] = {k: k - 1 for k in range(n + 1, len(model.steps) + 1)}
    moved[n] = None
    heir = n - 1 if n > 1 else 1  # counted after the removal
    del model.steps[n - 1]
    for p in model.parts:
        if p.step == n:
            p.step = heir
        elif p.step > n:
            p.step -= 1
    return moved


def move_step(model: AssemblyModel, n: int, delta: int) -> dict[int, int]:
    """Step `n` changes places with its neighbour (delta −1 = earlier, +1 = later), with its parts."""
    m = n + delta
    if delta not in (-1, 1) or not (1 <= n <= len(model.steps) and 1 <= m <= len(model.steps)):
        return {}
    model.steps[n - 1], model.steps[m - 1] = model.steps[m - 1], model.steps[n - 1]
    swap = {n: m, m: n}
    for p in model.parts:
        p.step = swap.get(p.step, p.step)
    return swap


def set_explode(parts: list[Part3D], direction: str, distance: float) -> None:
    """Where the parts wait before they are fitted: `distance` mm along one of EXPLODE_DIRECTIONS."""
    d = EXPLODE_DIRECTIONS[direction]
    for p in parts:
        p.explode = [float(c * distance) for c in d]


# --------------------------------------------------------------------------- the 13 steps of a flat tray
# The factory's order of work for กระบะพื้นเรียบ, as RRS gave it (16 Nov 2026): the body is welded complete on the
# jig, lifted onto the chassis and bolted, and the rest is fitted on the vehicle. Each rule: (the group the technician
# reads, step number, words that may be in a name). Rules are tried in this order, so 'ขาป้ายทะเบียน' is a welded
# bracket and not the plate itself, and 'กรอบพื้น' a frame and not a floor. Words are kept as they are misspelt in
# the customer's CAD files too ('บังโครน', 'ฝาทัง', 'ขาบ้าย', 'พิ้น'): a file whose names were corrected sorts the same.
TRAY_PHASES = ("งานบนจิ๊ก", "ยกขึ้นรถ", "งานบนรถ")
# 1. parts RRS sorts by their own name: this wins over the level the part is drawn on
TRAY_NAMED = [
    ("บานพับ", 4, ("บานพับ", "hinge")),
    ("ตะขอผ้าใบ", 4, ("ตะขอ", "hook")),
    ("รองขาเต้า", 4, ("เต้า", "เต่า")),  # ขาเต้า (a bracket); the CAD file writes เต่า
    ("ขาป้ายทะเบียน", 4, ("ขาป้าย", "ขาบ้าย", "ท้ายป้าย")),
    ("ราวท่อข้าง", 4, ("ราวท่อ",)),  # below the floor at the side; not yet confirmed what it is (guard rail or step)
    ("รางพับฝาข้าง", 8, ("รางข้าง", "รางท้าย", "รางพับ", "jnspn")),
    ("บังโคลน", 10, ("บังโคลน", "บังโครน", "fender")),
    ("คอเติมน้ำมัน", 11, ("ฝาถัง", "ฝาทัง", "คอเติม", "คอถัง", "น้ำมัน", "fuel")),
    ("ชุดกล้องถอย", 12, ("rvc kit", "กล้องถอย", "camera")),
]
# 2. the words of a level or group
TRAY_RULES = [
    *TRAY_NAMED,
    ("กล่องหลัง", 12, ("กล่องหลัง", "กล่องท้าย")),
    ("ชุดไฟท้าย", 12, ("ไฟ", "ป้าย", "กล้อง", "lamp", "light", "licen")),
    ("โรบาหลัง", 9, ("โรบา",)),
    ("ฝาข้าง", 8, ("ฝาข้าง", "ฝาท้าย", "ฝาหน้า", "side", "tail")),
    ("ตะแกรงกันหัว", 7, ("ตะแกรง", "กันหัว", "เขาบน", "head")),
    ("โครงตัวบน", 2, ("โครงตัวบน", "กรอบพื้น")),
    ("พื้น", 3, ("พื้น", "พิ้น", "floor")),
    ("โครงตัวล่าง", 1, ("โครงตัวล่าง", "โครงล่าง", "ซับเฟรม", "คานขวาง", "subframe", "sub-frame")),
    ("สลักแท่นยึด", 6, ("สลัก", "น็อต", "แหวน", "bolt", "nut", "washer")),
    ("แท่นยึด", 5, ("แท่นยึด",)),
]
TRAY_OTHER = 4  # what no rule knows waits with the small welded parts until someone sorts it
UNSORTED_GROUP = "ยังไม่จัดกลุ่ม"
FORD_GROUP = "ชุดไฟท้าย Ford"
FORD_PART = re.compile(r"(?i)^(di-p\d+|rsd |n1wj|[a-z0-9]{4}-[a-z0-9]{4,7}-[a-z]|w\d{6}-)")  # the vehicle maker's own parts
FASTENER = re.compile(r"(?i)screw|bolt|\bnut\b|hexagon|washer|\bpin\b|rivet|สกรู|น็อต|แหวนรอง|หมุด")
FASTENER_GROUPS = {6: "สลักแท่นยึด", 7: "สลักตะแกรงกันหัว", 8: "สลักฝาข้าง / รางพับ"}
DEFAULT_NAME = re.compile(r"(?i)^(layer|part|ชิ้นที่)[\s_]*\d*([\s_]+\d+)?(_mirror(_\d+)?)?$")  # a name nobody gave
MIRROR = re.compile(r"(?i)_mirror(_\d+)?")  # ZW3D's name for the copy on the other side
# names as they are misspelt in the customer's files → what the technician should read
TRAY_SPELLING = [
    ("ตะขอผ้าไบ", "ตะขอผ้าใบ"),
    ("บังโครน ใหม่", "บังโคลน"),
    ("บังโครน", "บังโคลน"),
    ("ฝาทังนำ้ม้น", "ฝาถังน้ำมัน"),
    ("ขาบ้ายะเบียน", "ขาป้ายทะเบียน"),
    ("duratray ตะแกรงห้นา1", "ตะแกรงหน้า (กันหัว)"),
    ("ตะแกรงห้นา", "ตะแกรงหน้า"),
    ("รองขาเต่า", "รองขาเต้า"),
    ("เต่าที่1", "ขาเต้า"),
    ("ขาเต่า", "ขาเต้า"),
    ("พื้นเรีบบ", "พื้นเรียบ"),
    ("พิ้น", "พื้น"),
]


def tray_sequence(job=None, width: float | None = None) -> list[Step]:
    """The 13 steps. `job` gives the bolts and their torque, the cab gap and the lamp height of this vehicle;
    `width` the measured width of the upper frame (mm)."""
    torque = _torque_text(job) if job is not None else "M12 เกรด 10.9: 95–125 Nm"
    gap = f" – งานนี้ {job.cab_gap:g} มม." if job is not None else ""
    lamp = f" – งานนี้ {job.lamp_low} มม." if job is not None else ""
    wide = f" กว้าง {width:,.0f} มม." if width else ""
    rigid = bool(job is not None and job.rigid_subframe)
    jig, lift, on = TRAY_PHASES
    return [
        Step("วางและเชื่อมโครงตัวล่าง",
             "วางชิ้นส่วนโครงตัวล่างบนจิ๊กตามตำแหน่ง แต้มเชื่อม ตรวจระยะทแยงมุม แล้วเชื่อมจริง",
             check="ระยะทแยงมุมสองแนวเท่ากัน", tools="จิ๊ก ฉาก ตลับเมตร เครื่องเชื่อม", phase=jig),
        Step("เชื่อมโครงตัวบนเข้ากับโครงตัวล่าง",
             "วางโครงตัวบนบนโครงตัวล่าง จัดกึ่งกลาง ตรวจระนาบผิวบนและความกว้าง แล้วเชื่อม",
             check=f"ผิวบนอยู่ระนาบเดียวกัน{wide}", tools="ระดับน้ำ ปากกาจับ C เครื่องเชื่อม", ref="1.11.1 J", phase=jig),
        Step("ปูและเชื่อมแผ่นพื้น", "ปูแผ่นพื้นบนโครงตัวบน กดให้แนบ แล้วเชื่อม ตรวจตำแหน่งช่องตะขอ",
             check="แนบสนิท ไม่กระดก ช่องตะขอ 8 จุดตรงตำแหน่ง", tools="ปากกาจับ เครื่องเชื่อม", phase=jig),
        Step("ติดชิ้นเชื่อมย่อยใต้โครง", "เชื่อมรองขาเต้า บานพับ ตะขอผ้าใบ และขาป้ายทะเบียนตามตำแหน่งในภาพ ทาสีกันสนิมรอยเชื่อม",
             check="ตำแหน่งบานพับข้างละ 3 จุด ห่าง 900 มม.", tools="ตลับเมตร เครื่องเชื่อม สีกันสนิม", ref="5.5", phase=jig),
        Step("ตรวจแท่นยึดบนแชสซี แล้วยกโครงวาง",
             "ทำความสะอาดหน้าแท่นยึดบนแชสซีทุกจุด ตรวจแนวท่อ DEF และสายไฟใต้รางแชสซี แล้วยกโครงวางให้นั่งบนแท่นยึด"
             "เต็มหน้าทุกจุดโดยไม่ต้องงัด จัดกึ่งกลางรถ",
             check=f"ช่องห่างหลังเก๋งอย่างน้อย 28 มม. (Ford){gap}", tools="เครน/รอก ตลับเมตร", ref="1.11.3 / 5.1.4 / 3.2.1",
             warning="ห้ามเจาะหรือเชื่อมแชสซีเพิ่ม เว้นแต่ตามคู่มือ Ford ข้อ 5.6.4", phase=lift),
        Step("ขันสลักยึดกับแท่นยึด",
             "ใส่สลักพร้อมแหวนและน็อตล็อกทุกแท่น ขันมือให้ครบก่อน แล้วขันแรงบิดไล่จากกลางออกหัว–ท้าย ทำเครื่องหมายสีเมื่อขันครบ",
             torque=torque, check="ตามคู่มือ Ford: ขั้นต่ำ M12 เกรด 10.9 ขัน 95–125 Nm · ขันครบทุกตัว",
             tools="ประแจวัดแรงบิด บล็อก ปากกาเคมี", ref="5.1.4 / 1.12",
             warning=("ซับเฟรมแข็ง: แท่นคู่หน้าใช้แบบยืดหยุ่น ~1 kN/มม. จำกัด ±12 มม. – แท่นอื่นยึดแข็ง" if rigid
                      else "ใช้จุดยึดบนแชสซีครบทุกจุด – ผิวสัมผัสห้ามเป็นสีฝุ่น"), phase=lift),
        Step("ติดตะแกรงกันหัว", "ตั้งตะแกรงกันหัวด้านหน้า ยึดกับโครง ตรวจฉากกับพื้น",
             check="ตั้งฉากกับพื้น ไม่แตะเก๋ง", tools="ฉาก ระดับน้ำ ประแจ", ref="1.11.3", phase=on),
        Step("แขวนฝาข้างและฝาท้าย", "แขวนฝาข้างซ้าย–ขวาและฝาท้ายเข้ากับบานพับ ปรับกลอน เปิด–ปิดทดสอบ",
             check="ปิดสนิท กลอนล็อกครบ", tools="ประแจ", phase=on),
        Step("ติดโรบาหลัง", "ยึดโรบาหลังเข้ากับโครงด้านท้าย", tools="ประแจ", phase=on),
        Step("ติดบังโคลน", "ยึดบังโคลนซ้าย–ขวา ตรวจระยะห่างจากยางตลอดช่วงยุบ–ยืดของช่วงล่าง",
             check="ระยะห่างยางตามคู่มือ Ford", tools="ประแจ ตลับเมตร", ref="5.1.3", phase=on),
        Step("ติดคอเติมน้ำมันและท่อหายใจ",
             "ยึดคอเติมน้ำมันกับตัวถัง เดินท่อหายใจถังน้ำมันและเฟืองท้าย ท่อต้องไม่ตกท้องช้าง ไม่หักพับ",
             check="มุมปากเติมอย่างน้อย 30° ปลายท่อหายใจสูงจากพื้นอย่างน้อย 850 มม. (Ford)", tools="ตลับเมตร ระดับองศา",
             ref="3.3.2 / 3.3.3 / 3.3.4", warning="ขายึดคอเติมต้องนำไฟฟ้าและต่อกราวด์ถึงแชสซี", phase=on),
        Step("ติดกล่องหลัง ไฟท้าย ป้ายทะเบียน กล้องถอย เดินสายไฟ",
             "ยึดกล่องหลัง ชุดไฟท้าย Ford ป้ายทะเบียน และกล้องถอย เดินสายผ่านยางกันน้ำ ต่อสัญญาณจากสายที่รถเตรียมไว้ ทดสอบไฟทุกดวง",
             check=f"ไฟติดครบ ขอบล่างโคมสูงจากพื้นอย่างน้อย 500 มม. (Ford){lamp}", tools="ชุดย้ำสาย ท่อหด มัลติมิเตอร์",
             ref="4.6.3 / 4.6.9 / 4.6.10 / 4.5.2", warning="ห้ามต่อไฟท้ายใหม่เข้าวงจรไฟท้ายเดิมโดยตรง", phase=on),
        Step("ตรวจขั้นสุดท้าย", "ขันซ้ำทุกจุดยึด ชั่งน้ำหนักเพลาหน้า/หลัง สแกนรหัสเสีย แล้วบันทึกผล",
             check="ขันซ้ำทุกจุด ชั่งน้ำหนัก สแกนรหัสเสีย", tools="ประแจวัดแรงบิด เครื่องชั่ง เครื่องสแกน", ref="1.12 / 1.13.3",
             phase=on, no_parts=True),
    ]


def _own_words(text: str) -> str:
    """A name without what ZW3D adds to it: 'Part5^พื้นเรีบบ champ' is Part5 of that file, not a floor."""
    return text.split("^")[0].strip().lower()


def _rule(rules: list, text: str) -> tuple[str, int] | None:
    """(group, step) of the first rule with a word in `text`. A name nobody gave says nothing."""
    name = _own_words(text)
    if not name or DEFAULT_NAME.match(name):
        return None
    for group, step, words in rules:
        if any(w in name for w in words):
            return group, step
    return (FORD_GROUP, 12) if FORD_PART.match(name) else None


def tray_step_of(group: str) -> int:
    """The step of the 13 that the parts of a group belong to, by the words in its name."""
    found = _rule(TRAY_RULES, group)
    return found[1] if found else TRAY_OTHER


def tray_group_known(group: str) -> bool:
    return _rule(TRAY_RULES, group) is not None


def tray_sequence_fits(model: AssemblyModel) -> int:
    """How many of the 13 steps would get parts by the names of the groups and parts (0 = the names say nothing)."""
    texts = {t for p in model.parts if p.group != REF_GROUP for t in (p.group, p.name)}
    return len({found[1] for t in texts if (found := _rule(TRAY_RULES, t)) is not None})


def _gap(a: tuple, b: tuple) -> float:
    """Distance between two boxes (0 when they touch or overlap)."""
    return math.sqrt(sum(max(0.0, a[0][i] - b[1][i], b[0][i] - a[1][i]) ** 2 for i in range(3)))


def adopt_groups(model: AssemblyModel, other: AssemblyModel, tol: float = 1.0) -> dict[str, str]:
    """Part id of `model` → the group that the same thing has in `other` (the same assembly from another file: the
    IGES of a tray has the designer's levels, its STEP the names). A part is the same thing when its box is the box
    of a part of `other` within `tol` mm, or when parts of `other` of one group lie inside it and fill its box (a
    solid that the other file holds in several sewn pieces). Nothing is said when the groups disagree."""
    theirs = [(p.bounds(), p.group) for p in other.parts]
    out: dict[str, str] = {}
    cells: dict[tuple, list[int]] = {}  # their boxes by the cell of their lower corner: the search stays near
    size = max(tol * 4, 50.0)
    for n, ((blo, _bhi), _g) in enumerate(theirs):
        cells.setdefault(tuple(int(blo[i] // size) for i in range(3)), []).append(n)
    for part in model.parts:
        lo, hi = part.bounds()
        key = [int(lo[i] // size) for i in range(3)]
        near = [n for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                for n in cells.get((key[0] + dx, key[1] + dy, key[2] + dz), ())]
        same = {theirs[n][1] for n in near
                if all(abs(lo[i] - theirs[n][0][0][i]) <= tol and abs(hi[i] - theirs[n][0][1][i]) <= tol for i in range(3))}
        if len(same) == 1:
            out[part.id] = same.pop()
            continue
        if same:
            continue
        inside = [((blo, bhi), g) for (blo, bhi), g in theirs
                  if all(blo[i] >= lo[i] - tol and bhi[i] <= hi[i] + tol for i in range(3))]
        filled = [group for group in sorted({g for _b, g in inside})
                  if all(abs(min(b[0][i] for b, g in inside if g == group) - lo[i]) <= 2 * tol
                         and abs(max(b[1][i] for b, g in inside if g == group) - hi[i]) <= 2 * tol for i in range(3))]
        if len(filled) == 1:
            out[part.id] = filled[0]
    return out


def tray_steps(model: AssemblyModel, levels: dict[str, str] | None = None) -> dict[str, tuple[int, str, str]]:
    """Every part of a flat tray → (step, group for the technician, how it was found: 'ชื่อ' · 'เลเยอร์' · 'กลุ่ม' ·
    'ชิ้นข้างเคียง' · 'ไม่ทราบ'). In this order: a name RRS sorts by; the designer's level (`levels`, from
    adopt_groups); the group. A screw, nut or washer follows its sub-assembly, then its level, then the part it sits
    on – the size of a bolt does not say what it fastens. What nothing tells stays at step 4, not guessed."""
    levels = levels or {}
    out: dict[str, tuple[int, str, str]] = {}
    bolts: list[Part3D] = []
    for p in model.parts:
        if p.group == REF_GROUP:
            continue
        level = levels.get(p.id, "")
        bolt = bool(FASTENER.search(_own_words(p.name)))
        named = _rule(TRAY_NAMED, p.name) or (None if bolt else _rule(TRAY_NAMED, p.group))  # a bolt is not a hinge
        if named is None and (FORD_PART.match(_own_words(p.name)) or FORD_PART.match(_own_words(p.group))):
            named = (FORD_GROUP, 12)
        by_level, by_group = _rule(TRAY_RULES, level), _rule(TRAY_RULES, p.group)
        if named:
            out[p.id] = (named[1], named[0], "ชื่อ")
        elif bolt:
            if FASTENER.search(_own_words(p.group)):  # a group that is only the bolt's own name says nothing
                by_group = None
            found = by_group or by_level
            if found:
                own = tidy_name(MIRROR.sub("", p.group)) if by_group else tidy_name(level)
                out[p.id] = (found[1], FASTENER_GROUPS.get(found[1], own), "กลุ่ม" if by_group else "เลเยอร์")
            else:
                bolts.append(p)
        elif by_level:
            out[p.id] = (by_level[1], tidy_name(level), "เลเยอร์")
        elif by_group:
            out[p.id] = (by_group[1], tidy_name(MIRROR.sub("", p.group)), "กลุ่ม")
        else:
            group = UNSORTED_GROUP if DEFAULT_NAME.match(_own_words(p.group)) else tidy_name(MIRROR.sub("", p.group))
            out[p.id] = (TRAY_OTHER, group, "ไม่ทราบ")
    # a sub-assembly keeps the name of the designer's level its step is drawn on ('ตะแกรงมีลาย', not a second group)
    count: dict[int, dict[str, int]] = {}
    for step, group, how in out.values():
        if how == "เลเยอร์":
            count.setdefault(step, {})[group] = count.get(step, {}).get(group, 0) + 1
    main = {step: max(c, key=c.get) for step, c in count.items()}
    for pid, (step, group, how) in out.items():
        if how == "กลุ่ม" and step in main and group not in FASTENER_GROUPS.values():
            out[pid] = (step, main[step], how)
    held = [(p.bounds(), out[p.id]) for p in model.parts if p.id in out and out[p.id][2] != "ไม่ทราบ"
            and not FASTENER.search(_own_words(p.name))]
    for p in bolts:  # a bolt belongs to what it fastens
        box = p.bounds()
        near = min(held, key=lambda k: _gap(box, k[0]), default=None)
        if near is not None and _gap(box, near[0]) <= 50.0:
            step, group = near[1][0], near[1][1]
            out[p.id] = (step, FASTENER_GROUPS.get(step, group), "ชิ้นข้างเคียง")
        else:
            out[p.id] = (TRAY_OTHER, UNSORTED_GROUP, "ไม่ทราบ")
    return out


def tidy_name(text: str) -> str:
    """A name from the CAD file as the technician should read it: the known misspellings corrected."""
    for wrong, right in TRAY_SPELLING:
        text = text.replace(wrong, right)
    return re.sub(r"\s+", " ", text).strip()


def _with_side(name: str, side: str) -> str:
    """'บานพับ_Mirror 02' + ขวา → 'บานพับ ขวา 02' · 'พื้น ซ้าย2_Mirror' + ขวา → 'พื้น ขวา2'."""
    name = MIRROR.sub("", name).strip()
    if not side:
        return name
    if "ซ้าย" in name or "ขวา" in name:
        return name.replace("ซ้าย", side).replace("ขวา", side) if side == "ซ้าย" else name.replace("ซ้าย", side)
    m = re.match(r"^(.*?)(\s+\d+)?$", name)
    return f"{m.group(1)} {side}{m.group(2) or ''}"


def tidy_names(model: AssemblyModel, rear: float = 0.0) -> int:
    """Names for the technician: misspellings corrected, and ZW3D's '_Mirror' said as a side. With `rear` (+1: the
    rear of the body is at +X, −1: at −X) the side is where the part really is – left and right as seen from behind
    the vehicle looking forward – for a mirrored part and its original alike; without it a mirrored part is called
    ขวา and its original ซ้าย, as RRS draws them. The name in the file stays in the part's note. Returns how many
    names changed."""
    real = [p for p in model.parts if p.group != REF_GROUP]
    if not real:
        return 0
    lo, hi = model.bounds(real)
    mid, clear = (lo[1] + hi[1]) / 2, max((hi[1] - lo[1]) * 0.02, 1.0)
    twins = {MIRROR.sub("", t).strip() for p in real for t in (p.name, p.group) if MIRROR.search(t)}
    changed = 0
    for p in real:
        mirrored = bool(MIRROR.search(p.name) or MIRROR.search(p.group))
        side = ""
        if mirrored or p.name in twins or p.group in twins:
            off = p.centre()[1] - mid
            if rear and abs(off) > clear:
                side = "ซ้าย" if off * rear < 0 else "ขวา"
            elif not rear:
                side = "ขวา" if mirrored else "ซ้าย"
        name = tidy_name(_with_side(p.name, side) if side or mirrored else p.name)
        if name != p.name:
            if "ชื่อในไฟล์:" not in p.note:
                p.note = f"{p.note} · ชื่อในไฟล์: {p.name}".strip(" ·")
            p.name = name
            changed += 1
        p.group = tidy_name(MIRROR.sub("", p.group).strip())
    return changed


def apply_tray_sequence(model: AssemblyModel, job=None, explode: bool = True,
                        levels: dict[str, str] | None = None, tidy: bool = False) -> dict[str, int]:
    """The 13 steps put on a model: every part goes to its step (see tray_steps; the vehicle stays step 0). A step
    that gets no part becomes a step of work only. With `explode` the parts of each step wait in the direction they
    are fitted from. With `tidy` (a model from a CAD file) the parts also get the groups the technician reads and
    names without misspellings and '_Mirror'. Returns {group: the step most of its parts went to}."""
    found = tray_steps(model, levels)
    for p in model.parts:
        if p.id in found:
            p.step = found[p.id][0]
    upper = [p for p in model.parts if p.step == 2]
    width = None
    if upper:
        lo, hi = model.bounds(upper)
        width = hi[1] - lo[1]
    model.steps = tray_sequence(job, width)
    for n, step in enumerate(model.steps, 1):
        if not model.parts_of_step(n):
            step.no_parts = True
    real = [p for p in model.parts if p.step > 0]
    rear = 0.0
    if real:
        lo, hi = model.bounds(real)
        mid = [(lo[i] + hi[i]) / 2 for i in range(3)]
        half = [max((hi[i] - lo[i]) / 2, 1.0) for i in range(3)]
        tail = [p for p in real if p.step in (9, 12)]  # the rear is where the tail bar and the lamps are
        head = [p for p in real if p.step == 7]  # … and opposite the headboard
        if tail:
            rear = -1.0 if sum(p.centre()[0] for p in tail) / len(tail) < mid[0] else 1.0
        elif head:
            rear = 1.0 if sum(p.centre()[0] for p in head) / len(head) < mid[0] else -1.0
    if explode and real:
        auto_explode(model)  # what no rule below covers (small parts, bolts) moves away from the middle
        back = rear or 1.0
        lift = {1: 0.0, 2: 450.0, 3: 650.0, 7: 800.0}  # the lower frame lies on the jig; the rest comes down onto it
        for p in real:
            c = p.centre()
            if p.step in lift:
                p.explode = [0.0, 0.0, lift[p.step]]
            elif p.step in (8, 10):  # sides out to their side; a tailgate out to the rear
                along, across = (c[0] - mid[0]) / half[0], (c[1] - mid[1]) / half[1]
                if p.step == 8 and abs(along) > abs(across) and along * back > 0:
                    p.explode = [back * 600.0, 0.0, 0.0]
                else:
                    p.explode = [0.0, 550.0 if across >= 0 else -550.0, 0.0]
            elif p.step in (9, 12):
                p.explode = [back * 600.0, 0.0, 0.0]
    if tidy:
        for p in model.parts:
            if p.id in found:
                p.group = found[p.id][1]
        tidy_names(model, rear)
    where: dict[str, dict[int, int]] = {}
    for p in model.parts:
        count = where.setdefault(p.group, {})
        count[p.step] = count.get(p.step, 0) + 1
    return {g: max(c, key=c.get) for g, c in where.items()}


def tray_unsorted(model: AssemblyModel, levels: dict[str, str] | None = None) -> list[Part3D]:
    """The parts whose name, group and level do not say which step they belong to."""
    found = tray_steps(model, levels)
    return [p for p in model.parts if p.id in found and found[p.id][2] == "ไม่ทราบ"]


def _clean_name(text: str, fallback: str) -> str:
    return re.sub(r"\s+", " ", text).strip() or fallback


def _group_of(name: str) -> str:
    """'CROSS_MEMBER_03' / 'คานขวาง-3' / 'Bracket.2' → the name without its running number."""
    return re.sub(r"[\s_.:#-]*\d+$", "", name).strip() or name


def load_obj(path: str | Path, scale: float = 1.0, y_up: bool = False) -> list[Part3D]:
    """Wavefront OBJ: every object / group (o, g) is a part. Faces keep their corners (3 or more)."""
    verts: list[Vec] = []
    parts: list[Part3D] = []
    current: Part3D | None = None

    def start(name: str) -> Part3D:
        part = Part3D(f"m{len(parts) + 1}", _clean_name(name, f"ชิ้นที่ {len(parts) + 1}"), "", "mesh")
        part.group = _group_of(part.name)
        parts.append(part)
        return part

    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        tok = line.split()
        if not tok:
            continue
        if tok[0] == "v" and len(tok) >= 4:
            x, y, z = (float(t) * scale for t in tok[1:4])
            verts.append((x, -z, y) if y_up else (x, y, z))
        elif tok[0] in ("o", "g"):
            current = start(" ".join(tok[1:]))
        elif tok[0] == "f" and len(tok) >= 4:
            if current is None:
                current = start(Path(path).stem)
            idx = [int(t.split("/")[0]) for t in tok[1:]]
            current.mesh.append([list(verts[i - 1 if i > 0 else i]) for i in idx])
    return [p for p in parts if p.mesh]


def load_stl(path: str | Path, scale: float = 1.0, y_up: bool = False) -> Part3D:
    """STL (binary or text): the whole file is one part, named after the file."""
    data = Path(path).read_bytes()
    tris: list[list[list[float]]] = []
    count = struct.unpack_from("<I", data, 80)[0] if len(data) >= 84 else 0
    if len(data) == 84 + 50 * count and count:
        for i in range(count):
            vals = struct.unpack_from("<9f", data, 84 + 50 * i + 12)
            tris.append([list(vals[k:k + 3]) for k in (0, 3, 6)])
    else:
        nums = re.findall(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data.decode("utf-8", errors="replace"))
        pts = [[float(a), float(b), float(c)] for a, b, c in nums]
        tris = [pts[i:i + 3] for i in range(0, len(pts) - 2, 3)]
    mesh = [[[x * scale, -z * scale, y * scale] if y_up else [x * scale, y * scale, z * scale] for x, y, z in t]
            for t in tris]
    name = _clean_name(Path(path).stem.replace("_", " "), "ชิ้นส่วน")
    return Part3D("m1", name, _group_of(name), "mesh", mesh=mesh)


def model_from_files(paths: list[str | Path], y_up: bool = False) -> AssemblyModel:
    """OBJ / STL files → a model with a step per group and an exploded position per part.
    A model smaller than 50 units is taken as metres (× 1000)."""
    parts: list[Part3D] = []
    for path in paths:
        got = load_obj(path, y_up=y_up) if str(path).lower().endswith(".obj") else [load_stl(path, y_up=y_up)]
        for p in got:
            p.id = f"m{len(parts) + 1}"
            parts.append(p)
    if not parts:
        raise ValueError("ไม่พบชิ้นส่วนในไฟล์ (ต้องเป็น OBJ หรือ STL)")
    model = AssemblyModel(Path(paths[0]).stem, parts, source="file")
    lo, hi = model.bounds()
    if max(hi[i] - lo[i] for i in range(3)) < 50:
        for p in parts:
            p.mesh = [[[c * 1000 for c in pt] for pt in f] for f in p.mesh]
        model.note = "ขนาดโมเดลเล็กกว่า 50 หน่วย – ถือว่าเป็นเมตร (× 1000 เป็น มม.)"
    auto_steps(model)
    auto_explode(model)
    return model


def swap_up_axis(model: AssemblyModel) -> None:
    """Imported meshes drawn with Y up → Z up (and back, turned the other way)."""
    for p in model.parts:
        if p.shape == "mesh":
            p.mesh = [[[x, -z, y] for x, y, z in f] for f in p.mesh]
            ex, ey, ez = p.explode
            p.explode = [ex, -ez, ey]


def face_count(model: AssemblyModel) -> int:
    return sum(len(p.mesh) for p in model.parts if p.shape == "mesh")


# --------------------------------------------------------------------------- sample models from the job
def _positions(first: float, last: float, pitch: float) -> list[float]:
    n = max(1, math.ceil((last - first) / pitch))
    return [first + (last - first) * i / n for i in range(n + 1)]


class _Builder:
    def __init__(self, name: str):
        self.model = AssemblyModel(name, source="auto")
        self._n = 0
        self.step = 0

    def next_step(self, title: str, detail: str, **kw) -> int:
        self.model.steps.append(Step(title, detail, **kw))
        self.step = len(self.model.steps)
        return self.step

    def add(self, name: str, group: str, shape: str, dims, pos, *, axis="x", explode=(0, 0, 0), color=STEEL,
            size="", flip=False, step: int | None = None, note="") -> Part3D:
        self._n += 1
        part = Part3D(f"p{self._n}", name, group, shape, [float(x) for x in dims], axis, [float(x) for x in pos], flip,
                      color, [float(x) for x in explode], self.step if step is None else step, "", size, note)
        self.model.parts.append(part)
        return part


def _subframe(b: _Builder, job, torque: str) -> float:
    """Vehicle (reference), mounting pads, longitudinal rails, bolts, cross members, floor frame, floor.
    Returns the height of the top of the floor."""
    cab = job.cab_spec
    length, width, gap = float(job.body_length), float(job.body_width), float(job.cab_gap)
    frame = float(cab.frame_behind_cab)
    rail_y = 446.0  # BEMM 5.1.5 dimension A (frame feature centre line) – confirm with the vehicle
    # ---- the vehicle, for the position only
    for side in (-1, 1):
        b.add("แชสซีรถ (รางข้าง)", REF_GROUP, "box", (frame + 300, 70, 160), (-gap - 300, side * rail_y - 35, -172),
              color=VEHICLE, step=0)
    b.add("ผนังหลังเก๋ง", REF_GROUP, "box", (40, 1850, 1250), (-gap - 40, -925, -150), color=VEHICLE, step=0,
          note=f"ช่องห่างหลังเก๋ง {gap:g} มม. (BEMM ≥ 28)")
    pads_x = [150.0, round(frame * 0.5), frame - 200.0]
    pads_x = [x for x in pads_x if x < length - 60]
    b.next_step("ตรวจแท่นยึดบนแชสซี",
                "ทำความสะอาดหน้าแท่นยึดทุกจุด ตรวจว่าไม่มีสี/สนิมหนา ตรวจแนวท่อ DEF และสายไฟใต้รางแชสซีก่อนวางโครง "
                "ใช้แท่นยึดที่รถให้มาครบทุกจุด", check="แท่นยึดครบทั้ง 2 ข้าง หน้าสัมผัสสะอาด", ref="5.1.4 / 3.2.1",
                warning="ห้ามเจาะ/เชื่อมแชสซีเพิ่ม เว้นแต่ตามข้อ 5.6.4")
    for side in (-1, 1):
        for x in pads_x:
            b.add("แท่นยึดบนแชสซี (ของรถ)", "แท่นยึด", "box", (140, 90, 12), (x - 70, side * rail_y - 45, -12),
                  color="#7C8894", size="140×90")
    # ---- longitudinal rails
    b.next_step("วางคานตามยาว (ซับเฟรม) ซ้าย–ขวา",
                "วางคานตามยาวตรงเหนือรางแชสซี ให้นั่งบนแท่นยึดเต็มหน้าทุกจุด ปลายหน้าเว้นจากหลังเก๋งตามช่องห่างที่กำหนด "
                "คานต้องแนบโดยไม่ต้องงัด (ไม่มี pre-load)", check=f"ช่องห่างหลังเก๋ง ≥ 28 มม. (งานนี้ {gap:g} มม.) · "
                "ระยะทแยงมุมสองแนวเท่ากัน", ref="5.1.4 / 5.6.5", tools="เครน/รอก ตลับเมตร ฉาก")
    for side in (-1, 1):
        b.add("คานตามยาว " + ("ขวา" if side < 0 else "ซ้าย"), "ซับเฟรม", "channel", (length, 50, 100, 5),
              (0, side * rail_y + (25 if side < 0 else -25), 0), explode=(0, 0, 420), size=f"C100×50×5 L={length:g}",
              flip=side < 0)
    # ---- bolts
    warn = ("ซับเฟรมแข็ง (ตู้): แท่นคู่หน้าใช้แบบยืดหยุ่น ~1 kN/มม. จำกัด ±12 มม. สลัก captive – แท่นอื่นยึดแข็ง"
            if job.rigid_subframe else "ผิวสัมผัสห้ามเป็นสีฝุ่น – แหวนต้องไม่ยุบที่แรงขันจริง")
    b.next_step(f"ยึดคานตามยาวกับแท่นยึด – สลัก {job.bolt_size} เกรด {job.bolt_grade}",
                "ใส่สลักพร้อมแหวนหนา Ø50×5 และน็อตล็อกทุกแท่น ขันมือให้ครบก่อน แล้วขันแรงบิดไล่จากกลางออกหัว–ท้าย "
                "ทำเครื่องหมายสีที่หัวสลักเมื่อขันครบ", torque=torque, tools="ประแจวัดแรงบิด บล็อก ปากกาเคมี",
                check="ขันครบทุกตัว มีเครื่องหมายสี", ref="5.1.4 / 1.12", warning=warn)
    for side in (-1, 1):
        for x in pads_x:
            for dx in (-35, 35):
                y = side * rail_y
                b.add("แหวนรอง Ø50×5", "สลักยึด", "rod", (5, 25, 14), (x + dx, y, 5), axis="z", color="#9AA5B1",
                      explode=(0, side * 260, 180), size="Ø50×5")
                b.add(f"สลัก {job.bolt_size} เกรด {job.bolt_grade} + น็อตล็อก", "สลักยึด", "rod", (16, 13, 6),
                      (x + dx, y, 10), axis="z", color=BOLT, explode=(0, side * 260, 260), size=job.bolt_size)
    # ---- cross members
    xs = _positions(50.0, length - 90.0, 600.0)
    b.next_step("วางคานขวาง", f"วางคานขวาง {len(xs)} ตัวบนคานตามยาว ระยะห่างไม่เกิน 600 มม. เริ่มจากตัวหน้าและตัวท้าย "
                "ตั้งฉากกับคานตามยาว แต้มเชื่อม/ขันยึดชั่วคราวก่อน ตรวจระนาบแล้วจึงเชื่อม/ขันจริง",
                check="ระยะห่างคานขวาง ≤ 600 มม. · ผิวบนอยู่ระนาบเดียวกัน", ref="5.6.3", tools="ระดับน้ำ ฉาก เครื่องเชื่อม")
    cm_len = width - 100
    for n, x in enumerate(xs, 1):
        b.add("คานขวาง", "คานขวาง", "channel", (cm_len, 40, 75, 4), (x, -cm_len / 2, 100), axis="y",
              explode=(0, 0, 300 + 25 * (n % 2)), size=f"C75×40×4 L={cm_len:g}")
    # ---- floor frame
    b.next_step("ประกอบกรอบพื้น (คานข้าง + คานหัว–ท้าย)",
                "สวมคานข้างซ้าย–ขวาเข้ากับปลายคานขวาง แล้วปิดคานหัวและคานท้าย ตรวจความกว้างรวมและระยะทแยงมุม",
                check=f"กว้างรวม {width:g} มม. (BEMM ≤ {cab.max_body_width}) · ยาว {length:g} มม.", ref="1.11.1",
                tools="ปากกาจับ C ตลับเมตร")
    for side in (-1, 1):
        b.add("คานข้าง " + ("ขวา" if side < 0 else "ซ้าย"), "กรอบพื้น", "box", (length, 50, 75),
              (0, side * (width / 2 - 25) - 25, 100), explode=(0, side * 520, 0), size=f"□75×50 L={length:g}")
    b.add("คานหัว", "กรอบพื้น", "box", (50, cm_len, 75), (0, -cm_len / 2, 100), explode=(-80, 0, 520),
          size=f"□75×50 L={cm_len:g}")
    b.add("คานท้าย", "กรอบพื้น", "box", (50, cm_len, 75), (length - 50, -cm_len / 2, 100), explode=(520, 0, 0),
          size=f"□75×50 L={cm_len:g}")
    # ---- floor
    b.next_step("ปูพื้นกระบะ", "วางแผ่นพื้นซ้าย–ขวาชนกันที่แนวกึ่งกลาง ยึดกับคานขวางและกรอบพื้น – ไม่ยึดกับหลังแชสซีรถ "
                "ซีลรอยต่อและทุกจุดที่ยึดทะลุพื้น", check="แผ่นพื้นแนบสนิท ไม่กระดก", ref="5.6.3 / 5.5",
                tools="สว่าน สกรู/รีเวต ซีลแลนต์")
    for side in (-1, 1):
        b.add("แผ่นพื้น " + ("ขวา" if side < 0 else "ซ้าย"), "พื้น", "box", (length, width / 2, 4),
              (0, -width / 2 if side < 0 else 0, 175), color=PLATE, explode=(0, side * 150, 600),
              size=f"t4 {width / 2:g}×{length:g}")
    return 179.0


def _lamps(b: _Builder, job, floor_z: float) -> None:
    length, width = float(job.body_length), float(job.body_width)
    pad = float(job.cab_spec.pad_height_mro)
    low, high = job.lamp_low - pad, job.lamp_high - pad
    b.next_step("ติดตั้งไฟท้าย ป้ายทะเบียน และเดินสายไฟ",
                "ยึดโคมไฟท้ายซ้าย–ขวาและขายึดป้ายทะเบียน เดินสายผ่านยางกันน้ำ ต่อสัญญาณเบรก/ไฟหรี่จากสายที่รถเตรียมไว้ "
                "ทดสอบไฟทุกดวง",
                check=f"ขอบล่างโคม ≥ 500 มม. จากพื้น (งานนี้ {job.lamp_low}) · ขอบบน ≤ 1200 ({job.lamp_high}) · "
                f"ห่างขอบนอก ≤ 400 ({job.lamp_from_edge})", ref="4.6.3 / 4.6.9 / 4.6.10",
                warning="ห้ามต่อไฟท้ายใหม่เข้าวงจรไฟท้ายเดิมโดยตรง", tools="ชุดย้ำสาย ท่อหด มัลติมิเตอร์")
    lamp_w = 160.0
    for side in (-1, 1):
        b.add("ขาแขวนคานไฟท้าย", "ไฟ & ป้าย", "box", (50, 50, 100 - (low - 20)), (length - 110, side * 446 - 25, low - 20),
              explode=(300, 0, -150), size="□50×50")
    b.add("คานไฟท้าย", "ไฟ & ป้าย", "box", (20, width - 100, high - low + 40), (length - 60, -(width - 100) / 2, low - 20),
          explode=(380, 0, 0), size=f"{width - 100:g}×{high - low + 40:g}")
    for side in (-1, 1):
        y = side * (width / 2 - job.lamp_from_edge) - (lamp_w if side > 0 else 0)
        b.add("ไฟท้ายรวม " + ("ขวา" if side < 0 else "ซ้าย"), "ไฟ & ป้าย", "box", (40, lamp_w, max(60.0, high - low)),
              (length - 40, y, low), color=LAMP, explode=(450, 0, 0), size="โคม LED")
    b.add("ขายึดป้ายทะเบียน", "ไฟ & ป้าย", "box", (10, 440, 160), (length - 10, -220, min(low, floor_z - 420)),
          color="#F2F4F7", explode=(520, 0, 0), size="440×160")


def build_tray(job) -> AssemblyModel:
    """กระบะพื้นเรียบ: sub-frame, floor, headboard, drop sides, lamps – from the sizes of the job."""
    import_torque = _torque_text(job)
    b = _Builder(f"กระบะพื้นเรียบ {job.body_width / 1000:.2f} × {job.body_length / 1000:.2f} ม. – {job.cab_spec.name}")
    z = _subframe(b, job, import_torque)
    length, width, head = float(job.body_length), float(job.body_width), max(400.0, float(job.body_height) - z)
    b.next_step("ติดตั้งโครงกันหัว", "ตั้งเสาโครงกันหัวซ้าย–ขวาบนคานหัว ยึดคานบนและตะแกรง ตรวจฉากกับพื้น "
                "โครงกันหัวต้องไม่แตะเก๋งตลอดช่วงที่แชสซีบิดตัว", check="ช่องห่างหลังเก๋ง ≥ 28 มม. ตลอดความสูง · ตั้งฉากกับพื้น",
                ref="1.11.3", tools="ฉาก ระดับน้ำ")
    for side in (-1, 1):
        b.add("เสาโครงกันหัว " + ("ขวา" if side < 0 else "ซ้าย"), "โครงกันหัว", "box", (50, 50, head),
              (0, side * (width / 2 - 25) - 25, z), explode=(0, side * 200, 650), size=f"□50×50 L={head:g}")
    b.add("คานบนโครงกันหัว", "โครงกันหัว", "box", (50, width - 100, 50), (0, -(width - 100) / 2, z + head - 50),
          explode=(0, 0, 850), size=f"□50×50 L={width - 100:g}")
    b.add("ตะแกรงกันหัว", "โครงกันหัว", "box", (6, width - 100, head - 50), (22, -(width - 100) / 2, z), color="#6F7D8C",
          explode=(-60, 0, 1050), size=f"{width - 100:g}×{head - 50:g}")
    gate = min(350.0, head)
    b.next_step("ติดตั้งฝาข้างและฝาท้าย", "ยึดบานพับกับกรอบพื้น แขวนฝาข้างซ้าย–ขวาและฝาท้าย ปรับกลอนให้ล็อกสนิททุกจุด "
                "เปิด–ปิดทดสอบ", check="ฝาปิดสนิท กลอนล็อกครบ ช่องไฟเท่ากัน", tools="ประแจ สว่าน")
    for side in (-1, 1):
        b.add("ฝาข้าง " + ("ขวา" if side < 0 else "ซ้าย"), "ฝาข้าง", "box", (length - 70, 20, gate),
              (50, side * (width / 2 - 10) - 10, z), color=PLATE, explode=(0, side * 600, 0),
              size=f"{length - 70:g}×{gate:g}")
    b.add("ฝาท้าย", "ฝาท้าย", "box", (20, width - 40, gate), (length - 20, -(width - 40) / 2, z), color=PLATE,
          explode=(650, 0, 0), size=f"{width - 40:g}×{gate:g}")
    _lamps(b, job, z)
    apply_tray_sequence(b.model, job, explode=False)  # the builder's own steps were only the order of building
    b.model.note = SAMPLE_NOTE
    return b.model


def build_box(job) -> AssemblyModel:
    """ตู้ทึบ: the same sub-frame and floor, then front wall, side walls, roof and rear doors."""
    b = _Builder(f"ตู้ทึบ {job.body_width / 1000:.2f} × {job.body_length / 1000:.2f} × {job.body_height / 1000:.2f} ม. – "
                 f"{job.cab_spec.name}")
    z = _subframe(b, job, _torque_text(job))
    length, width, top = float(job.body_length), float(job.body_width), float(job.body_height)
    wall = top - z
    b.next_step("ตั้งผนังหน้า", "ตั้งผนังหน้าบนกรอบพื้น ค้ำชั่วคราว ตรวจดิ่ง", check="ช่องห่างหลังเก๋ง ≥ 28 มม. · "
                "เหนือหลังคาเก๋ง ≥ 30 มม.", ref="1.11.1 F/H", tools="ค้ำยัน ระดับน้ำ")
    b.add("ผนังหน้า", "ผนังตู้", "box", (30, width, wall), (0, -width / 2, z), color=PLATE, explode=(-150, 0, 900),
          size=f"{width:g}×{wall:g}")
    b.next_step("ตั้งผนังข้างซ้าย–ขวา", "ตั้งผนังข้างชนผนังหน้า ยึดกับกรอบพื้นตลอดความยาว ตรวจระยะทแยงมุมของหน้าตัดตู้",
                check=f"กว้างนอก {width:g} มม. · ทแยงมุมเท่ากัน", ref="5.1.1")
    for side in (-1, 1):
        b.add("ผนังข้าง " + ("ขวา" if side < 0 else "ซ้าย"), "ผนังตู้", "box", (length - 30, 30, wall),
              (30, side * (width / 2 - 15) - 15, z), color=PLATE, explode=(0, side * 800, 0), size=f"{length - 30:g}×{wall:g}")
    b.next_step("ปิดหลังคา", "วางหลังคาบนผนังทั้งสามด้าน ยึดและซีลรอยต่อทั้งหมด", check="ซีลรอยต่อครบ ไม่รั่ว",
                ref="5.5", warning=f"ความสูงตัวถังเหนือแชสซี ≤ 2400 มม. (งานนี้ {top:g})")
    b.add("หลังคา", "ผนังตู้", "box", (length, width, 30), (0, -width / 2, top - 30), color=PLATE, explode=(0, 0, 900),
          size=f"{width:g}×{length:g}")
    b.next_step("ติดตั้งประตูท้าย", "แขวนบานประตูซ้าย–ขวา ปรับบานพับและกลอนก้านยาวให้ปิดสนิท ติดยางขอบ",
                check="ประตูปิดสนิท กลอนล็อกครบ")
    for side in (-1, 1):
        b.add("ประตูท้าย " + ("ขวา" if side < 0 else "ซ้าย"), "ประตู", "box", (30, width / 2 - 30, wall - 30),
              (length - 30, -width / 2 + 30 if side < 0 else 0, z), color=PLATE, explode=(700, side * 300, 0),
              size=f"{width / 2 - 30:g}×{wall - 30:g}")
    _lamps(b, job, z)
    b.model.note = SAMPLE_NOTE
    return b.model


SAMPLE_NOTE = ("โมเดลตัวอย่างสร้างจากขนาดในงาน เพื่อแสดงลำดับและตำแหน่งประกอบ – หน้าตัดเหล็ก จำนวนคาน ตำแหน่งแท่นยึด "
               "ไม่ใช่แบบผลิตจริงของ RRS · นำเข้าโมเดลจริง (OBJ/STL จาก CAD) เพื่อใช้งานจริง")


def _torque_text(job) -> str:
    from .install_manual import torque_for

    t = torque_for(job.bolt_size, job.bolt_grade)
    return f"{job.bolt_size} เกรด {job.bolt_grade}: {t[1]:g}–{t[0]:g} Nm" if t else ""


def build_for_job(job) -> AssemblyModel | None:
    kind = job.product_spec.kind
    return build_tray(job) if kind == "tray" else build_box(job) if kind == "box" else None


# --------------------------------------------------------------------------- printable
def render_steps_html(model: AssemblyModel, images: dict[int, str], job_no: str = "", done: set[int] | None = None) -> str:
    """The 3D assembly manual: one block per step with its picture, its parts and what to check."""
    import html

    e = html.escape
    done = done or set()
    blocks = []
    for n, s in enumerate(model.steps, 1):
        rows = "".join(f"<tr><td align='center'>{b.no}</td><td>{e(b.name)}</td><td>{e(b.size)}</td><td>{e(b.part_no)}</td>"
                       f"<td align='center'>{b.qty}</td></tr>" for b in model.bom(n))
        if not rows and s.no_parts:
            rows = "<tr><td colspan='5' style='color:#6B7A90'>ขั้นนี้เป็นงาน / การตรวจ – ไม่มีชิ้นส่วนใหม่</td></tr>"
        extra = "".join(x for x in (
            f"<p><b>แรงขัน:</b> {e(s.torque)}</p>" if s.torque else "",
            f"<p><b>เครื่องมือ:</b> {e(s.tools)}</p>" if s.tools else "",
            f"<p><b>จุดตรวจ:</b> {e(s.check)}</p>" if s.check else "",
            f"<p style='color:#D64545'><b>⚠ {e(s.warning)}</b></p>" if s.warning else ""))
        img = f"<p><img src='{e(images[n])}' width='640'></p>" if n in images else ""
        blocks.append(
            f"<h2 style='page-break-before:always'>{e(s.phase) + ' · ' if s.phase else ''}ขั้นที่ {n} / {len(model.steps)} – {e(s.title)} "
            f"{'☑' if n in done else '☐'}</h2>{img}<p>{e(s.detail)}</p>{extra}"
            f"<table width='100%' cellspacing='0' cellpadding='3' border='1'><tr><th width='8%'>#</th><th width='40%'>ชิ้นส่วน</th>"
            f"<th width='27%'>ขนาด</th><th width='15%'>Part No.</th><th width='10%'>จำนวน</th></tr>{rows}</table>"
            + (f"<p style='color:#6B7A90'>BEMM {e(s.ref)}</p>" if s.ref else ""))
    return (f"<html><head><meta charset='utf-8'><style>body{{font-size:10.5pt;color:#1E2A3A}}h1{{color:#1F4E79;font-size:16pt}}"
            f"h2{{color:#1F4E79;font-size:12pt;margin-top:16px}}th{{background:#E8EEF6}}</style></head><body>"
            f"<h1>คู่มือประกอบ 3 มิติ – {e(model.name)}</h1><p style='color:#6B7A90'>งาน {e(job_no) or '-'} · "
            f"{len(model.steps)} ขั้นตอน · {sum(b.qty for b in model.bom())} ชิ้น</p>"
            + (f"<p style='color:#E08A1E'>{e(model.note)}</p>" if model.note else "") + "".join(blocks) + "</body></html>")
