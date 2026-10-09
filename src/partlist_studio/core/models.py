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
    ("spec", "ขนาด/ความหนา"),
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

NUMERIC_COLUMNS = {"qty", "weight"}

STATUSES = ["รอตรวจ", "พร้อม", "ขาด", "รอสั่งซื้อ"]
PROCESSES = ["", "ตัด/พับ", "เชื่อม", "ยิงทราย/ทำสี", "พ่นสี", "ประกอบ", "ซื้อสำเร็จ"]
UNITS = ["ชิ้น", "ชุด", "แผ่น", "เส้น", "ม.", "กก.", "ตัว"]

FILE_SUFFIX = ".rrspl"


@dataclass
class Part:
    item_no: str = ""
    part_no: str = ""
    drawing_no: str = ""
    name: str = ""
    material: str = ""
    spec: str = ""
    qty: float = 1
    unit: str = "ชิ้น"
    weight: float = 0
    stock_code: str = ""
    process: str = ""
    status: str = "รอตรวจ"
    remark: str = ""

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
