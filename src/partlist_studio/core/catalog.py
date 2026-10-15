"""Catalog of the store (หมวดหมู่สินค้า): item types, the assembly groups of the made parts waiting for
assembly (กลุ่มประกอบ), the six numbers of every part and how ready each job is for assembly.

Item types:   RM วัตถุดิบ · BUY ซื้อสำเร็จ · PART ชิ้นส่วนพร้อมประกอบ · SUB ชุดประกอบย่อย · FG สินค้าสำเร็จรูป ·
              CON วัสดุสิ้นเปลือง     (work in progress is not an item: it is a part code + the step it waits for)
Assembly groups (where the part goes on the truck bed): FL เฟรมล่าง · FU เฟรมบน · FRONT หน้าโปร/บังอาย/โรลบาร์ ·
              POST เสา · SIDE ฝาข้าง/คอก/ราว · TAIL ฝาท้าย · FLOOR พื้น · RAIL รางรถไฟ · FIX หู/ตัวยึด · ACC อุปกรณ์เสริม
              - from words of the name (the part type first, "พื้น" last: "พื้นเรียบ" is also the name of a bed model),
              then the group of the store's stock-count code 01-GGGG-NNNN; a group set by hand wins over both.
What the store sets by hand (group, shelf location) is kept in a Catalog apart from the stock files, so a new
Express export does not lose it.
The six numbers of a part (สต็อก 6 ช่อง):
    พร้อมประกอบ  on hand                     ต้องใช้  open jobs, not issued yet
    ระหว่างผลิต   pieces waiting at each step  จะได้    pieces the open jobs still make (not received)
    จองให้งาน     min(on hand, ต้องใช้ − จะได้)  ใช้ได้   on hand − จอง      ขาด = what the jobs miss
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .stock import StockItem, StockList, _key, find_by_code

ITEM_TYPES: dict[str, str] = {
    "RM": "วัตถุดิบ",
    "BUY": "ชิ้นส่วนซื้อสำเร็จ",
    "PART": "ชิ้นส่วนพร้อมประกอบ",
    "SUB": "ชุดประกอบย่อย",
    "FG": "สินค้าสำเร็จรูป",
    "CON": "วัสดุสิ้นเปลือง",
}
MADE_TYPES = {"PART", "SUB"}

# (key, name, words) - the order matters: the first group with a word in the name wins.
# Where the part goes beats what it is ("หูล็อกฝาท้าย" → TAIL), a post is a post ("เสาปิดฝาท้าย" → POST,
# "เสาโรบาร์" → FRONT), a frame is a frame ("เฟรมล่าง … (มีรางรถไฟ)" → FL) and "พื้น" comes last.
# The ribs (กระดูกข้าง / กระดูกกลาง) are part of the upper frame, as in the store's count file (01-0004).
ASSEMBLY_GROUPS: list[tuple[str, str, list[str]]] = [
    ("ACC", "อุปกรณ์เสริม", ["กล่องเครื่องมือ", "กรอบป้าย", "กันระเบิด"]),
    ("FRONT", "หน้าโปร / บังอาย / โรลบาร์", ["หน้าโปร", "บังอาย", "โรบาร์", "โรลบาร์"]),
    ("POST", "เสา / ซองเสา", ["เสา"]),
    ("TAIL", "ฝาท้าย", ["ฝาท้าย", "ปิดท้าย", "ปากนกแก้ว", "บานสวิง", "ไฟท้าย"]),
    ("FL", "เฟรมล่าง", ["เฟรมล่าง", "คัดซี"]),
    ("FU", "เฟรมบน", ["เฟรมบน", "หน้าเฟรม", "กระดูกกลาง", "กระดูกข้าง"]),
    ("RAIL", "รางรถไฟ", ["รางรถไฟ"]),
    ("SIDE", "ฝาข้าง / คอก / ราว", ["ฝาข้าง", "ราว", "คอก"]),
    ("FIX", "หู / ตัวยึด / ล็อก", ["หู", "ฉากยึด", "บานพับ", "สลัก", "บู๊ช", "บูช", "เพลา", "ตัวดึง", "ล็อก", "ตะขอ"]),
    ("FLOOR", "พื้น", ["พื้น", "เต้า"]),
]
GROUP_NAMES = {key: name for key, name, _w in ASSEMBLY_GROUPS}
GROUP_ORDER = ["FL", "FU", "FRONT", "POST", "SIDE", "TAIL", "FLOOR", "RAIL", "FIX", "ACC"]
NO_GROUP = ""
NO_GROUP_NAME = "ยังไม่จัดกลุ่ม"
# groups of the store's stock-count file (รหัส 01-GGGG-NNNN); 0011 พื้นเรียบ is a bed model, decided by name
STORE_GROUPS = {"0001": "FRONT", "0002": "ACC", "0003": "POST", "0004": "FU", "0005": "FL", "0006": "TAIL",
                "0007": "SIDE", "0008": "FLOOR", "0009": "FIX", "0010": "FRONT"}

_RAW_RE = re.compile(r"^\d{2}-[A-Z]")  # 01-B00 เหล็กแผ่น, 04-B00 ท่อ, 03-S00 สแตนเลส, 01-FB0 แฟลตบาร์ …
_STORE_RE = re.compile(r"^\d{2}-(\d{4})-\d+")  # 01-0003-0005 (stock-count code of a made part)
_CON_WORDS = ["ลวดเชื่อม", "แก๊ส", "ก๊าซ", "ออกซิเจน", "ใบตัด", "ใบเจียร", "ทินเนอร์", "สีพ่น", "สีรองพื้น", "กระดาษทราย",
              "หัวตัด", "นอซเซิล", "เลนส์"]
_BUY_WORDS = ["น็อต", "น๊อต", "สกรู", "แหวน", "สปริง", "ยาง", "ไฟท้าย", "ไฟหรี่", "สติกเกอร์", "รีเวท", "กุญแจ", "โช๊ค"]
BRANDS = {"RRS-T": "Toyota", "RRS-M": "Mitsubishi", "RRS-M1": "Mitsubishi", "RRS-I": "Isuzu", "RRS-N": "Nissan",
          "RRS-S": "Suzuki", "RRS-A": "ใช้ทุกรุ่น", "RRS-A1": "ใช้ทุกรุ่น", "RRA-A": "ใช้ทุกรุ่น"}


def item_type(code: str, name: str = "", unit: str = "") -> str:
    code_u = (code or "").upper().replace(" ", "")
    text = name or ""
    if code_u.startswith("FG"):
        return "FG"
    if code_u.startswith(("RRS", "RRA")) or _STORE_RE.match(code_u):
        return "SUB" if (unit or "").strip() == "ชุด" else "PART"
    if any(w in text for w in _CON_WORDS):
        return "CON"
    if _RAW_RE.match(code_u):
        return "RM"
    if any(w in text for w in _BUY_WORDS):
        return "BUY"
    return ""


def group_by_name(name: str) -> str:
    text = name or ""
    return next((key for key, _n, words in ASSEMBLY_GROUPS if any(w in text for w in words)), NO_GROUP)


def assembly_group(code: str, name: str = "", overrides: dict[str, str] | None = None) -> str:
    """The group set by hand, else from the name, else from the store's stock-count code."""
    if overrides and _key(code) in overrides:
        return overrides[_key(code)]
    group = group_by_name(name)
    if group:
        return group
    m = _STORE_RE.match((code or "").upper().replace(" ", ""))
    return STORE_GROUPS.get(m.group(1), NO_GROUP) if m else NO_GROUP


