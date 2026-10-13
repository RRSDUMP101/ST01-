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

# Column order and names follow the Express item screen (4.สินค้า → รายละเอียดสินค้า) so the
# same headers are used in this program, in files from/for Express and in the Google Sheet.
STOCK_COLUMNS: list[tuple[str, str]] = [
    ("code", "รหัสสินค้า"),
    ("name", "ชื่อสินค้า"),
    ("category", "หมวด"),
    ("account_group", "กลุ่มบัญชี"),
    ("material", "วัสดุ"),
    ("spec", "ขนาด/ความหนา"),
    ("unit", "หน่วย"),
    ("on_hand", "ยอดคงเหลือ"),
    ("unit_cost", "ราคาต่อหน่วย"),
    ("min_qty", "Min"),
    ("max_qty", "Max"),
    ("location", "คลัง"),
    ("shelf", "ชั้นเก็บ"),
    ("remark", "หมายเหตุ"),
]
STOCK_KEYS = [k for k, _ in STOCK_COLUMNS]
STOCK_LABELS = dict(STOCK_COLUMNS)
STOCK_NUMERIC = {"on_hand", "unit_cost", "min_qty", "max_qty"}

STOCK_ALIASES: dict[str, list[str]] = {
    "code": ["code", "item code", "stock code", "sku", "รหัสสินค้า", "รหัสสโตร์", "รหัสวัตถุดิบ", "รหัส"],
    "name": ["name", "description", "item", "ชื่อสินค้า", "ชื่อสินค้า/รายละเอียด", "รายละเอียด", "ชื่อไทย",
             "รายการ", "ชื่อ"],
    "category": ["หมวด", "หมวดสินค้า", "กลุ่มสินค้า", "category"],
    "account_group": ["กลุ่มบัญชี", "กลุ่มบ/ช", "กลุ่มบัญชีส/ค", "กลุ่มบช", "account group"],
    "material": ["material", "วัสดุ"],
    "spec": ["spec", "size", "thickness", "ขนาด/ความหนา", "ขนาด", "ความหนา"],
    "unit": ["unit", "uom", "หน่วย", "หน่วยนับ", "หน่วยย่อย"],
    "on_hand": ["on hand", "balance", "stock", "qty", "คงเหลือ", "ยอดคงเหลือ", "จำนวนคงเหลือ", "จำนวน"],
    "unit_cost": ["ราคาต่อหน่วย", "ทุนต่อหน่วย", "ราคาทุน", "unit cost", "cost"],
    "min_qty": ["min", "minimum", "จุดสั่งซื้อ", "ขั้นต่ำ", "reorder point"],
    "max_qty": ["max", "maximum", "สูงสุด"],
    "location": ["location", "warehouse", "store", "คลัง", "คลังสินค้า", "ที่เก็บ"],
    "shelf": ["ชั้นเก็บ", "shelf", "bin"],
    "remark": ["หมายเหตุ", "remark", "note", "สถานะ"],
}
# Unit words used in the company files (also used to find a unit column without a proper header).
KNOWN_UNITS = {"ชิ้น", "ชุด", "ต้น", "แผ่น", "เส้น", "ตัว", "กล่อง", "อัน", "คัน", "คู่", "กก.", "กก", "ม.", "เมตร",
               "ผน", "สน", "ชน", "kg", "pcs", "set"}
_STOCK_LOOKUP = {normalize(a): k for k, names in STOCK_ALIASES.items() for a in names + [STOCK_LABELS[k], k]}

WEIGHT_UNITS = {"กก.", "กก", "kg", "kgs", "กิโลกรัม"}
SHEET_UNITS = {"แผ่น", "ผน"}
# Unit codes seen in Express documents (PD: ผน = แผ่น, สน = เส้น; item screen: ชน = ชิ้น).
EXPRESS_UNIT_NAMES = {"ผน": "แผ่น", "สน": "เส้น", "ชน": "ชิ้น"}

