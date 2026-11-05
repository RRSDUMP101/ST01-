"""ส่งเข้า Express: everything of this program that has to be keyed into Express, in one Excel file laid out like the
Express screens (from the screens of the company's NewRWT):

    ในโปรแกรม                          ใน Express                          หน้าจอ
    PD เบิกไปผลิต (+ แผ่นเหล็กเลเซอร์)    PD - จ่ายวัตถุดิบเพื่อผลิต             สำหรับแผนก, หมายเหตุ, เลขที่เอกสาร, วันที่
    OU เบิกใช้ภายใน                      OU - จ่ายสินค้าใช้ภายใน               (เหมือน PD - ไม่ผูกงาน)
    RR รับสินค้าที่ซื้อ                    RR - รับสินค้า (อ้างอิง PO)            ผู้จำหน่าย, อ้างอิง PO, แผนก, วันที่
    FR รับชิ้นงานที่ผลิตเสร็จ               FR - รับสินค้าสำเร็จรูปจากการผลิต      แผนก, หมายเหตุ (งาน / SO)
    AJ ผลตรวจนับ (มือถือ, สต็อกเหล็ก)     JU - ปรับปรุงเพิ่ม/ลดสินค้า           แผนก, หมายเหตุ; จำนวน = ส่วนต่าง (+ เพิ่ม / − ลด)
    รหัสใหม่                             4.สินค้า → ทะเบียนสินค้า (เพิ่มใหม่)    รหัส, ชื่อ, หน่วย, หมวด, กลุ่มบัญชี
    Min/Max จากการใช้จริง                 จุดสั่งซื้อ / ปริมาณสั่งซื้อ            รหัส, Min, ปริมาณสั่ง

Lines as on every Express document: No. / รหัส / รายละเอียด / คลัง (01, or ST01 / ST05 … per Express company) / จำนวน + หน่วย / ราคาต่อหน่วย /
จำนวนเงิน; dates DD/MM/YY in the Buddhist year. PD has no job field in Express: the job / SO (and the chassis
number) go into หมายเหตุ, as the store does now. Express gives its own document number: after keying a document
in, its number is typed in the sheet "รายการส่ง Express" (or in the program) and read back here - the document
then leaves the list. Not sent to Express (kept in the program): the status of each piece, spoilt pieces,
pictures, laser layouts and DXF, shelf locations, QR codes and phones.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .express import code_issues, thai_date
from .movements import DOC_TYPES, ST_POSTED, Ledger, StockDoc
from .stock import StockItem, StockList, _key, find_by_code
from .tabular import Sheet, read_table, write_workbook

DEFAULT_WAREHOUSE = "01"
SEND_TYPES = ("PD", "OU", "RR", "FR", "AJ")
EXPRESS_SCREENS = {
    "PD": "PD - จ่ายวัตถุดิบเพื่อผลิต",
    "OU": "OU - จ่ายสินค้าใช้ภายใน",
    "RR": "RR - รับสินค้า (ซื้อ)",
    "FR": "FR - รับสินค้าสำเร็จรูปจากการผลิต",
    "AJ": "JU - ปรับปรุงเพิ่ม/ลดสินค้า",
}
EXPRESS_TYPES = {"AJ": "JU"}  # the document type in Express when it is not the same
LINE_HEADERS = ["No.", "รหัส", "รายละเอียด", "คลัง", "จำนวน", "หน่วย", "ราคาต่อหน่วย", "จำนวนเงิน", "หมายเหตุ"]
RR_HEADERS = ["No.", "รหัส", "รายละเอียด", "คลัง", "จำนวน", "หน่วย", "ราคาต่อหน่วย", "ส่วนลด", "จำนวนเงิน", "หมายเหตุ"]
AJ_HEADERS = ["No.", "รหัส", "รายละเอียด", "คลัง", "ยอดในระบบ", "นับได้", "จำนวน (ส่วนต่าง +/−)", "หน่วย",
              "ราคาต่อหน่วย", "จำนวนเงิน", "หมายเหตุ"]
SUMMARY_SHEET = "รายการส่ง Express"
SUMMARY_HEADERS = ["ลำดับ", "ชนิด", "หน้าจอใน Express", "เลขที่ในโปรแกรม", "วันที่", "สำหรับแผนก", "ผู้จำหน่าย / อ้างอิง",
                   "หมายเหตุ (ใน Express)", "รายการ", "จำนวนเงิน", "ชีท", "เลขที่ Express (กรอกหลังคีย์)"]
NEW_SHEET = "สินค้าใหม่"
NEW_HEADERS = ["No.", "รหัสสินค้า", "ชื่อสินค้า", "หน่วยนับ", "หมวด", "กลุ่มบัญชี", "ราคาทุน", "มาจาก", "ตรวจรหัส"]
MINMAX_SHEET = "จุดสั่งซื้อ Min-Max"
MINMAX_HEADERS = ["No.", "รหัสสินค้า", "ชื่อสินค้า", "หน่วย", "จุดสั่งซื้อ (Min)", "ปริมาณสั่งซื้อ", "Max",
                  "ใน Express เดิม (Min / Max)"]


@dataclass
class Options:
    department: str = ""  # สำหรับแผนก when a document has none (ST01 สโตร์, SET ทั่วไป/ช่าง …)
    warehouse: str = DEFAULT_WAREHOUSE  # คลัง for lines without one
    category: str = "21"  # หมวด of new items
    account_group: str = "ST01"  # กลุ่มบัญชี of new items
    company: str = ""


@dataclass
class MinMaxLine:
    item: StockItem
    express_min: float | None = None
    express_max: float | None = None

    @property
    def order_qty(self) -> float:
        return max(round(self.item.max_qty - self.item.min_qty, 3), 0)


@dataclass
class Outbox:
    docs: list[StockDoc]
    new_items: list[tuple[StockItem, str]]  # item, where it came from
    min_max: list[MinMaxLine]

    @property
    def empty(self) -> bool:
        return not (self.docs or self.new_items or self.min_max)

    def counts(self) -> dict[str, int]:
        out = {t: sum(1 for d in self.docs if d.doc_type == t) for t in SEND_TYPES}
        out["NEW"] = len(self.new_items)
        out["MINMAX"] = len(self.min_max)
        return out


# --------------------------------------------------------------------------
# What waits for Express
# --------------------------------------------------------------------------
def pending_docs(ledger: Ledger) -> list[StockDoc]:
    """Saved documents (บันทึกแล้ว) of the Express types without an Express number yet, oldest first."""
    docs = [d for d in ledger.docs if d.status == ST_POSTED and d.doc_type in SEND_TYPES and not d.express_no.strip()
            and d.lines]
    return sorted(docs, key=lambda d: (d.date, d.doc_no))


def _express_keys(express: StockList | None) -> set[str]:
    return {_key(i.code) for i in express.items} if express is not None else set()


def new_codes(express: StockList | None, stock: StockList, ledger: Ledger, partlist=None) -> list[tuple[StockItem, str]]:
    """Codes used in this program (documents, Part List, the program's stock) that Express does not have yet.
    No Express item list imported: nothing can be told apart - an empty list."""
    if express is None or not express.items:
        return []
    known = _express_keys(express)
    out: dict[str, tuple[StockItem, str]] = {}

    def add(code: str, name: str, unit: str, cost: float, where: str, item: StockItem | None = None) -> None:
        k = _key(code)
        if not k or k in known or k in out:
            return
        out[k] = (item or StockItem(code=code, name=name, unit=unit, unit_cost=cost), where)

    for doc in ledger.docs:
        if doc.status != ST_POSTED or doc.doc_type not in SEND_TYPES:
            continue
        for ln in doc.lines:
            item = find_by_code(ln.code, stock) if ln.code else None
            add(ln.code, ln.name, ln.unit, ln.unit_cost, f"{doc.doc_type} {doc.doc_no}", item)
    for p in getattr(partlist, "parts", None) or []:
        code = getattr(p, "stock_code", "") or getattr(p, "part_no", "")
        if code:
            item = find_by_code(code, stock)
            add(code, getattr(p, "name", ""), getattr(p, "unit", ""), 0, "Part List", item)
    return list(out.values())


def min_max_changes(stock: StockList, express: StockList | None) -> list[MinMaxLine]:
    """Items with a Min/Max in this program that Express does not have the same (all of them when no Express list)."""
    by_key = {_key(i.code): i for i in express.items} if express is not None else {}
    out = []
    for item in stock.items:
        if not item.code or (item.min_qty <= 0 and item.max_qty <= 0):
            continue
        ex = by_key.get(_key(item.code))
        if ex is not None and abs(ex.min_qty - item.min_qty) < 1e-9 and abs(ex.max_qty - item.max_qty) < 1e-9:
            continue
        out.append(MinMaxLine(item, ex.min_qty if ex is not None else None, ex.max_qty if ex is not None else None))
    return sorted(out, key=lambda m: m.item.code)


def outbox(ledger: Ledger, stock: StockList, express: StockList | None, partlist=None,
           with_min_max: bool = True) -> Outbox:
    return Outbox(pending_docs(ledger), new_codes(express, stock, ledger, partlist),
                  min_max_changes(stock, express) if with_min_max else [])


# --------------------------------------------------------------------------
# One document as on its Express screen
# --------------------------------------------------------------------------
def express_remark(doc: StockDoc) -> str:
    """หมายเหตุ as keyed in Express: PD / FR carry the job / SO there (Express PD has no job field)."""
    parts = [doc.job] if doc.job and doc.doc_type in ("PD", "FR", "AJ") else []
    if doc.remark and doc.remark not in parts:
        parts.append(doc.remark)
    if doc.job and doc.doc_type in ("OU", "RR") and doc.job not in " ".join(parts):
        parts.append(f"งาน {doc.job}")
    return " ".join(parts).strip()


def screen_note(doc: StockDoc) -> str:
    """หมายเหตุ, and for RR the vendor and the PO first."""
    head = []
    if doc.doc_type == "RR":
        head = [x for x in (f"ผู้จำหน่าย {doc.vendor}" if doc.vendor else "", f"PO {doc.ref}" if doc.ref else "") if x]
    return " · ".join(head + ([express_remark(doc)] if express_remark(doc) else []))


def warehouse_of(line_warehouse: str, options: Options) -> str:
    """คลัง of a line: its own (01, ST01, ST05 … - each Express company has its own codes), else the one set."""
    return (line_warehouse or "").strip() or options.warehouse


def _counted(doc: StockDoc, ledger: Ledger | None) -> dict[str, float]:
    """Balance after each line of a count (= what was counted)."""
    if ledger is None:
        return {}
    return {_key(m.code): m.balance for m in ledger.movements if m.doc_no == doc.doc_no}


def doc_sheet(doc: StockDoc, options: Options, ledger: Ledger | None = None) -> Sheet:
    dept = doc.department or options.department
    title = [[f"{EXPRESS_SCREENS.get(doc.doc_type, doc.type_name)} (ร่างสำหรับคีย์เข้า Express)"
              + (f" · {options.company}" if options.company else "")]]
    if doc.doc_type == "RR":
        title += [["ผู้จำหน่าย", doc.vendor, "", "อ้างอิง (PO)", doc.ref, "", "เลขที่ใบรับ", "(Express ออกให้)",
                   "วันที่", thai_date(doc.date)],
                  ["แผนก", dept, "", "หมายเหตุ", express_remark(doc), "", "เลขที่ในโปรแกรม", doc.doc_no]]
    else:
        title += [["สำหรับแผนก", dept, "", "", "", "", "เลขที่เอกสาร", "(Express ออกให้)", "วันที่", thai_date(doc.date)],
                  ["หมายเหตุ", express_remark(doc), "", "", "", "", "เลขที่ในโปรแกรม", doc.doc_no]]
    if doc.doc_type == "AJ":
        counted = _counted(doc, ledger)
        rows = []
        for i, ln in enumerate(doc.lines, start=1):
            after = counted.get(_key(ln.code))
            before = round(after - ln.qty, 3) if after is not None else ""
            rows.append([i, ln.code, ln.name, warehouse_of(ln.warehouse, options), before,
                         after if after is not None else "", ln.qty, ln.unit, ln.unit_cost, ln.amount, ln.remark])
        rows.append(["", "", "รวมมูลค่าส่วนต่าง", "", "", "", "", "", "", doc.total, ""])
        return Sheet(doc.doc_no, AJ_HEADERS, rows, title)
    if doc.doc_type == "RR":
        rows = [[i, ln.code, ln.name, warehouse_of(ln.warehouse, options), ln.qty, ln.unit, ln.unit_cost, "",
                 ln.amount, ln.remark] for i, ln in enumerate(doc.lines, start=1)]
        rows.append(["", "", "จำนวนเงิน", "", "", "", "", "", doc.total, ""])
        return Sheet(doc.doc_no, RR_HEADERS, rows, title)
    rows = [[i, ln.code, ln.name, warehouse_of(ln.warehouse, options), ln.qty, ln.unit, ln.unit_cost, ln.amount,
             ln.remark] for i, ln in enumerate(doc.lines, start=1)]
    rows.append(["", "", "จำนวนเงิน", "", "", "", "", doc.total, ""])
    return Sheet(doc.doc_no, LINE_HEADERS, rows, title)


# --------------------------------------------------------------------------
# The workbook
# --------------------------------------------------------------------------
def summary_rows(box: Outbox, options: Options) -> list[list]:
    rows = []
    for i, d in enumerate(box.docs, start=1):
        other = " · ".join(x for x in (d.vendor, f"PO {d.ref}" if d.ref else "") if x) if d.doc_type == "RR" else ""
        rows.append([i, d.doc_type, EXPRESS_SCREENS.get(d.doc_type, ""), d.doc_no, thai_date(d.date),
                     d.department or options.department, other, express_remark(d), len(d.lines), d.total, d.doc_no, ""])
    return rows


def write_outbox(box: Outbox, path: str | Path, options: Options | None = None, ledger: Ledger | None = None) -> int:
    """The Excel file to key into Express; returns the number of sheets of documents."""
    options = options or Options()
    head = [["ส่งเข้า Express – รายการที่ต้องคีย์" + (f" · {options.company}" if options.company else "")],
            ["คีย์ทีละใบตามชีท (ชื่อชีท = เลขที่ในโปรแกรม) แล้วกรอก เลขที่ Express ในคอลัมน์สุดท้าย "
             "→ หน้า Express ในโปรแกรม: นำเข้าเลขที่ Express"],
            [f"เอกสาร {len(box.docs)} ใบ · สินค้าใหม่ {len(box.new_items)} รหัส · จุดสั่งซื้อ {len(box.min_max)} รายการ"]]
    sheets = [Sheet(SUMMARY_SHEET, SUMMARY_HEADERS, summary_rows(box, options), head)]
    sheets += [doc_sheet(d, options, ledger) for d in box.docs]
    if box.new_items:
        rows = [[i, it.code, it.name, it.unit_name or it.unit, it.category or options.category,
                 it.account_group or options.account_group, it.unit_cost or "", where, " · ".join(code_issues(it.code))]
                for i, (it, where) in enumerate(box.new_items, start=1)]
        sheets.append(Sheet(NEW_SHEET, NEW_HEADERS, rows,
                            [["4.สินค้า → รายละเอียดสินค้า → เพิ่มใหม่ (F4): รหัสที่ใช้ในโปรแกรมแต่ยังไม่มีใน Express"]]))
    if box.min_max:
        rows = []
        for i, m in enumerate(box.min_max, start=1):
            old = "" if m.express_min is None else f"{m.express_min:g} / {m.express_max:g}"
            rows.append([i, m.item.code, m.item.name, m.item.unit_name or m.item.unit, m.item.min_qty, m.order_qty,
                         m.item.max_qty, old or "(ไม่มีใน Express)"])
        sheets.append(Sheet(MINMAX_SHEET, MINMAX_HEADERS, rows,
                            [["ทะเบียนสินค้า: จุดสั่งซื้อ = Min, ปริมาณสั่งซื้อ = Max − Min (จากการใช้จริง)"]]))
    write_workbook(path, sheets)
    return len(box.docs)


def read_express_numbers(path: str | Path) -> dict[str, str]:
    """{เลขที่ในโปรแกรม: เลขที่ Express} from the sheet รายการส่ง Express filled in after keying."""
    try:
        rows = read_table(path, SUMMARY_SHEET)
    except Exception:  # noqa: BLE001 - another file layout: try the first sheet
        rows = read_table(path)
    out = {}
    head = None
    for row in rows:
        cells = [str(c).strip() if c is not None else "" for c in row]
        if head is None:
            if "เลขที่ในโปรแกรม" in cells:
                head = cells
            continue
        try:
            no = cells[head.index("เลขที่ในโปรแกรม")]
            ex = cells[next(i for i, h in enumerate(head) if h.startswith("เลขที่ Express"))]
        except (ValueError, IndexError, StopIteration):
            continue
        if no and ex:
            out[no] = ex
    return out


def apply_express_numbers(ledger: Ledger, numbers: dict[str, str]) -> int:
    n = 0
    for doc in ledger.docs:
        ex = numbers.get(doc.doc_no, "").strip()
        if ex and doc.express_no != ex:
            doc.express_no = ex
            for m in ledger.movements:
                if m.doc_no == doc.doc_no:
                    m.express_no = ex
            n += 1
    return n


def type_label(doc_type: str) -> str:
    """'AJ ปรับปรุงยอด (ตรวจนับ) → JU' - the type in this program and, when it differs, in Express."""
    base = f"{doc_type} {DOC_TYPES.get(doc_type, ('', 0))[0]}"
    return base + (f" → {EXPRESS_TYPES[doc_type]}" if EXPRESS_TYPES.get(doc_type, doc_type) != doc_type else "")