def group_name(key: str) -> str:
    return GROUP_NAMES.get(key, NO_GROUP_NAME if not key else key)


def brand_of(code: str) -> str:
    parts = (code or "").upper().replace(" ", "").split("-")
    return BRANDS.get("-".join(parts[:2]), "")


def side_of(code: str, name: str = "") -> str:
    text, cu = name or "", (code or "").upper()
    if "(ซ้าย)" in text or "ซ้าย" in text or re.search(r"-L(-|$)", cu):
        return "ซ้าย"
    if "(ขวา)" in text or "ขวา" in text or re.search(r"-R(-|$)", cu):
        return "ขวา"
    return ""


@dataclass
class Catalog:
    """Set by hand per code: the assembly group (over the rules) and the shelf location (ตำแหน่งเก็บ)."""

    groups: dict[str, str] = field(default_factory=dict)  # _key(code) -> group key
    locations: dict[str, str] = field(default_factory=dict)  # _key(code) -> 'P-POST-04'

    def group_of(self, code: str, name: str = "") -> str:
        return assembly_group(code, name, self.groups)

    def location_of(self, code: str, item: StockItem | None = None) -> str:
        return self.locations.get(_key(code)) or ((item.location or item.shelf) if item else "")

    def set_group(self, code: str, group: str | None) -> None:
        """None: back to the rules."""
        if group is None:
            self.groups.pop(_key(code), None)
        else:
            self.groups[_key(code)] = group

    def set_location(self, code: str, location: str) -> None:
        location = (location or "").strip()
        if location:
            self.locations[_key(code)] = location
        else:
            self.locations.pop(_key(code), None)

    def to_dict(self) -> dict:
        return {"groups": dict(self.groups), "locations": dict(self.locations)}

    @classmethod
    def from_dict(cls, data: dict | None) -> Catalog:
        data = data or {}
        return cls({str(k): str(v) for k, v in (data.get("groups") or {}).items() if v in GROUP_NAMES or v == NO_GROUP},
                   {str(k): str(v) for k, v in (data.get("locations") or {}).items() if v})


