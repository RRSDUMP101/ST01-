"""Data model for a Part List (BOM) document."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, fields
from datetime import date
from pathlib import Path

# Canonical columns of the part table. The key is used internally and in
# saved project files; the Thai label is what the user sees in the UI.
COLUMNS: list[tuple[str, str]] = [
    ("item_no", "ลำดับ"),
    ("part_no", "รหัสชิ้นส่วน"),
    ("drawing_no", "เลขที่แบบ"),
    ("name", "ชื่อชิ้นส่วน"),
    ("material", "วัสดุ"),
    ("spec", "ขนาด"),
    ("thickness", "หนา (mm)"),
    ("qty", "จำนวน"),
    ("unit", "หน่วย"),
    ("weight", "น้ำหนัก/ชิ้น (kg)"),
    ("stock_code", "รหัสสโตร์"),
    ("process", "กระบวนการ"),
    ("status", "สถานะ"),
    ("remark", "หมายเหตุ"),
]
COLUMN_KEYS = [k for k, _ in COLUMNS]
COLUMN_LABELS = dict(COLUMNS)

NUMERIC_COLUMNS = {"qty", "weight", "thickness"}

STATUSES = ["รอตรวจ", "พร้อม", "ขาด", "รอสั่งซื้อ"]
PROCESSES = ["", "ตัด/พับ", "เชื่อม", "ยิงทราย/ทำสี", "พ่นสี", "ประกอบ", "ซื้อสำเร็จ"]
UNITS = ["ชิ้น", "ชุด", "แผ่น", "เส้น", "ม.", "กก.", "ตัว"]
COMMON_THICKNESS = [1.0, 1.2, 1.5, 1.6, 2.0, 2.3, 2.5, 3.0, 3.2, 4.0, 4.5, 5.0, 6.0, 8.0, 9.0, 10.0, 12.0]  # mm

FILE_SUFFIX = ".rrspl"


@dataclass
class Part:
    item_no: str = ""
    part_no: str = ""
    drawing_no: str = ""
    name: str = ""
    material: str = ""
    spec: str = ""
    thickness: float = 0  # mm, plate parts
    qty: float = 1
    unit: str = "ชิ้น"
    weight: float = 0
    stock_code: str = ""
    process: str = ""
    status: str = "รอตรวจ"
    remark: str = ""
    image: str = ""  # picture of the part (from the company Parts List workbook), not a table column
    outline: list = field(default_factory=list)  # flat pattern from the drawing: [outer, hole, ...] in mm (nesting)
    drawing_thickness: float = 0  # thickness the drawing gave (kept so "ตามแบบ" can undo a manual value)
    drawing_qty: float = 0  # quantity the drawing gave ('16 ชิ้น'), 0 = it gave none
    qty_source: str = ""  # where the quantity came from: 'แบบ (ป้ายที่ชิ้นงาน): “16 ชิ้น”'
    drawing_material: str = ""  # material the drawing gave ('M=Steel'), kept so it can be put back
    material_source: str = ""  # where the material came from: 'แบบ (ป้ายที่ชิ้นงาน): “M=Steel”', 'กำหนดเอง'
    bend_lines: list = field(default_factory=list)  # bend lines of the flat pattern [[(x, y), (x, y)], ...] (marks)
    cad_fixes: list = field(default_factory=list)  # what the import repaired in its lines ('ต่อเส้น 2 จุด ...')

    def get(self, key: str):
        return getattr(self, key)

    def set(self, key: str, value) -> None:
        if key in NUMERIC_COLUMNS:
            value = to_number(value)
        else:
            value = "" if value is None else str(value).strip()
        setattr(self, key, value)

    @classmethod
    def from_dict(cls, data: dict) -> Part:
        part = cls()
        for key in COLUMN_KEYS:
            if key in data:
                part.set(key, data[key])
        if "thickness" not in data:  # files saved before the column existed: "t3.2 x 300 x 150"
            part.thickness = parse_thickness(part.spec, plain_number=False)
        part.image = str(data.get("image", "") or "")
        part.outline = [[(float(x), float(y)) for x, y in loop] for loop in data.get("outline") or []]
        part.drawing_thickness = to_number(data.get("drawing_thickness", 0))
        part.drawing_qty = to_number(data.get("drawing_qty", 0))
        part.qty_source = str(data.get("qty_source", "") or "")
        part.drawing_material = str(data.get("drawing_material", "") or "")
        part.material_source = str(data.get("material_source", "") or "")
        part.bend_lines = [[(float(x), float(y)) for x, y in line] for line in data.get("bend_lines") or []]
        part.cad_fixes = [str(t) for t in data.get("cad_fixes") or []]
        return part


@dataclass
class ProjectInfo:
    """Header information of a Part List (links it to the SO / job)."""

    so_no: str = ""
    customer: str = ""
    vehicle_model: str = ""
    job_type: str = ""
    drawing_no: str = ""
    revision: str = ""
    created: str = field(default_factory=lambda: date.today().isoformat())
    prepared_by: str = ""
    build_qty: int = 1  # number of vehicles/sets to produce from this Part List


@dataclass
class DrawingRecord:
    """One 2D drawing (DWG/DXF) registered in the job - ทะเบียนแบบ."""

    file_name: str = ""
    path: str = ""
    drawing_no: str = ""
    title: str = ""
    revision: str = ""
    material: str = ""
    thickness: str = ""
    part_count: int = 0
    pieces: int = 0  # sum of the quantities of its parts (ชิ้น)
    imported: str = field(default_factory=lambda: date.today().isoformat())
    status: str = "รอตรวจ"


@dataclass
class PartList:
    info: ProjectInfo = field(default_factory=ProjectInfo)
    parts: list[Part] = field(default_factory=list)
    drawings: list[DrawingRecord] = field(default_factory=list)

    # ---- summary -----------------------------------------------------
    @property
    def total_qty(self) -> float:
        return sum(p.qty for p in self.parts)

    @property
    def total_weight(self) -> float:
        return sum(p.qty * p.weight for p in self.parts)

    def status_counts(self) -> dict[str, int]:
        counts = {s: 0 for s in STATUSES}
        for p in self.parts:
            counts[p.status] = counts.get(p.status, 0) + 1
        return counts

    def renumber(self) -> None:
        for i, p in enumerate(self.parts, start=1):
            p.item_no = str(i)

    # ---- persistence -------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "format": "rrs-partlist",
            "version": 1,
            "info": asdict(self.info),
            "parts": [asdict(p) for p in self.parts],
            "drawings": [asdict(d) for d in self.drawings],
        }

    @classmethod
    def from_dict(cls, data: dict) -> PartList:
        info = _dataclass_from(ProjectInfo, data.get("info", {}))
        parts = [Part.from_dict(p) for p in data.get("parts", [])]
        drawings = [_dataclass_from(DrawingRecord, d) for d in data.get("drawings", [])]
        return cls(info=info, parts=parts, drawings=drawings)

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> PartList:
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def _dataclass_from(cls, data: dict):
    """Build a dataclass from saved data, ignoring unknown keys and fixing value types."""
    kwargs = {}
    for f in fields(cls):
        if f.name in data:
            value = data[f.name]
            kwargs[f.name] = int(to_number(value)) if f.type == "int" else str(value)
    return cls(**kwargs)


_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def to_number(value) -> float:
    """Parse numbers the way they appear in CAD/Excel exports ("1,250.5", "2 pcs", "")."""
    if value is None or value == "":
        return 0
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        match = _NUMBER_RE.search(str(value).replace(",", ""))
        if not match:
            return 0
        number = float(match.group())
    return int(number) if number.is_integer() else number


# 't3.2', 'THK 4.5', 'Thickness=3.00', 'SS400 t=6', 'หนา 1.6', 'T: 2'
_THICK_PREFIX_RE = re.compile(r"(?:thickness|thk\.?|(?<![a-z0-9_\-])t|ความหนา|หนา)\s*[=:.]?\s*(\d+(?:\.\d+)?)",
                              re.IGNORECASE)
# '2.3 mm', '4 มิล', '9มิล', '3 มม.' - a number with a thickness unit (a length in mm is longer than a plate is thick)
_THICK_UNIT_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(?:มิล|มม\.?|mm(?![a-z]))", re.IGNORECASE)
MAX_PLATE_THICKNESS = 50.0


def parse_thickness(text, plain_number: bool = True) -> float:
    """Plate thickness in mm from drawing notes and specs; 0 when the text gives none.
    plain_number: a bare '3.2' counts (a THK attribute or a thickness column), not in a spec or a note."""
    text = "" if text is None else str(text)
    if not text.strip():
        return 0
    match = _THICK_PREFIX_RE.search(text)
    if match:
        value = float(match.group(1))
        return _int_or(value) if 0 < value <= MAX_PLATE_THICKNESS else 0
    match = _THICK_UNIT_RE.search(text)
    if match and 0 < float(match.group(1)) <= MAX_PLATE_THICKNESS:
        return _int_or(float(match.group(1)))
    if plain_number and re.fullmatch(r"\s*\d+(?:\.\d+)?\s*", text):
        return to_number(text)
    return 0


def _int_or(value: float):
    return int(value) if float(value).is_integer() else value


def strip_thickness(text: str) -> str:
    """The text without its thickness: 'เฟรมบน t3' -> 'เฟรมบน'."""
    text = _THICK_UNIT_RE.sub(" ", _THICK_PREFIX_RE.sub(" ", text or ""))
    return re.sub(r"\s+", " ", text).strip()