# Material families, so "SS400" in a drawing matches "เหล็กแผ่นดำ 4มม." in Express.
MATERIAL_FAMILIES: list[tuple[str, list[str]]] = [
    ("SUS", ["SUS", "STAINLESS", "สแตนเลส", "สเตนเลส"]),
    ("AL", ["ALUMIN", "A50", "A60", "AL", "อลูมิเนียม", "อะลูมิเนียม"]),
    ("GALV", ["SGCC", "GALV", "GI", "กัลวาไนซ์", "เหล็กแผ่นขาว", "ซิงค์"]),
    ("STEEL", ["SS400", "SPHC", "SPCC", "DC01", "STEEL", "Q235", "ST37", "เหล็กแผ่นดำ", "แผ่นดำ", "เหล็กดำ"]),
]

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
    category: str = ""
    account_group: str = ""
    unit_cost: float = 0
    shelf: str = ""
    remark: str = ""
    code_truncated: bool = False  # Express text reports cut codes longer than 16 characters

    def get(self, key: str):
        return getattr(self, key)

    def set(self, key: str, value) -> None:
        if isinstance(value, str):
            value = re.sub(r"\s+", " ", value.replace("\xa0", " ")).strip()  # company files use NBSP
        if key in STOCK_NUMERIC:
            if key == "on_hand" and isinstance(value, str) and not self.unit:
                unit = re.sub(r"[\d.,\s-]+", "", value)  # "3 คัน", "68 อัน"
                if unit in KNOWN_UNITS:
                    self.unit = unit
            value = to_number(value)
        else:
            value = "" if value is None else str(value).strip()
        setattr(self, key, value)

    @property
    def by_weight(self) -> bool:
        return self.unit.strip().lower() in WEIGHT_UNITS

    @property
    def is_sheet(self) -> bool:
        return self.unit.strip() in SHEET_UNITS or "แผ่น" in self.name

    @property
    def unit_name(self) -> str:
        return EXPRESS_UNIT_NAMES.get(self.unit.strip(), self.unit)

    def infer_from_name(self) -> None:
        """Express has no material / thickness fields: take them from names like
        'เหล็กแผ่นดำ 4มม. 5x10ฟุต(เฟรมบนยาว)1524x3050'."""
        if not self.material:
            for _family, words in MATERIAL_FAMILIES:
                hit = next((w for w in words if not w.isascii() and w in self.name), None)
                if hit:
                    self.material = hit
                    break
        if not self.spec:
            match = re.search(r"(\d+(?:\.\d+)?)\s*(?:มม|มิล|mm)", self.name, re.IGNORECASE)
            if match:
                self.spec = f"t{match.group(1)}"


@dataclass
class StockList:
    items: list[StockItem] = field(default_factory=list)
    source: str = ""
    has_quantities: bool = True  # False for lists without balances (e.g. Express stock-count form)

    def to_dict(self) -> dict:
        return {"source": self.source, "has_quantities": self.has_quantities,
                "items": [asdict(i) for i in self.items]}

    @classmethod
    def from_dict(cls, data: dict) -> StockList:
        items = []
        for raw in data.get("items", []):
            item = StockItem()
            for key in STOCK_KEYS:
                if key in raw:
                    item.set(key, raw[key])
            item.code_truncated = bool(raw.get("code_truncated", False))
            items.append(item)
        return cls(items=items, source=data.get("source", ""), has_quantities=data.get("has_quantities", True))

    @classmethod
    def from_rows(cls, rows: list[list], source: str = "") -> StockList:
        if not rows:
            return cls(source=source)
        h = _find_stock_header(rows)
        mapping = {}
        for idx, header in enumerate(rows[h]):
            key = _STOCK_LOOKUP.get(normalize(header)) or _STOCK_LOOKUP.get(
                re.sub(r"\s*\(.*?\)\s*", "", normalize(header)))  # "Minimum (pcs.)", "ยอดคงเหลือ (pcs.)"
            if key and key not in mapping.values():
                mapping[idx] = key
        if "unit" not in mapping.values():
            # e.g. "Format Stock R1": the unit column is headed a second "ยอดคงเหลือ"
            width = max(len(r) for r in rows[h + 1:h + 60]) if rows[h + 1:] else 0
            for idx in range(width):
                if idx in mapping:
                    continue
                values = [str(r[idx]).replace("\xa0", " ").strip() for r in rows[h + 1:h + 60]
                          if idx < len(r) and str(r[idx]).strip()]
                if values and sum(v in KNOWN_UNITS for v in values) >= 0.7 * len(values):
                    mapping[idx] = "unit"
                    break
        items = []
        for row in rows[h + 1:]:
            item = StockItem()
            for idx, key in mapping.items():
                if idx < len(row):
                    item.set(key, row[idx])
            if item.code or item.name:
                item.infer_from_name()
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
    return re.sub(r"[\s\-_/()\xa0]+", "", (text or "").upper())


def _spec_key(text: str) -> str:
    """'t3.2', '3.2 mm', 'THK 3.2' -> '3.2'; other specs compared without spaces."""
    from .dwg_io import parse_thickness

    thk = parse_thickness(text)
    return f"{thk:g}" if thk else _key(text).replace("MM", "")


def material_family(text: str) -> str:
    upper = (text or "").upper().replace(" ", "")
    for family, words in MATERIAL_FAMILIES:
        if any(w.upper() in upper for w in words):
            return family
    return _key(text)


# Optional code cross-reference (Express code <-> stock-count code ...), set by the program.
XREF_LOOKUP = None  # callable(code) -> list[str] of equivalent codes


def find_by_code(code: str, stock: StockList, _follow: bool = True) -> StockItem | None:
    """Exact code, or the code cut to 16 characters as printed in Express text reports,
    or an equivalent code from the code cross-reference table."""
    if not code:
        return None
    item = _find_code(code, stock)
    if item is None and _follow and XREF_LOOKUP is not None:
        for other in XREF_LOOKUP(code):
            item = _find_code(other, stock)
            if item:
                break
    return item


def _find_code(code: str, stock: StockList) -> StockItem | None:
    key = _key(code)
    for item in stock.items:
        if item.code and _key(item.code) == key:
            return item
    for item in stock.items:
        if item.code_truncated and key.startswith(_key(item.code)):
            return item
    return None