def code_finder(stock: StockList | None):
    """find(code) -> StockItem | None, with an index (find_by_code reads the whole list for every code)."""
    if stock is None:
        return lambda code: None
    index: dict[str, StockItem] = {}
    for item in stock.items:
        if item.code:
            index.setdefault(_key(item.code), item)
    memo: dict[str, StockItem | None] = {}

    def find(code: str) -> StockItem | None:
        if not code:
            return None
        key = _key(code)
        if key not in memo:
            memo[key] = index.get(key) or find_by_code(code, stock)
        return memo[key]

    return find


# --------------------------------------------------------------------------
# The six numbers of every part
# --------------------------------------------------------------------------
@dataclass
class PartStock:
    code: str
    name: str
    unit: str = ""
    group: str = NO_GROUP
    location: str = ""
    on_hand: float = 0
    need: float = 0  # open jobs, not issued yet
    incoming: float = 0  # still being made for the open jobs (not received)
    wip: dict = field(default_factory=dict)  # step -> pieces waiting for it
    jobs: list = field(default_factory=list)
    min_qty: float = 0
    max_qty: float = 0
    item: StockItem | None = None  # the stock item (None: only in a job)

    @property
    def reserved(self) -> float:
        return min(self.on_hand, max(0.0, self.need - self.incoming))

    @property
    def free(self) -> float:
        return max(0.0, self.on_hand - self.reserved)

    @property
    def short(self) -> float:
        return max(0.0, self.need - self.incoming - self.on_hand)

    @property
    def wip_text(self) -> str:
        return " · ".join(f"รอ{step} {q:g}" for step, q in self.wip.items() if q > 0)

    @property
    def status(self) -> str:
        if self.short > 0:
            return "ขาด"
        if self.min_qty and self.free < self.min_qty:
            return "ต่ำกว่า Min"
        if self.wip_text:
            return "ระหว่างผลิต"
        return "พอ" if self.on_hand or self.need else "-"

    @property
    def brand(self) -> str:
        return brand_of(self.code)


