"""Store / warehouse stock and material requirement check for a Part List.

The stock numbers always come from the store's own file (Express export, store
Google Sheet, Excel). Nothing here invents stock: an item that is not in the
file is reported as "ไม่พบในสต็อก" for the store to confirm.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .mapping import find_header_row, normalize
from .models import Part, PartList, to_number
from .tabular import read_table, write_table

STOCK_COLUMNS: list[tuple[str, str]] = [
    ("code", "รหัสสินค้า"),
    ("name", "ชื่อสินค้า"),
    ("material", "วัสดุ"),
    ("spec", "ขนาด/ความหนา"),
    ("unit", "หน่วย"),
    ("on_hand", "คงเหลือ"),
    ("min_qty", "Min"),
    ("max_qty", "Max"),
    ("location", "คลัง"),
]
STOCK_KEYS = [k for k, _ in STOCK_COLUMNS]
STOCK_LABELS = dict(STOCK_COLUMNS)
STOCK_NUMERIC = {"on_hand", "min_qty", "max_qty"}

STOCK_ALIASES: dict[str, list[str]] = {
    "code": ["code", "item code", "stock code", "sku", "รหัสสินค้า", "รหัสสโตร์", "รหัสวัตถุดิบ", "รหัส"],
    "name": ["name", "description", "item", "ชื่อสินค้า", "รายการ", "ชื่อ"],
    "material": ["material", "วัสดุ"],
    "spec": ["spec", "size", "thickness", "ขนาด/ความหนา", "ขนาด", "ความหนา"],
    "unit": ["unit", "uom", "หน่วย", "หน่วยนับ"],
    "on_hand": ["on hand", "balance", "stock", "qty", "คงเหลือ", "ยอดคงเหลือ", "จำนวนคงเหลือ"],
    "min_qty": ["min", "minimum", "จุดสั่งซื้อ", "ขั้นต่ำ"],
    "max_qty": ["max", "maximum", "สูงสุด"],
    "location": ["location", "warehouse", "store", "คลัง", "ที่เก็บ"],
}
_STOCK_LOOKUP = {normalize(a): k for k, names in STOCK_ALIASES.items() for a in names + [STOCK_LABELS[k], k]}

WEIGHT_UNITS = {"กก.", "กก", "kg", "kgs", "กิโลกรัม"}

ST_OK = "พอ"
ST_LOW = "ต่ำกว่า Min"
ST_SHORT = "ขาด"
ST_MISSING = "ไม่พบในสต็อก"
ST_NO_WEIGHT = "ไม่มีน้ำหนัก"


@dataclass
class StockItem:
    code: str = ""
    name: str = ""
    material: str = ""
    spec: str = ""
    unit: str = ""
    on_hand: float = 0
    min_qty: float = 0
    max_qty: float = 0
    location: str = ""

    def get(self, key: str):
        return getattr(self, key)

    def set(self, key: str, value) -> None:
        if key in STOCK_NUMERIC:
            value = to_number(value)
        else:
            value = "" if value is None else str(value).strip()
        setattr(self, key, value)

    @property
    def by_weight(self) -> bool:
        return self.unit.strip().lower() in WEIGHT_UNITS


@dataclass
class StockList:
    items: list[StockItem] = field(default_factory=list)
    source: str = ""

    def to_dict(self) -> dict:
        return {"source": self.source, "items": [asdict(i) for i in self.items]}

    @classmethod
    def from_dict(cls, data: dict) -> StockList:
        items = []
        for raw in data.get("items", []):
            item = StockItem()
            for key in STOCK_KEYS:
                if key in raw:
                    item.set(key, raw[key])
            items.append(item)
        return cls(items=items, source=data.get("source", ""))

    @classmethod
    def from_rows(cls, rows: list[list], source: str = "") -> StockList:
        if not rows:
            return cls(source=source)
        h = _find_stock_header(rows)
        mapping = {}
        for idx, header in enumerate(rows[h]):
            key = _STOCK_LOOKUP.get(normalize(header))
            if key and key not in mapping.values():
                mapping[idx] = key
        items = []
        for row in rows[h + 1:]:
            item = StockItem()
            for idx, key in mapping.items():
                if idx < len(row):
                    item.set(key, row[idx])
            if item.code or item.name:
                items.append(item)
        return cls(items=items, source=source)

    @classmethod
    def from_file(cls, path: str | Path) -> StockList:
        return cls.from_rows(read_table(path), source=str(path))

    def to_rows(self) -> list[list]:
        return [[STOCK_LABELS[k] for k in STOCK_KEYS]] + [[i.get(k) for k in STOCK_KEYS] for i in self.items]


def _find_stock_header(rows: list[list]) -> int:
    best, best_score = find_header_row(rows), 0
    for i, row in enumerate(rows[:20]):
        score = len({_STOCK_LOOKUP.get(normalize(c)) for c in row} - {None})
        if score > best_score:
            best, best_score = i, score
    return best


# --------------------------------------------------------------------------
# Matching parts to stock
# --------------------------------------------------------------------------
def _key(text: str) -> str:
    return re.sub(r"[\s\-_/]+", "", (text or "").upper())


def _spec_key(text: str) -> str:
    """'t3.2', '3.2 mm', 'THK 3.2' -> '3.2'; other specs compared without spaces."""
    from .dwg_io import parse_thickness

    thk = parse_thickness(text)
    return f"{thk:g}" if thk else _key(text).replace("MM", "")


def find_stock_item(part: Part, stock: StockList) -> StockItem | None:
    by_code = {_key(i.code): i for i in stock.items if i.code}
    for code in (part.stock_code, part.part_no):
        if code and _key(code) in by_code:
            return by_code[_key(code)]
    if part.material:
        mat, spec = _key(part.material), _spec_key(part.spec.split(" x ")[0] if part.spec else "")
        for item in stock.items:
            if _key(item.material) == mat and spec and _spec_key(item.spec) == spec:
                return item
    return None


@dataclass
class RequirementLine:
    code: str
    name: str
    unit: str
    required: float
    on_hand: float
    min_qty: float = 0
    max_qty: float = 0
    location: str = ""
    status: str = ST_OK
    parts: list[str] = field(default_factory=list)
    no_weight: list[str] = field(default_factory=list)  # parts counted by kg but without weight

    @property
    def note(self) -> str:
        return f"{ST_NO_WEIGHT}: {', '.join(self.no_weight)}" if self.no_weight else ""

    @property
    def balance(self) -> float:
        return self.on_hand - self.required

    @property
    def suggest_order(self) -> float:
        if self.status == ST_MISSING:
            return math.ceil(self.required)
        if self.balance >= self.min_qty and self.balance >= 0:
            return 0
        target = self.max_qty if self.max_qty > self.min_qty else self.min_qty
        return math.ceil(max(target - self.balance, -self.balance))


REQUIREMENT_HEADERS = ["รหัสสินค้า", "รายการ", "หน่วย", "ต้องใช้", "คงเหลือ", "คงเหลือหลังเบิก", "Min", "Max",
                       "สถานะ", "แนะนำสั่งซื้อ", "คลัง", "หมายเหตุ", "ชิ้นส่วนที่ใช้"]


def requirement_row(line: RequirementLine) -> list:
    return [line.code, line.name, line.unit, _r(line.required), _r(line.on_hand), _r(line.balance),
            _r(line.min_qty), _r(line.max_qty), line.status, _r(line.suggest_order), line.location,
            line.note, ", ".join(line.parts)]


def _r(value: float):
    value = round(value, 3)
    return int(value) if float(value).is_integer() else value


def check_requirements(partlist: PartList, stock: StockList, build_qty: int | None = None) -> list[RequirementLine]:
    """Total material needed for `build_qty` sets of the Part List versus stock on hand."""
    build = build_qty if build_qty is not None else max(1, partlist.info.build_qty)
    lines: dict[str, RequirementLine] = {}
    for part in partlist.parts:
        item = find_stock_item(part, stock)
        label = part.part_no or part.name
        if item is None:
            key = "?" + _key(f"{part.material}|{part.spec}|{part.name if not part.material else ''}")
            line = lines.setdefault(key, RequirementLine(
                code="", name=" ".join(x for x in (part.material, part.spec) if x) or part.name,
                unit=part.unit, required=0, on_hand=0, status=ST_MISSING))
            line.required += part.qty * build
            line.parts.append(label)
            continue
        line = lines.setdefault(item.code or item.name, RequirementLine(
            code=item.code, name=item.name, unit=item.unit, required=0, on_hand=item.on_hand,
            min_qty=item.min_qty, max_qty=item.max_qty, location=item.location))
        if item.by_weight:
            if part.weight <= 0:
                line.no_weight.append(label)
            line.required += part.weight * part.qty * build
        else:
            line.required += part.qty * build
        line.parts.append(label)
    for line in lines.values():
        if line.status == ST_MISSING:
            continue
        if line.balance < 0:
            line.status = ST_SHORT
        elif line.balance < line.min_qty:
            line.status = ST_LOW
        else:
            line.status = ST_OK
    order = {ST_SHORT: 0, ST_MISSING: 1, ST_LOW: 2, ST_OK: 3}
    return sorted(lines.values(), key=lambda line: (order[line.status], line.code))


def apply_status_to_parts(partlist: PartList, stock: StockList, lines: list[RequirementLine]) -> int:
    """Write the check result back to the Part List (status + stock code). Returns rows changed."""
    status_by_code = {line.code: line.status for line in lines if line.code}
    changed = 0
    for part in partlist.parts:
        item = find_stock_item(part, stock)
        if item is None:
            new_status = "รอตรวจ"
        else:
            if not part.stock_code and item.code:
                part.stock_code = item.code
            st = status_by_code.get(item.code, ST_OK)
            new_status = "ขาด" if st == ST_SHORT else "พร้อม"
            if st == ST_SHORT and part.process == "ซื้อสำเร็จ":
                new_status = "รอสั่งซื้อ"
        if part.status != new_status:
            part.status = new_status
            changed += 1
    return changed


def export_requirements(partlist: PartList, lines: list[RequirementLine], path: str | Path,
                        only_purchase: bool = False) -> None:
    info = partlist.info
    rows = [requirement_row(line) for line in lines if not only_purchase or line.suggest_order > 0]
    title = "ใบขอซื้อวัตถุดิบ / Parts (ร่าง)" if only_purchase else "ตรวจสอบวัตถุดิบเทียบสต็อก"
    title_rows = [
        [title],
        ["SO", info.so_no, "ลูกค้า", info.customer, "รุ่นรถ", info.vehicle_model],
        ["เลขที่แบบ", info.drawing_no, "จำนวนผลิต (คัน)", info.build_qty, "วันที่", info.created],
    ]
    write_table(path, REQUIREMENT_HEADERS, rows, title_rows=title_rows, sheet_title="Requirement")