def stock_candidates(part: Part, stock: StockList) -> list[StockItem]:
    """Stock items with the same material family and size/thickness as the part."""
    if not part.material:
        return []
    family = material_family(part.material)
    spec = _spec_key(part.spec.split(" x ")[0] if part.spec else "")
    if not spec:
        return []
    plate = bool(re.match(r"\s*(?:t|thk\.?|หนา)\s*=?\s*\d", part.spec, re.IGNORECASE))  # cut from a sheet
    return [item for item in stock.items
            if material_family(item.material or item.name) == family and _spec_key(item.spec) == spec
            and (item.is_sheet or item.by_weight or not plate or not item.unit)]


def find_stock_item(part: Part, stock: StockList) -> StockItem | None:
    for code in (part.stock_code, part.part_no):
        item = find_by_code(code, stock)
        if item:
            return item
    candidates = stock_candidates(part, stock)
    return candidates[0] if candidates else None


def sheet_size_mm(name: str) -> tuple[float, float] | None:
    """'1524x3050' -> (1524, 3050); '5x10ฟุต' -> (1524, 3048); '4x2530' -> (1219, 2530)."""
    match = re.search(r"(\d{3,4})\s*[xX×*]\s*(\d{3,4})", name or "")
    if not match:
        match = re.search(r"(?<![\d.])(\d{1,2}(?:\.\d+)?)\s*[xX×*]\s*(\d{1,4})", name or "")
    if not match:
        return None
    a, b = (float(v) for v in match.groups())
    a, b = (v * 304.8 if v < 30 else v for v in (a, b))  # small numbers are feet
    return a, b


def sheet_weight_kg(item: StockItem, densities: dict[str, float] | None = None) -> float:
    from .dwg_io import density_for, parse_thickness

    size = sheet_size_mm(item.name)
    thk = parse_thickness(item.spec)
    if not size or not thk:
        return 0
    return size[0] * size[1] * thk * density_for(item.material or "SS400", densities) * 1e-6


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
    unit_cost: float = 0
    notes: list[str] = field(default_factory=list)

    @property
    def note(self) -> str:
        bits = [f"{ST_NO_WEIGHT}: {', '.join(self.no_weight)}"] if self.no_weight else []
        return " · ".join(bits + self.notes)

    def add_note(self, text: str) -> None:
        if text not in self.notes:
            self.notes.append(text)

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


def explicit_piece(part: Part, item: StockItem) -> bool:
    """The part *is* the stock item (same code) rather than being cut from it."""
    return bool(part.part_no) and find_by_code(part.part_no, StockList(items=[item])) is item


def check_requirements(partlist: PartList, stock: StockList, build_qty: int | None = None,
                       densities: dict[str, float] | None = None) -> list[RequirementLine]:
    """Total material needed for `build_qty` sets of the Part List versus stock on hand."""
    build = build_qty if build_qty is not None else max(1, partlist.info.build_qty)
    lines: dict[str, RequirementLine] = {}
    for part in partlist.parts:
        item = find_stock_item(part, stock)
        label = part.part_no or part.name
        if item is None:
            key = "?" + _key(f"{part.material}|{part.spec}|{part.name if not part.material else ''}"
                             f"|{part.part_no if not part.material else ''}")
            line = lines.setdefault(key, RequirementLine(
                code="", name=" ".join(x for x in (part.material, part.spec) if x) or part.name,
                unit=part.unit, required=0, on_hand=0, status=ST_MISSING))
            if part.part_no and not part.material:
                line.add_note(f"ไม่พบรหัส {part.part_no} ในสต็อก – ตรวจตารางเทียบรหัส")
            line.required += part.qty * build
            line.parts.append(label)
            continue
        line = lines.setdefault(item.code or item.name, RequirementLine(
            code=item.code, name=item.name, unit=item.unit, required=0, on_hand=item.on_hand,
            min_qty=item.min_qty, max_qty=item.max_qty, location=item.location, unit_cost=item.unit_cost))
        explicit = bool(find_by_code(part.stock_code, stock) or find_by_code(part.part_no, stock))
        if not explicit and len(stock_candidates(part, stock)) > 1:
            line.add_note("มีหลายรหัสที่วัสดุ/ความหนาเดียวกัน – ใส่รหัสสโตร์ใน Part List เพื่อเลือกเอง")
        sheet_kg = sheet_weight_kg(item, densities) if item.is_sheet and not explicit_piece(part, item) else 0
        if item.by_weight:
            if part.weight <= 0:
                line.no_weight.append(label)
            line.required += part.weight * part.qty * build
        elif sheet_kg:
            # Part made from this sheet: kg of the part / kg of one sheet (offcuts not included).
            if part.weight <= 0:
                line.no_weight.append(label)
            line.required += part.weight * part.qty * build / sheet_kg
            line.add_note(f"คิดจากน้ำหนัก ÷ {sheet_kg:,.1f} kg/แผ่น (ยังไม่รวมเศษ)")
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