def part_stock(stock: StockList, jobs, catalog: Catalog | None = None) -> list[PartStock]:
    """Made parts (PART / SUB) of the stock + the parts of the open jobs, with the six numbers."""
    from .production import CLOSED, STEPS

    catalog = catalog or Catalog()
    find = code_finder(stock)
    out: dict[str, PartStock] = {}
    for item in stock.items:
        if not item.code or item_type(item.code, item.name, item.unit_name) not in MADE_TYPES:
            continue
        key = _key(item.code)
        if key in out:
            continue
        out[key] = PartStock(item.code, item.name, item.unit_name, catalog.group_of(item.code, item.name),
                             catalog.location_of(item.code, item), item.on_hand, min_qty=item.min_qty,
                             max_qty=item.max_qty, item=item)
    for job in jobs:
        if job.status in CLOSED:
            continue
        for p in job.parts:
            if not p.code:
                continue
            item = find(p.code)
            key = _key(item.code if item else p.code)
            row = out.get(key)
            if row is None:
                code = item.code if item else p.code
                row = out[key] = PartStock(code, p.name, p.unit, catalog.group_of(code, p.name),
                                           catalog.location_of(code, item), item.on_hand if item else 0, item=item)
            row.need += max(0.0, p.required - p.issued)
            row.incoming += max(0.0, p.to_make - p.received)
            for step, q in p.waiting().items():
                row.wip[step] = row.wip.get(step, 0) + q
            if job.job_no not in row.jobs:
                row.jobs.append(job.job_no)
    for row in out.values():
        row.wip = dict(sorted(row.wip.items(), key=lambda kv: STEPS.index(kv[0]) if kv[0] in STEPS else 99))
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    return sorted(out.values(), key=lambda r: (order.get(r.group, 99), r.code))


PART_STOCK_HEADERS = ["กลุ่มประกอบ", "รหัส", "ชิ้นส่วน", "หน่วย", "ตำแหน่ง", "พร้อมประกอบ", "จองให้งาน", "ใช้ได้",
                      "ระหว่างผลิต", "จะได้", "ต้องใช้ (งานเปิด)", "ขาด", "Min", "Max", "สถานะ", "งาน / SO"]


def part_stock_rows(rows: list[PartStock]) -> list[list]:
    return [[group_name(r.group), r.code, r.name, r.unit, r.location, _n(r.on_hand), _n(r.reserved), _n(r.free),
             r.wip_text, _n(r.incoming), _n(r.need), _n(r.short), _n(r.min_qty), _n(r.max_qty), r.status,
             ", ".join(r.jobs)] for r in rows]


def _n(v: float):
    v = round(float(v or 0), 3)
    return int(v) if v.is_integer() else v


def export_part_stock(rows: list[PartStock], path) -> None:
    from .tabular import Sheet, write_workbook

    sheets = [Sheet("ชิ้นส่วนรอประกอบ", PART_STOCK_HEADERS, part_stock_rows(rows),
                    title_rows=[["ชิ้นส่วนพร้อมประกอบ แยกกลุ่มประกอบ (สต็อก 6 ช่อง)"],
                                ["ใช้ได้ = พร้อมประกอบ − จองให้งาน · ขาด = ต้องใช้ − จะได้ − พร้อมประกอบ"]])]
    summary = defaultdict(lambda: [0, 0.0, 0.0, 0])
    for r in rows:
        s = summary[r.group]
        s[0] += 1
        s[1] += r.on_hand
        s[2] += r.need
        s[3] += r.short > 0
    sheets.append(Sheet("สรุปตามกลุ่ม", ["กลุ่มประกอบ", "รหัส", "พร้อมประกอบ (ชิ้น)", "ต้องใช้ (ชิ้น)", "รหัสที่ขาด"],
                        [[group_name(g), *[_n(x) for x in v]] for g, v in summary.items()]))
    write_workbook(path, sheets)


# --------------------------------------------------------------------------
# Readiness of a job for assembly (ความพร้อมประกอบ) and the picking list (ใบจัดชุด)
# --------------------------------------------------------------------------
@dataclass
class ReadyLine:
    code: str
    name: str
    required: float
    ready: float
    where: str  # 'รอพับ 2 · รอตัด 1' / 'ใช้จากสต็อก' / 'รอรับเข้า'
    location: str = ""
    index: int = -1  # in job.parts

    @property
    def missing(self) -> float:
        return max(0.0, self.required - self.ready)


