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
            if not self.parts_of_step(n):
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
        b.add("ฝาข้าง " + ("ขวา" if side < 0 else "ซ้าย"), "ฝาข้าง & ฝาท้าย", "box", (length - 70, 20, gate),
              (50, side * (width / 2 - 10) - 10, z), color=PLATE, explode=(0, side * 600, 0),
              size=f"{length - 70:g}×{gate:g}")
    b.add("ฝาท้าย", "ฝาข้าง & ฝาท้าย", "box", (20, width - 40, gate), (length - 20, -(width - 40) / 2, z), color=PLATE,
          explode=(650, 0, 0), size=f"{width - 40:g}×{gate:g}")
    _lamps(b, job, z)
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
        extra = "".join(x for x in (
            f"<p><b>แรงขัน:</b> {e(s.torque)}</p>" if s.torque else "",
            f"<p><b>เครื่องมือ:</b> {e(s.tools)}</p>" if s.tools else "",
            f"<p><b>จุดตรวจ:</b> {e(s.check)}</p>" if s.check else "",
            f"<p style='color:#D64545'><b>⚠ {e(s.warning)}</b></p>" if s.warning else ""))
        img = f"<p><img src='{e(images[n])}' width='640'></p>" if n in images else ""
        blocks.append(
            f"<h2 style='page-break-before:always'>ขั้นที่ {n} / {len(model.steps)} – {e(s.title)} "
            f"{'☑' if n in done else '☐'}</h2>{img}<p>{e(s.detail)}</p>{extra}"
            f"<table width='100%' cellspacing='0' cellpadding='3' border='1'><tr><th width='8%'>#</th><th width='40%'>ชิ้นส่วน</th>"
            f"<th width='27%'>ขนาด</th><th width='15%'>Part No.</th><th width='10%'>จำนวน</th></tr>{rows}</table>"
            + (f"<p style='color:#6B7A90'>BEMM {e(s.ref)}</p>" if s.ref else ""))
    return (f"<html><head><meta charset='utf-8'><style>body{{font-size:10.5pt;color:#1E2A3A}}h1{{color:#1F4E79;font-size:16pt}}"
            f"h2{{color:#1F4E79;font-size:12pt;margin-top:16px}}th{{background:#E8EEF6}}</style></head><body>"
            f"<h1>คู่มือประกอบ 3 มิติ – {e(model.name)}</h1><p style='color:#6B7A90'>งาน {e(job_no) or '-'} · "
            f"{len(model.steps)} ขั้นตอน · {sum(b.qty for b in model.bom())} ชิ้น</p>"
            + (f"<p style='color:#E08A1E'>{e(model.note)}</p>" if model.note else "") + "".join(blocks) + "</body></html>")
