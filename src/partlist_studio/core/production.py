"""Production jobs (งาน / SO) and the status of every part (ติดตามสถานะการผลิตรายชิ้น).

A job is a model BOM (with Express codes) × number of beds for one SO. For each part:
    required  = qty per bed × beds
    from_stock = taken from finished parts already in stock (if the job uses stock first)
    to_make   = required - from_stock, made through its route of work steps
The route defaults to ตัด → พับ → เชื่อม; the company files also use เหยียบปิด and โรงกลึง (กลึง), so those
are steps too. `done[step]` is how many pieces passed that step, so a part reads "รอพับ 5" when 5 pieces
are cut but not yet bent - the same words the store writes in the stock-count file.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path

from .models import Part
from .movements import DocLine, Ledger, StockDoc, lines_from_parts
from .stock import StockList, _key, find_by_code

STEPS = ["ตัด", "พับ", "เหยียบปิด", "เชื่อม", "กลึง", "ทำสี"]
DEFAULT_ROUTE = ["ตัด", "พับ", "เชื่อม"]
DONE = "เสร็จ"
FROM_STOCK = "ใช้จากสต็อก"
JOB_OPEN = "เปิดงาน"
JOB_RUNNING = "กำลังผลิต"
JOB_DONE = "ผลิตเสร็จ"
JOB_DELIVERED = "ส่งมอบแล้ว"
JOB_CANCELLED = "ยกเลิก"
JOB_STATUSES = [JOB_OPEN, JOB_RUNNING, JOB_DONE, JOB_DELIVERED, JOB_CANCELLED]
CLOSED = {JOB_DELIVERED, JOB_CANCELLED}

# Part.process (Part List) -> route
PROCESS_ROUTES = {
    "ตัด/พับ": ["ตัด", "พับ"],
    "เชื่อม": ["ตัด", "พับ", "เชื่อม"],
    "ยิงทราย/ทำสี": ["ตัด", "พับ", "เชื่อม", "ทำสี"],
    "พ่นสี": ["ทำสี"],
    "ประกอบ": ["เชื่อม"],
    "ซื้อสำเร็จ": [],
}


def route_for(part_name: str, process: str = "") -> list[str]:
    if process in PROCESS_ROUTES:
        return list(PROCESS_ROUTES[process])
    name = part_name or ""
    if any(w in name for w in ("บานพับ", "บู๊ช", "บูช", "เพลา", "สลัก")):
        return ["ตัด", "กลึง"]
    if any(w in name for w in ("เฟรม", "เสา", "หน้าโปร", "ฝาข้าง", "ฝาท้าย", "พื้น")):
        return ["ตัด", "พับ", "เชื่อม"]
    return list(DEFAULT_ROUTE)


@dataclass
class JobPart:
    item_no: str
    code: str
    name: str
    qty_per_set: float
    required: float
    from_stock: float = 0
    route: list[str] = field(default_factory=lambda: list(DEFAULT_ROUTE))
    done: dict[str, float] = field(default_factory=dict)
    received: float = 0  # finished pieces already received into stock (FR)
    unit: str = "ชิ้น"
    remark: str = ""
    image: str = ""
    issued: float = 0  # issued to assembly (PD/OU)
    drawing_code: str = ""  # code of the part in the DWG (code is the stock/Express code once matched)
    drawing_no: str = ""
    spec: str = ""  # size / spec from the Part List: 't3 x 150 x 60'
    material: str = ""
    thickness: float = 0

    @property
    def to_make(self) -> float:
        return max(0.0, self.required - self.from_stock)

    def done_at(self, step: str) -> float:
        return self.done.get(step, 0)

    @property
    def finished(self) -> float:
        """Pieces through the whole route."""
        if not self.route:
            return self.to_make if self.done.get(DONE) else 0
        return self.done_at(self.route[-1])

    def waiting(self) -> dict[str, float]:
        """Pieces waiting in front of each step ('รอพับ 5')."""
        out, before = {}, self.to_make
        for step in self.route:
            here = self.done_at(step)
            if before - here > 0:
                out[step] = before - here
            before = here
        return out

    @property
    def status(self) -> str:
        if self.to_make <= 0:
            return FROM_STOCK
        if self.finished >= self.to_make:
            return DONE
        waiting = self.waiting()
        if not self.route:
            return "รอรับเข้า"
        first = next(iter(waiting), "")
        return f"รอ{first}" if first else DONE

    @property
    def status_text(self) -> str:
        if self.status in (DONE, FROM_STOCK):
            return self.status
        return " · ".join(f"รอ{s} {q:g}" for s, q in self.waiting().items())

    @property
    def progress(self) -> float:
        """0..1: steps done over steps needed."""
        if self.to_make <= 0:
            return 1.0
        if not self.route:
            return 1.0 if self.done.get(DONE) else 0.0
        need = self.to_make * len(self.route)
        return min(1.0, sum(min(self.done_at(s), self.to_make) for s in self.route) / need)

    def record(self, step: str, qty: float) -> float:
        """Add finished pieces at a step; limited by what the step before has passed. Returns qty taken."""
        if step == DONE:  # all remaining steps
            taken = 0.0
            for s in self.route:
                taken = max(taken, self.record(s, self.to_make))
            if not self.route:
                self.done[DONE] = self.to_make
            return taken
        if step not in self.route:
            self.route.append(step)
            self.route.sort(key=lambda s: STEPS.index(s) if s in STEPS else 99)
        i = self.route.index(step)
        limit = self.to_make if i == 0 else self.done_at(self.route[i - 1])
        qty = max(0.0, min(qty, limit - self.done_at(step)))
        if qty:
            self.done[step] = self.done_at(step) + qty
        return qty


@dataclass
class LogEntry:
    when: str
    code: str
    name: str
    step: str
    qty: float
    note: str = ""


@dataclass
class Job:
    job_no: str  # SO number (or a job number)
    model: str = ""
    title: str = ""
    customer: str = ""
    vehicle: str = ""
    sets: float = 1
    due: str = ""
    created: str = field(default_factory=lambda: date.today().isoformat())
    status: str = JOB_OPEN
    variant: str = ""  # brand / height chosen
    body: str = ""  # รุ่นกระบะที่ผลิต: 'กระบะดั้มพ์คอกสูง 3 ราว'
    brand: str = ""  # letter of the vehicle brand in the part codes: T / I / M / F / N ('' = from the codes)
    parts: list[JobPart] = field(default_factory=list)
    log: list[LogEntry] = field(default_factory=list)
    docs: list[str] = field(default_factory=list)  # document numbers made for the job
    remark: str = ""

    @property
    def progress(self) -> float:
        make = [p for p in self.parts if p.to_make > 0]
        if not make:
            return 1.0 if self.parts else 0.0
        total = sum(p.to_make * max(1, len(p.route)) for p in make)
        return sum(p.progress * p.to_make * max(1, len(p.route)) for p in make) / total

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for p in self.parts:
            st = p.status
            out[st] = out.get(st, 0) + 1
        return out

    @property
    def overdue(self) -> bool:
        return bool(self.due) and self.status not in CLOSED | {JOB_DONE} and self.due < date.today().isoformat()

    def record(self, part: JobPart, step: str, qty: float, note: str = "") -> float:
        taken = part.record(step, qty)
        if taken:
            self.log.append(LogEntry(datetime.now().isoformat(timespec="minutes"), part.code, part.name, step,
                                     taken, note))
            if self.status == JOB_OPEN:
                self.status = JOB_RUNNING
            if all(p.status in (DONE, FROM_STOCK) for p in self.parts):
                self.status = JOB_DONE
        return taken

    def set_sets(self, sets: float, note: str = "") -> float:
        """Change the number of beds of an open job: every part needs qty per bed × beds again.
        Pieces already made stay recorded (fewer beds: the extra pieces count as made); pieces taken from stock
        stay reserved up to what is needed. Returns the old number of beds."""
        sets = max(1.0, float(sets))
        old = self.sets
        if sets == old:
            return old
        for p in self.parts:
            p.required = p.qty_per_set * sets
            p.from_stock = min(p.from_stock, p.required)
        self.sets = sets
        self.log.append(LogEntry(datetime.now().isoformat(timespec="minutes"), "", "", "จำนวนคัน", sets - old,
                                 note or f"เปลี่ยนจำนวนคัน {old:g} → {sets:g}"))
        if self.status == JOB_DONE and not all(p.status in (DONE, FROM_STOCK) for p in self.parts):
            self.status = JOB_RUNNING
        return old

    def unreceived(self) -> list[tuple[JobPart, float]]:
        """Finished pieces not yet received into stock."""
        return [(p, p.finished - p.received) for p in self.parts if p.finished - p.received > 0]

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> Job:
        parts = [JobPart(**{k: v for k, v in p.items() if k in JobPart.__dataclass_fields__})
                 for p in data.get("parts", [])]
        log = [LogEntry(**{k: v for k, v in e.items() if k in LogEntry.__dataclass_fields__})
               for e in data.get("log", [])]
        kw = {k: v for k, v in data.items() if k in cls.__dataclass_fields__ and k not in ("parts", "log")}
        return cls(parts=parts, log=log, **kw)


# --------------------------------------------------------------------------
# Making jobs
# --------------------------------------------------------------------------
def reserved_by_jobs(jobs: list[Job], exclude: Job | None = None) -> dict[str, float]:
    """Finished parts in stock promised to open jobs and not yet issued."""
    out: dict[str, float] = {}
    for job in jobs:
        if job is exclude or job.status in CLOSED:
            continue
        for p in job.parts:
            left = p.from_stock - min(p.issued, p.from_stock)
            if left > 0 and p.code:
                out[_key(p.code)] = out.get(_key(p.code), 0) + left
    return out


def job_from_parts(job_no: str, parts: list[Part], sets: float, stock: StockList | None = None,
                   use_stock: bool = True, other_jobs: list[Job] | None = None, **info) -> Job:
    """`parts` carry the quantity for ONE bed (qty) unless they come from a Part List already × beds."""
    job = Job(job_no=job_no, sets=sets, **info)
    reserved = reserved_by_jobs(other_jobs or [])
    for p in parts:
        code = p.stock_code or p.part_no
        old = re.search(r"รหัสเดิม\s+(\S+)", p.remark or "")  # a model row: the code of the sheet
        drawing = old.group(1) if old and p.part_no == p.stock_code else p.part_no
        jp = JobPart(item_no=p.item_no, code=code, name=p.name, qty_per_set=p.qty, required=p.qty * sets,
                     route=route_for(p.name, p.process), unit=p.unit or "ชิ้น", remark=p.remark, image=p.image,
                     drawing_code=drawing, drawing_no=p.drawing_no, spec=p.spec, material=p.material,
                     thickness=p.thickness)
        if use_stock and stock is not None and code:
            item = find_by_code(code, stock)
            if item is not None:
                free = max(0.0, item.on_hand - reserved.get(_key(code), 0))
                jp.from_stock = min(free, jp.required)
                reserved[_key(code)] = reserved.get(_key(code), 0) + jp.from_stock
        job.parts.append(jp)
    return job


# --------------------------------------------------------------------------
# Documents for a job
# --------------------------------------------------------------------------
@dataclass
class RawUse:
    """Raw material per finished part (วัตถุดิบต่อชิ้น): part code -> stock code × qty per piece."""
    part_code: str
    raw_code: str
    raw_name: str = ""
    qty: float = 0  # per piece, in the raw material's unit (แผ่น, เส้น, กก.)
    unit: str = ""
    source: str = ""  # how it was found


RAW_HEADERS = ["รหัสชิ้นส่วน", "ชื่อชิ้นส่วน", "รหัสวัตถุดิบ", "วัตถุดิบ", "ใช้ต่อชิ้น", "หน่วย", "ที่มา"]


def suggest_raw_uses(parts: list[JobPart] | list[Part], stock: StockList) -> list[RawUse]:
    """Default raw material of a part from the notes in the sheet names of Express:
    'เหล็กแผ่นดำ 2.5 มม.4x8ฟุต(ฝาข้าง+ฝาท้าย)' -> ฝาข้าง, ฝาท้าย are cut from it. qty stays 0 (unknown)."""
    sheets = []
    for item in stock.items:
        m = re.search(r"\(([^)]+)\)", item.name)
        if item.is_sheet and m and item.code and not item.code.upper().startswith(("RRS", "RRA")):
            words = [w.strip() for w in re.split(r"[+,/]|และ", m.group(1))
                     if len(w.strip()) >= 2 and w.strip() not in ("ซ้าย", "ขวา", "ใหม่", "เก่า")]
            sheets.append((item, words))
    out = []
    for p in parts:
        name, code = p.name, getattr(p, "code", "") or getattr(p, "part_no", "")
        hits = [(item, w) for item, ws in sheets for w in ws if w in name and not re.fullmatch(r"[\d.,\s]+", w)]
        if hits:
            item, word = max(hits, key=lambda t: len(t[1]))
            out.append(RawUse(code, item.code, item.name, 0, item.unit_name, f"ชื่อแผ่นใน Express ระบุ '{word}'"))
    return out


def job_documents(job: Job, stock: StockList, ledger: Ledger, raw_uses: list[RawUse] | None = None,
                  warehouse: str = "01") -> list[StockDoc]:
    """Draft documents for a job (not saved yet):
    PD วัตถุดิบ for the parts to make (from raw_uses with a quantity),
    PD ชิ้นส่วน: all parts of the beds to assembly, FR: finished pieces not yet received."""
    docs = []
    remark = " ".join(x for x in (job.model, job.variant, f"{job.sets:g} คัน") if x)
    uses = {}
    for u in raw_uses or []:
        if u.qty > 0:
            uses.setdefault(_key(u.part_code), []).append(u)
    raw: dict[str, DocLine] = {}
    for p in job.parts:
        for u in uses.get(_key(p.code), []):
            item = find_by_code(u.raw_code, stock)
            line = raw.setdefault(_key(u.raw_code), DocLine(u.raw_code, item.name if item else u.raw_name, 0,
                                                             (item.unit_name if item else u.unit), warehouse,
                                                             item.unit_cost if item else 0, ""))
            line.qty += u.qty * p.to_make
            line.remark = ", ".join(x for x in (line.remark, p.code) if x)[:120]
    if raw:
        for line in raw.values():
            line.qty = _ceil(line.qty)
        docs.append(StockDoc("PD", job=job.job_no, remark=f"วัตถุดิบ {remark}", lines=list(raw.values())))
    issue = [Part(item_no=p.item_no, part_no=p.code, name=p.name, qty=p.required - p.issued, unit=p.unit)
             for p in job.parts if p.required - p.issued > 0]
    if issue:
        docs.append(StockDoc("PD", job=job.job_no, remark=f"จ่ายชิ้นส่วนประกอบกระบะ {remark}",
                             lines=lines_from_parts(issue, stock, warehouse)))
    received = [Part(item_no=p.item_no, part_no=p.code, name=p.name, qty=q, unit=p.unit) for p, q in job.unreceived()]
    if received:
        docs.append(StockDoc("FR", job=job.job_no, remark=f"ชิ้นงานผลิตเสร็จ {remark}",
                             lines=lines_from_parts(received, stock, warehouse)))
    return docs


def mark_document(job: Job, doc: StockDoc) -> None:
    """After a job document is saved: remember what was issued / received."""
    qty = {}
    for line in doc.lines:
        qty[_key(line.code) or "#" + line.name] = qty.get(_key(line.code) or "#" + line.name, 0) + line.qty
    for p in job.parts:
        k = _key(p.code) or "#" + p.name
        if k not in qty:
            continue
        if doc.doc_type == "FR":
            take = min(qty[k], p.finished - p.received)
            p.received += take
            qty[k] -= take
        elif doc.doc_type in ("PD", "OU") and "ชิ้นส่วน" in doc.remark:
            take = min(qty[k], p.required - p.issued)
            p.issued += take
            qty[k] -= take
    if doc.doc_no not in job.docs:
        job.docs.append(doc.doc_no)


def _ceil(x: float) -> float:
    import math

    return math.ceil(round(x, 6))


# --------------------------------------------------------------------------
# Status words in the stock-count file
# --------------------------------------------------------------------------
_WIP_RE = re.compile(r"รอ\s*(ตัด|พับ|เหยียบปิด|เชื่อม|กลึง|ทำสี|พ่นสี)\s*(.*?)\s*(\d+(?:\.\d+)?)?\s*(ชิ้น|ต้น|ชุด|อัน)?\s*$")


def parse_wip_remark(remark: str) -> tuple[str, float | None, str] | None:
    """'รอพับ5ชิ้น' -> ('พับ', 5, ''), 'รอตัดฝาหน้า 20ชิ้น' -> ('ตัด', 20, 'ฝาหน้า'),
    'โรงกลึง' -> ('กลึง', None, 'ส่งโรงกลึง'), 'พร้อมใช้งาน' -> ('เสร็จ', None, '')."""
    text = (remark or "").replace("\xa0", " ").strip()
    if not text:
        return None
    if "พร้อมใช้" in text:
        return DONE, None, ""
    if "โรงกลึง" in text:
        return "กลึง", None, "ส่งโรงกลึง"
    m = _WIP_RE.search(text)
    if not m:
        return None
    step = "ทำสี" if m.group(1) == "พ่นสี" else m.group(1)
    qty = float(m.group(3)) if m.group(3) else None
    return step, qty, m.group(2).strip()


def wip_from_stock(stock: StockList) -> list[tuple[str, str, str, float | None, str]]:
    """(code, name, step, qty, note) for items whose remark is a production status."""
    out = []
    for item in stock.items:
        parsed = parse_wip_remark(item.remark)
        if parsed:
            out.append((item.code, item.name, *parsed))
    return out


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------
STATUS_HEADERS = ["งาน / SO", "แบบ", "ลูกค้า", "กำหนดส่ง", "ลำดับ", "รหัส", "ชิ้นส่วน", "ต่อคัน", "ต้องใช้",
                  "ใช้จากสต็อก", "ต้องผลิต", "ขั้นตอน", *STEPS, "สถานะ", "รับเข้าแล้ว", "% เสร็จ"]


def status_rows(jobs: list[Job]) -> list[list]:
    rows = []
    for job in jobs:
        for p in job.parts:
            rows.append([job.job_no, job.model, job.customer, job.due, p.item_no, p.code, p.name, p.qty_per_set,
                         p.required, p.from_stock, p.to_make, " → ".join(p.route),
                         *[p.done_at(s) if s in p.route else "" for s in STEPS], p.status_text, p.received,
                         round(p.progress * 100)])
    return rows


def export_status(jobs: list[Job], path: str | Path) -> None:
    from .tabular import write_table

    title = [["ติดตามสถานะการผลิตรายชิ้น"], ["วันที่", date.today().strftime("%d/%m/%Y"),
                                             "งาน", ", ".join(j.job_no for j in jobs)]]
    write_table(path, STATUS_HEADERS, status_rows(jobs), title_rows=title, sheet_title="Production")