@dataclass
class GroupReadiness:
    group: str
    lines: list[ReadyLine] = field(default_factory=list)

    @property
    def name(self) -> str:
        return group_name(self.group)

    @property
    def required(self) -> float:
        return sum(x.required for x in self.lines)

    @property
    def ready(self) -> float:
        return sum(min(x.ready, x.required) for x in self.lines)

    @property
    def pct(self) -> float:
        return self.ready / self.required if self.required else 1.0

    @property
    def complete(self) -> bool:
        return all(x.missing <= 0 for x in self.lines)

    def missing_text(self) -> str:
        return " · ".join(f"{x.name or x.code} ×{x.missing:g} ({x.where})" for x in self.lines if x.missing > 0)


def job_readiness(job, catalog: Catalog | None = None, stock: StockList | None = None) -> list[GroupReadiness]:
    """Per assembly group: pieces ready for this job (from stock + made through every step) and what is missing."""
    catalog = catalog or Catalog()
    find = code_finder(stock)
    groups: dict[str, GroupReadiness] = {}
    for i, p in enumerate(job.parts):
        ready = min(p.required, p.from_stock + p.finished) if p.to_make > 0 else p.required
        where = p.status_text if p.to_make > 0 else "ใช้จากสต็อก"
        if p.to_make > 0 and p.finished >= p.to_make:
            where = "เสร็จ" if p.received >= p.to_make else "เสร็จ รอรับเข้า"
        item = find(p.code)
        g = catalog.group_of(item.code if item else p.code, p.name)
        groups.setdefault(g, GroupReadiness(g)).lines.append(
            ReadyLine(p.code, p.name, p.required, ready, where, catalog.location_of(p.code, item), i))
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    return sorted(groups.values(), key=lambda r: order.get(r.group, 99))


def job_ready_pct(groups: list[GroupReadiness]) -> float:
    need = sum(g.required for g in groups)
    return sum(g.ready for g in groups) / need if need else 1.0


READINESS_HEADERS = ["กลุ่มประกอบ", "ต้องใช้", "พร้อม", "พร้อม %", "สถานะ", "ที่ยังขาด (อยู่ขั้นไหน)"]


def readiness_rows(groups: list[GroupReadiness]) -> list[list]:
    return [[g.name, _n(g.required), _n(g.ready), f"{g.pct:.0%}", "พร้อม" if g.complete else "ขาด", g.missing_text()]
            for g in groups]


KIT_HEADERS = ["กลุ่มประกอบ", "รหัส", "ชิ้นส่วน", "ต้องใช้", "พร้อม", "ขาด", "ตำแหน่งเก็บ", "อยู่ที่ / สถานะ", "หยิบแล้ว"]


def kitting_rows(groups: list[GroupReadiness]) -> list[list]:
    rows = []
    for g in groups:
        for x in g.lines:
            rows.append([g.name, x.code, x.name, _n(x.required), _n(min(x.ready, x.required)), _n(x.missing),
                         x.location, x.where, "☐"])
    return rows


def export_kitting(job, groups: list[GroupReadiness], path) -> None:
    """ใบจัดชุด: what the store picks for one job, by assembly group, with the shelf location."""
    from .tabular import Sheet, write_workbook

    head = [[f"ใบจัดชุดชิ้นส่วนเข้าประกอบ – {job.job_no}"],
            [f"{job.title or job.model} · {job.sets:g} คัน" + (f" · ลูกค้า {job.customer}" if job.customer else "")
             + (f" · กำหนดส่ง {job.due}" if job.due else "")],
            ["กลุ่มที่พร้อม 100% จัดชุดได้ทันที · แถวที่ขาดให้ตรวจสถานะการผลิต"]]
    write_workbook(path, [Sheet("ใบจัดชุด", KIT_HEADERS, kitting_rows(groups), title_rows=head),
                          Sheet("สรุปความพร้อม", READINESS_HEADERS, readiness_rows(groups))])


