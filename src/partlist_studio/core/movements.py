"""Stock documents (ใบเบิก / ใบรับ) and the stock movement history (ประวัติการเคลื่อนไหว).

Document types follow Express (4.สินค้า):
    PD  จ่ายวัตถุดิบเพื่อผลิต       stock out (raw material to production, parts to assembly)
    OU  จ่ายสินค้าใช้ภายใน          stock out
    FR  รับสินค้าสำเร็จรูปจากการผลิต  stock in  (parts finished by production)
    RR  รับสินค้า (ซื้อ)             stock in  (purchase)
    AJ  ปรับปรุงยอด (ตรวจนับ)        + or - per line
Saving a document (บันทึก) changes the balance in this program at once and records one movement per line;
the same lines are exported as a draft to key into Express, which gives its own document number
(kept in `express_no`). A new stock count or Express balance imported later replaces the balance.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path

from .stock import RequirementLine, StockItem, StockList, ST_MISSING, _key, find_by_code

DOC_TYPES: dict[str, tuple[str, int]] = {
    "PD": ("จ่ายวัตถุดิบเพื่อผลิต", -1),
    "OU": ("จ่ายสินค้าใช้ภายใน", -1),
    "FR": ("รับสินค้าสำเร็จรูปจากการผลิต", 1),
    "RR": ("รับสินค้า (ซื้อ)", 1),
    "AJ": ("ปรับปรุงยอด (ตรวจนับ)", 0),
}
OUT_TYPES = {k for k, (_n, sign) in DOC_TYPES.items() if sign < 0}
ST_DRAFT = "ร่าง"
ST_POSTED = "บันทึกแล้ว"
ST_CANCELLED = "ยกเลิก"

DOC_HEADERS = ["No.", "รหัส", "รายละเอียด", "คลัง", "จำนวน", "หน่วย", "ราคาต่อหน่วย", "จำนวนเงิน", "หมายเหตุ"]
HISTORY_HEADERS = ["วันที่", "เอกสาร", "เลขที่", "เลขที่ Express", "งาน / SO", "รหัสสินค้า", "รายการ", "รับเข้า",
                   "จ่ายออก", "คงเหลือ", "หน่วย", "หมายเหตุ"]


def be_date(d: str) -> str:
    """'2026-10-13' -> '13/10/2569'."""
    try:
        x = date.fromisoformat(d[:10])
    except ValueError:
        return d
    return f"{x.day:02d}/{x.month:02d}/{x.year + 543}"


@dataclass
class DocLine:
    code: str
    name: str
    qty: float
    unit: str = ""
    warehouse: str = "01"
    unit_cost: float = 0
    remark: str = ""

    @property
    def amount(self) -> float:
        return round(self.qty * self.unit_cost, 2)


@dataclass
class StockDoc:
    doc_type: str
    doc_no: str = ""
    date: str = field(default_factory=lambda: date.today().isoformat())
    job: str = ""  # SO / job number
    department: str = ""
    remark: str = ""
    lines: list[DocLine] = field(default_factory=list)
    status: str = ST_DRAFT
    express_no: str = ""  # number Express gave when the document was keyed in
    posted_at: str = ""

    @property
    def type_name(self) -> str:
        return DOC_TYPES.get(self.doc_type, (self.doc_type, 0))[0]

    @property
    def sign(self) -> int:
        return DOC_TYPES.get(self.doc_type, ("", 0))[1]

    @property
    def total(self) -> float:
        return round(sum(line.amount for line in self.lines), 2)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> StockDoc:
        lines = [DocLine(**{k: v for k, v in raw.items() if k in DocLine.__dataclass_fields__})
                 for raw in data.get("lines", [])]
        kw = {k: v for k, v in data.items() if k in cls.__dataclass_fields__ and k != "lines"}
        return cls(lines=lines, **kw)


@dataclass
class Movement:
    when: str  # ISO date of the document
    doc_type: str
    doc_no: str
    code: str
    name: str
    qty: float  # + in, - out
    unit: str = ""
    job: str = ""
    balance: float = 0  # balance after this movement
    express_no: str = ""
    remark: str = ""


@dataclass
class Ledger:
    docs: list[StockDoc] = field(default_factory=list)
    movements: list[Movement] = field(default_factory=list)
    counters: dict[str, int] = field(default_factory=dict)

    # ---- numbering -------------------------------------------------------
    def next_no(self, doc_type: str, when: str | None = None) -> str:
        """PD6910-0001: type + Buddhist year (2 digits) + month + running number per month."""
        d = date.fromisoformat((when or date.today().isoformat())[:10])
        prefix = f"{doc_type}{(d.year + 543) % 100:02d}{d.month:02d}"
        n = self.counters.get(prefix, 0) + 1
        used = {x.doc_no for x in self.docs}
        while f"{prefix}-{n:04d}" in used:
            n += 1
        self.counters[prefix] = n
        return f"{prefix}-{n:04d}"

    def new_doc(self, doc_type: str, lines: list[DocLine] | None = None, **kw) -> StockDoc:
        doc = StockDoc(doc_type=doc_type, lines=lines or [], **kw)
        doc.doc_no = self.next_no(doc_type, doc.date)
        self.docs.append(doc)
        return doc

    def find(self, doc_no: str) -> StockDoc | None:
        return next((d for d in self.docs if d.doc_no == doc_no), None)

    # ---- posting -------------------------------------------------------------
    def post(self, doc: StockDoc, stock: StockList, new_items: StockList | None = None) -> list[str]:
        """Change the balances and record the movements. Items not in stock are added to `new_items`.
        Returns warnings (stock going below zero, unknown codes)."""
        if doc.status == ST_POSTED:
            return ["เอกสารนี้บันทึกแล้ว"]
        warnings = []
        for line in doc.lines:
            if not line.qty:
                continue
            qty = line.qty * doc.sign if doc.sign else line.qty
            item = find_by_code(line.code, stock) if line.code else _by_name(line.name, stock)
            if item is None:
                if new_items is None or qty < 0:
                    warnings.append(f"ไม่พบ {line.code or line.name} ในสต็อก – ไม่ได้ตัดยอด")
                    continue
                item = StockItem(code=line.code, name=line.name, unit=line.unit, unit_cost=line.unit_cost)
                new_items.items.append(item)
                stock.items.append(item)
                warnings.append(f"เพิ่ม {line.code or line.name} ในสต็อก (ไม่เคยมี)")
            item.on_hand = round(item.on_hand + qty, 6)
            if item.on_hand < 0:
                warnings.append(f"{item.code or item.name} ติดลบ {item.on_hand:g} {item.unit}")
            self.movements.append(Movement(doc.date, doc.doc_type, doc.doc_no, item.code or line.code,
                                           item.name or line.name, qty, line.unit or item.unit, doc.job,
                                           item.on_hand, doc.express_no, line.remark))
        doc.status = ST_POSTED
        doc.posted_at = datetime.now().isoformat(timespec="seconds")
        return warnings

    def cancel(self, doc: StockDoc, stock: StockList) -> None:
        """Reverse a posted document (the reversal is kept in the history)."""
        if doc.status != ST_POSTED:
            doc.status = ST_CANCELLED
            return
        for m in [m for m in self.movements if m.doc_no == doc.doc_no and m.doc_type == doc.doc_type]:
            item = find_by_code(m.code, stock) if m.code else _by_name(m.name, stock)
            if item is not None:
                item.on_hand = round(item.on_hand - m.qty, 6)
            self.movements.append(Movement(date.today().isoformat(), doc.doc_type, doc.doc_no, m.code, m.name,
                                           -m.qty, m.unit, m.job, item.on_hand if item else 0, doc.express_no,
                                           "ยกเลิกเอกสาร"))
        doc.status = ST_CANCELLED

    # ---- history ---------------------------------------------------------------
    def history(self, code: str = "", name: str = "") -> list[Movement]:
        key = _key(code)
        return [m for m in self.movements if (key and _key(m.code) == key) or (not key and name and m.name == name)
                or (not key and not name)]

    def daily_out(self, since: str = "") -> dict[str, dict[str, float]]:
        """Issued quantity per item and day (PD / OU, cancelled documents left out):
        {code: {date: qty}} - the usage for Min/Max."""
        cancelled = {(d.doc_type, d.doc_no) for d in self.docs if d.status == ST_CANCELLED}
        out: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for m in self.movements:
            if (m.doc_type in OUT_TYPES and m.qty < 0 and m.when >= since
                    and (m.doc_type, m.doc_no) not in cancelled):
                out[m.code or "#" + m.name][m.when[:10]] += -m.qty
        return {k: dict(v) for k, v in out.items()}

    def to_dict(self) -> dict:
        return {"docs": [d.to_dict() for d in self.docs], "movements": [asdict(m) for m in self.movements],
                "counters": self.counters}

    @classmethod
    def from_dict(cls, data: dict) -> Ledger:
        return cls(docs=[StockDoc.from_dict(d) for d in data.get("docs", [])],
                   movements=[Movement(**{k: v for k, v in m.items() if k in Movement.__dataclass_fields__})
                              for m in data.get("movements", [])],
                   counters=dict(data.get("counters", {})))


def _by_name(name: str, stock: StockList) -> StockItem | None:
    return next((i for i in stock.items if not i.code and i.name == name), None)


# --------------------------------------------------------------------------
# Lines from a requirement check / a list of parts
# --------------------------------------------------------------------------
def lines_from_requirements(lines: list[RequirementLine], warehouse: str = "01") -> list[DocLine]:
    """Raw material to issue (PD): whole units, only items Express has."""
    out = []
    for line in lines:
        if line.status == ST_MISSING or not line.code or line.required <= 0:
            continue
        out.append(DocLine(line.code, line.name, math.ceil(round(line.required, 6)), line.unit, line.location or warehouse,
                           line.unit_cost, ", ".join(line.parts[:6])))
    return out


def lines_from_parts(parts, stock: StockList, warehouse: str = "01", sets: float = 1) -> list[DocLine]:
    """One line per code (parts with the same code are added up)."""
    merged: dict[str, DocLine] = {}
    for p in parts:
        code = p.stock_code or p.part_no
        if not code and not p.name:
            continue
        item = find_by_code(code, stock) if code else None
        key = _key(item.code if item else code) or "#" + p.name
        line = merged.get(key)
        if line is None:
            line = merged[key] = DocLine(item.code if item else code, item.name if item else p.name, 0,
                                         (item.unit_name if item else "") or p.unit, warehouse,
                                         item.unit_cost if item else 0)
        line.qty += p.qty * sets
    return list(merged.values())


def export_doc(doc: StockDoc, path: str | Path, company: str = "") -> None:
    """The document as an Excel draft in the order of the Express screen."""
    from .express import thai_date
    from .tabular import write_table

    rows = [[i, ln.code, ln.name, ln.warehouse, ln.qty, ln.unit, ln.unit_cost, ln.amount, ln.remark]
            for i, ln in enumerate(doc.lines, start=1)]
    rows.append(["", "", "รวม", "", sum(ln.qty for ln in doc.lines), "", "", doc.total, ""])
    title = [[f"{doc.doc_type} - {doc.type_name} (ร่างสำหรับคีย์เข้า Express)" + (f" · {company}" if company else "")],
             ["เลขที่ในโปรแกรม", doc.doc_no, "วันที่", thai_date(doc.date), "เลขที่ Express", doc.express_no or "(Express ออกให้)"],
             ["งาน / SO", doc.job, "สำหรับแผนก", doc.department, "หมายเหตุ", doc.remark],
             ["สถานะ", doc.status]]
    write_table(path, DOC_HEADERS, rows, title_rows=title, sheet_title=doc.doc_type)


def history_rows(movements: list[Movement]) -> list[list]:
    return [[be_date(m.when), f"{m.doc_type} {DOC_TYPES.get(m.doc_type, ('', 0))[0]}", m.doc_no, m.express_no, m.job,
             m.code, m.name, m.qty if m.qty > 0 else "", -m.qty if m.qty < 0 else "", m.balance, m.unit, m.remark]
            for m in movements]


def export_history(movements: list[Movement], path: str | Path) -> None:
    from .tabular import write_table

    write_table(path, HISTORY_HEADERS, history_rows(movements),
                title_rows=[["ประวัติการเคลื่อนไหวสินค้า (บัตรสินค้า)"]], sheet_title="Movements")