# --------------------------------------------------------------------------
# Job tickets (ใบงาน) and shelf labels (ป้ายชั้นวาง) - what is printed; the PDF is drawn by the UI (Qt)
# --------------------------------------------------------------------------
@dataclass
class Ticket:
    no: str  # 'SO6910-015/03'
    payload: str  # text of the QR
    job_no: str
    job_text: str  # 'คอกสูง 3 ราว · Toyota Champ · 3 คัน · ลูกค้า …'
    code: str
    name: str
    qty: float
    unit: str = "ชิ้น"
    material: str = ""  # 'SS400 t3'
    program: str = ""  # laser programs with this part: 'LC6910-0003 ตัดแล้ว'
    route: list = field(default_factory=list)  # [(step, done, need)]
    to: str = ""  # where it goes when finished
    due: str = ""  # dd/mm/yyyy (พ.ศ.)
    image: str = ""  # picture of the part (Parts List All Model)
    outline: list = field(default_factory=list)  # flat pattern loops (mm) when there is no picture
    remark: str = ""


def _thai_date(iso: str) -> str:
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
    except ValueError:
        return iso
    return f"{d:02d}/{m:02d}/{y + 543}"


def job_tickets(job, indexes: list[int] | None = None, catalog: Catalog | None = None, stock: StockList | None = None,
                flats=None, programs=None, xref_lookup=None) -> list[Ticket]:
    """One ticket per part of the job (default: the parts the job makes), with the QR, the route and where it goes."""
    from .laser import job_key
    from .qr import ticket_payload

    catalog = catalog or Catalog()
    find = code_finder(stock)
    if indexes is None:
        indexes = [i for i, p in enumerate(job.parts) if p.to_make > 0]
    head = [job.title or job.model, job.vehicle, f"{job.sets:g} คัน", f"ลูกค้า {job.customer}" if job.customer else ""]
    job_text = " · ".join(x for x in dict.fromkeys(head) if x)
    out = []
    for i in indexes:
        if not 0 <= i < len(job.parts):
            continue
        p = job.parts[i]
        item = find(p.code)
        flat = flats.get(p.code, xref_lookup) if (flats is not None and p.code) else None
        material = ""
        if flat is not None:
            material = " ".join(x for x in (flat.material, f"t{flat.thickness:g}" if flat.thickness else "") if x)
        key = job_key(job.job_no, i)
        progs = [f"{prog.no} {prog.status}" for prog in (programs or []) if key in prog.items]
        group = catalog.group_of(item.code if item else p.code, p.name)
        location = catalog.location_of(p.code, item)
        to = " · ".join(x for x in (f"เก็บที่ {location}" if location else "", f"กลุ่ม{group_name(group)}") if x)
        image = p.image if p.image and Path(p.image).is_file() else ""
        out.append(Ticket(
            no=f"{job.job_no}/{i + 1:02d}", payload=ticket_payload(job.job_no, i + 1, p.code, p.to_make),
            job_no=job.job_no, job_text=job_text, code=p.code, name=p.name, qty=p.to_make, unit=p.unit or "ชิ้น",
            material=material, program=", ".join(progs),
            route=[(s, min(p.done_at(s), p.to_make), p.to_make) for s in p.route], to=to,
            due=_thai_date(job.due) if job.due else "", image=image,
            outline=[] if image or flat is None else flat.outline, remark=_ticket_remark(p.remark)))
    return out


_AUTO_REMARK = ("พื้นที่สุทธิ", "ระยะตัด", "รู ")  # written by the drawing import: not for the shop floor


def _ticket_remark(text: str) -> str:
    return " · ".join(x for x in (s.strip() for s in (text or "").split("·")) if x and not x.startswith(_AUTO_REMARK))


@dataclass
class ShelfLabel:
    code: str
    name: str
    location: str
    group: str  # name of the assembly group
    brand: str
    side: str
    payload: str


def shelf_labels(rows: list[PartStock]) -> list[ShelfLabel]:
    from .qr import item_payload

    return [ShelfLabel(r.code, r.name, r.location, group_name(r.group), r.brand, side_of(r.code, r.name),
                       item_payload(r.code, r.location)) for r in rows]
