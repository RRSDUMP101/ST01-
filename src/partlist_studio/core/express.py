"""Express Accounting (NewRWT) - files to and from the company's Express program.

What the store sees in Express (from the screen recording of the company system):
  * 4.สินค้า → รายละเอียดสินค้า: รหัส, ชื่อไทย, หมวด (e.g. 21), กลุ่มบัญชี (e.g. ST01 สินค้าสำเร็จรูป-FIFO),
    หน่วย ย่อย/ใหญ่/ซื้อ/ขาย, ราคาขาย 1-5, ราคาทุนมาตรฐาน, ยอดคงเหลือ, ราคาต่อหน่วย, มูลค่าคงเหลือ
  * PD - จ่ายวัตถุดิบเพื่อผลิต and OU - จ่ายสินค้าใช้ภายใน: สำหรับแผนก, หมายเหตุ, เลขที่เอกสาร, วันที่
    (DD/MM/YY พ.ศ.) and lines No. / รหัส / รายละเอียด / คลัง / จำนวน + หน่วย / ราคาต่อหน่วย / จำนวนเงิน
  * Reports such as "แบบฟอร์มเพื่อการตรวจนับสินค้า" are fixed-width text where the code column is
    16 characters wide: longer codes (RRS-A-108-209-2-50) are cut (RRS-A-108-209-2-).

Express documents are keyed in on its own screens, so the files written here are drafts laid out in
the same order as those screens (not an Express import format, which has not been confirmed).
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .models import Part, PartList
from .stock import (ST_MISSING, RequirementLine, StockItem, StockList, _key, find_by_code, find_variants)
from .tabular import decode_bytes, write_table

REPORT_CODE_WIDTH = 16
CODE_FORBIDDEN = set(" /\\*?[]")


# --------------------------------------------------------------------------
# Dates
# --------------------------------------------------------------------------
def thai_date(d: date | str | None = None) -> str:
    """Express shows dates as DD/MM/YY in the Buddhist year: 2026-10-10 -> 10/10/69."""
    if d is None or d == "":
        d = date.today()
    if isinstance(d, str):
        d = date.fromisoformat(d)
    return f"{d.day:02d}/{d.month:02d}/{(d.year + 543) % 100:02d}"


# --------------------------------------------------------------------------
# Item codes
# --------------------------------------------------------------------------
def code_issues(code: str) -> list[str]:
    issues = []
    if not code:
        return ["ไม่มีรหัส"]
    if any(ch in CODE_FORBIDDEN for ch in code):
        issues.append("มีช่องว่างหรืออักขระ / \\ * ? [ ]")
    if not code.isascii():
        issues.append("มีอักษรไทย")
    if len(code) > REPORT_CODE_WIDTH:
        issues.append(f"ยาว {len(code)} ตัว – รายงานแบบข้อความของ Express จะตัดเหลือ {REPORT_CODE_WIDTH} ตัว")
    return issues


def code_family(code: str) -> str:
    """Prefix used by the company: 01-B00 (เหล็กแผ่น), 04-B00 (ท่อ), RRS-A, RRS-M ... ."""
    if not code:
        return ""
    parts = code.replace(" ", "").split("-")
    return "-".join(parts[:2]) if len(parts) > 1 else code


# --------------------------------------------------------------------------
# Text reports (print to file / TMP2 window)
# --------------------------------------------------------------------------
def _display_cols(line: str) -> list[int]:
    """Display column of every character: Thai vowels/tone marks above or below take no column."""
    cols, col = [], 0
    for ch in line:
        cols.append(col)
        if not unicodedata.category(ch).startswith("M"):
            col += 1
    return cols


_NUM_RE = re.compile(r"-?[\d,]+\.\d+|-?\d{1,3}(?:,\d{3})+|-?\d+")
_ITEM_RE = re.compile(r"^\s*(\d+)\s+(\S)")
_REPORT_HEADERS = {
    "code": ["รหัสสินค้า", "รหัส"],
    "name": ["ชื่อสินค้า", "รายละเอียด"],
    "shelf": ["ชั้นเก็บ"],
    "on_hand": ["ยอดคงเหลือ", "คงเหลือ", "จำนวน"],
    "unit_cost": ["ราคาต่อหน่วย", "ทุนต่อหน่วย", "ต้นทุน"],
    "value": ["มูลค่า", "มูลค่าคงเหลือ", "จำนวนเงิน"],
    "unit": ["หน่วยย่อย", "หน่วย"],
}


@dataclass
class TextReport:
    title: str = ""
    company: str = ""
    warehouse: str = ""
    columns: list[tuple[str, int]] = field(default_factory=list)  # (field, display column)
    items: list[StockItem] = field(default_factory=list)
    has_quantities: bool = False


def report_lines(text: str) -> list[str]:
    """Lines of an Express print-to-file report. Some exports wrap every line in double quotes."""
    out = []
    for line in text.splitlines():
        if len(line) >= 2 and line[0] == '"' and line[-1] == '"':
            line = line[1:-1]
        out.append(line.replace("\xa0", " "))
    return out


def parse_text_report(text: str) -> TextReport:
    lines = report_lines(text)
    if any("ตัวคูณ" in line and "รหัสบ/ช" in line for line in lines[:12]):
        return parse_item_detail_report(text)
    report = TextReport()
    name_col = None
    for line in lines:
        stripped = line.strip()
        if not stripped or set(stripped) <= set("-=<>_ "):
            continue
        if not report.company and ("บริษัท" in stripped or "จำกัด" in stripped):
            report.company = re.sub(r"\s+หน้า\s*:.*$", "", stripped)
            continue
        if not report.title and re.search(r"[฀-๿]", stripped) and not _ITEM_RE.match(line) \
                and "รหัส" not in stripped:
            report.title = re.sub(r"(?<=[฀-๿]) (?=[฀-๿])", "", stripped)
            continue
        if "รหัส" in stripped and "ชื่อ" in stripped and not report.columns:
            cols = _display_cols(line)
            found = []
            for fld, labels in _REPORT_HEADERS.items():
                for label in labels:
                    pos = line.find(label)
                    if pos >= 0 and not any(abs(cols[pos] - c) < 2 for _f, c in found):
                        found.append((fld, cols[pos]))
                        break
            report.columns = sorted(found, key=lambda fc: fc[1])
            name_col = dict(report.columns).get("name")
            continue
        if not report.warehouse and re.match(r"^\s*\d{2}\s+\S", line) and not _NUM_RE.fullmatch(stripped):
            m = re.match(r"^\s*(\d{2})\s+(\S.*)$", line)
            if m and not re.search(r"[A-Za-z]{2,}-", m.group(2)):
                report.warehouse = f"{m.group(1)} {m.group(2).strip().split('  ')[0]}"
                continue
        item = _parse_item_line(line, name_col, report)
        if item:
            report.items.append(item)
    return report


def _parse_item_line(line: str, name_col: int | None, report: TextReport) -> StockItem | None:
    m = _ITEM_RE.match(line)
    if not m:
        return None
    start = m.start(2)
    rest = line[start:]
    if not rest[:1].isascii():
        return None
    cols = _display_cols(line)
    # code: ASCII up to the first space, never past the name column (codes are cut there).
    code_end = start
    while code_end < len(line) and line[code_end].isascii() and line[code_end] != " ":
        code_end += 1
        if name_col is not None and cols[code_end - 1] >= name_col - 1 and code_end - start >= REPORT_CODE_WIDTH:
            break
    if code_end - start > REPORT_CODE_WIDTH:
        code_end = start + REPORT_CODE_WIDTH
    code = line[start:code_end]
    truncated = code_end < len(line) and line[code_end] != " " and len(code) >= REPORT_CODE_WIDTH
    tail = line[code_end:]
    # unit: last Thai word; numbers: numeric tokens after the name
    unit = ""
    m_unit = re.search(r"([฀-๿.]+)\s*$", tail)
    body = tail
    if m_unit and len(m_unit.group(1).strip(".")) <= 6:
        unit = m_unit.group(1).strip(".")
        body = tail[:m_unit.start()]
    body = re.sub(r"\.{3,}", " ", body)
    # name ends where a run of 2+ spaces is followed only by numbers
    name_part, numbers = body, []
    m_nums = re.search(r"(\s{2,}(?:-?[\d,]+(?:\.\d+)?\s*)+)$", body)
    if m_nums:
        name_part = body[:m_nums.start()]
        numbers = [float(n.replace(",", "")) for n in _NUM_RE.findall(m_nums.group(1))]
    name = re.sub(r"(?<=[฀-๿]) (?=[฀-๿])", "", name_part.strip())  # spaced-out print
    name = re.sub(r"\s{2,}", " ", name)
    item = StockItem(code=code, name=name, unit=unit, code_truncated=truncated)
    if numbers:
        report.has_quantities = True
        num_fields = [f for f, _c in report.columns if f in ("on_hand", "unit_cost", "value")]
        for fld, value in zip(num_fields or ["on_hand"], numbers):
            if fld != "value":
                item.set(fld, value)
    item.infer_from_name()
    return item


# ---- STMASR0200 รายงานรายละเอียดสินค้า (item master) ------------------------------------
# code column: characters 3-22 (20 wide, codes may fill it and touch the name)
_DETAIL_CODE_WIDTH = 20
_DETAIL_ITEM_RE = re.compile(r"^(?P<name>\S.*?)\s+ย่อย(?:\s+(?P<unit>[^\s\d][^\s]*))?(?P<rest>.*)$")
_DETAIL_UNIT_RE = re.compile(r"(?P<kind>ใหญ่|ซื้อ|ขาย)(?:\s+(?P<unit>[^\s\d][^\s]*))?(?:\s+(?P<factor>[\d,]+(?:\.\d+)?))?\s*$")
_DETAIL_CATEGORY_RE = re.compile(r"^\s{2}(?P<cat>\d{1,3})\s{3,}(?P<name>\S.*?)\s*$")
_UNIT_KEYS = {"ใหญ่": "big", "ซื้อ": "buy", "ขาย": "sell"}


def parse_item_detail_report(text: str) -> TextReport:
    """Express 'รายงานรายละเอียดสินค้า' (STMASR0200): one item over several lines -
    code / name / หน่วยย่อย / รหัสบ/ช / ราคามาตรฐาน / สินค้าทดแทน / ผู้จัดจำหน่าย, then the ใหญ่, ซื้อ and ขาย
    units with their factors, and an optional หมายเหตุ written on the left of those lines."""
    report = TextReport(title="รายงานรายละเอียดสินค้า")
    category, category_name = "", ""
    current: StockItem | None = None
    for line in report_lines(text):
        stripped = line.strip()
        if not stripped or set(stripped) <= set("-=<> .") or stripped.startswith(">>>"):
            continue
        if "หน้า" in line and ("บริษัท" in line or "จำกัด" in line):
            report.company = report.company or re.sub(r"\s+หน้า\s*:.*$", "", stripped)
            continue
        if stripped.startswith("รายงาน") or stripped.startswith("รหัสสินค้า จาก") or (
                "รายละเอียด" in stripped and "หน่วย" in stripped and "รหัส" in stripped):
            if "วันที่" in stripped:
                report.warehouse = report.warehouse  # page header
            continue
        m = None
        if line.startswith("  ") and line[2:3].isascii() and line[2:3].strip() and "ย่อย" in line:
            m = _DETAIL_ITEM_RE.match(line[2 + _DETAIL_CODE_WIDTH:].strip())
        if m:
            current = StockItem(code=line[2:2 + _DETAIL_CODE_WIDTH].strip(), name=m.group("name").strip(),
                                unit=(m.group("unit") or "").strip(), category=category)
            current.extra["category_name"] = category_name
            rest = [t for t in re.split(r"\s{2,}", (m.group("rest") or "").strip()) if t]
            numbers = [t for t in rest if re.fullmatch(r"-?[\d,]+\.\d+", t)]
            words = [t for t in rest if t not in numbers]
            if words:
                current.account_group = words[0]
            if numbers:
                current.unit_cost = float(numbers[0].replace(",", ""))
            tail = [w for w in words[1:] if w != "-"]
            if tail:
                current.extra["substitute"] = tail[0]
            if len(tail) > 1:
                current.extra["vendor"] = tail[1]
            current.infer_from_name()
            report.items.append(current)
            continue
        m = _DETAIL_CATEGORY_RE.match(line)
        if m and "ย่อย" not in line:
            category, category_name = m.group("cat"), m.group("name")
            report.columns = report.columns  # categories are kept on each item
            continue
        if current is None:
            continue
        unit_match = _DETAIL_UNIT_RE.search(line)
        if unit_match:
            key = _UNIT_KEYS[unit_match.group("kind")]
            if unit_match.group("unit"):
                current.extra[f"unit_{key}"] = unit_match.group("unit")
            if unit_match.group("factor"):
                current.extra[f"factor_{key}"] = float(unit_match.group("factor").replace(",", ""))
            left = line[:unit_match.start()]
        else:
            left = line
        note = re.search(r"หมายเหตุ\s+(.+?)\s*$", left)
        if note:
            current.remark = (current.remark + " " + note.group(1).strip()).strip()
    report.has_quantities = False
    return report


ITEM_FORM_HEADERS = ["รหัสสินค้า", "ชื่อสินค้า", "หมวด", "ชื่อหมวด", "กลุ่มรหัส", "ประเภท", "หน่วยย่อย", "หน่วยใหญ่",
                     "ตัวคูณใหญ่", "หน่วยซื้อ", "ตัวคูณซื้อ", "หน่วยขาย", "ตัวคูณขาย", "รหัสบ/ช", "ราคามาตรฐาน",
                     "สินค้าทดแทน", "ผู้จัดจำหน่าย", "หมายเหตุ (Express)"]


def item_form_row(item: StockItem) -> list:
    x = item.extra
    return [item.code, item.name, item.category, x.get("category_name", ""), code_family(item.code),
            item_kind(item.code), item.unit, x.get("unit_big", ""), x.get("factor_big", ""), x.get("unit_buy", ""),
            x.get("factor_buy", ""), x.get("unit_sell", ""), x.get("factor_sell", ""), item.account_group,
            item.unit_cost, x.get("substitute", ""), x.get("vendor", ""), item.remark]


# Meaning of the code groups seen in the company item master.
CODE_FAMILY_NAMES = {
    "01-B00": "เหล็กแผ่นดำ", "01-FB0": "เหล็กแบน (แฟลตบาร์)", "01-T00": "ตะแกรงเหล็ก", "01-W00": "เหล็กเพลาขาว",
    "02-A00": "แผ่นอลูมิเนียม", "03-S00": "แผ่นสแตนเลส", "04-API": "ท่อเหล็ก API", "04-B00": "ท่อเหล็กกลมดำ",
    "05-B00": "เหล็กกล่องท่อแบน", "06-B00": "เหล็กกล่องท่อเหลี่ยม", "07-B00": "เหล็กกล่อง / เหล็กสี่เหลี่ยม",
    "08-R00": "เหล็กรางพับ / รางน้ำ", "09-E00": "เหล็กฉาก",
    "RRS-A": "ชิ้นงาน ใช้ร่วมทุกรุ่น", "RRS-A1": "ชิ้นงาน พื้นเรียบ / บานสวิง", "RRS-T": "ชิ้นงาน Toyota",
    "RRS-M": "ชิ้นงาน Mitsubishi", "RRS-M1": "ชิ้นงาน Mitsubishi (รุ่นเก่า/2024)", "RRS-I": "ชิ้นงาน Isuzu",
    "RRS-N": "ชิ้นงาน Nissan (N.V / F.T)", "RRS-S": "ชิ้นงาน Suzuki",
}


def item_kind(code: str) -> str:
    if not code:
        return ""
    return "ชิ้นงานผลิต" if code.upper().startswith(("RRS", "RRA")) else "วัตถุดิบ"


def read_express_file(path: str | Path) -> tuple[StockList, TextReport | None]:
    """Item list / stock balance from Express: Excel or CSV export, or a text report."""
    path = Path(path)
    if path.suffix.lower() in (".txt", ".prn", ".rpt", ".tmp", ""):
        report = parse_text_report(decode_bytes(path.read_bytes()))
        if report.items:
            return StockList(items=report.items, source=f"Express: {path.name}",
                             has_quantities=report.has_quantities), report
    stock = StockList.from_file(path)
    stock.source = f"Express: {path.name}"
    return stock, None


# --------------------------------------------------------------------------
# Drafts for keying into Express
# --------------------------------------------------------------------------
PD_HEADERS = ["No.", "รหัส", "รายละเอียด", "คลัง", "จำนวน", "หน่วย", "ราคาต่อหน่วย", "จำนวนเงิน"]


def pd_lines(lines: list[RequirementLine], warehouse: str = "01") -> list[list]:
    """Lines of 'PD - จ่ายวัตถุดิบเพื่อผลิต' in the order of the Express screen. Whole units only."""
    rows = []
    for line in lines:
        if line.status == ST_MISSING or not line.code or line.required <= 0:
            continue
        qty = math.ceil(round(line.required, 6))
        rows.append([len(rows) + 1, line.code, line.name, line.location or warehouse, qty, line.unit,
                     round(line.unit_cost, 3), round(qty * line.unit_cost, 2)])
    return rows


def export_pd_draft(partlist: PartList, lines: list[RequirementLine], path: str | Path, warehouse: str = "01",
                    department: str = "", doc_date: date | str | None = None) -> int:
    info = partlist.info
    rows = pd_lines(lines, warehouse)
    remark = " ".join(x for x in (info.so_no, info.vehicle_model, info.job_type,
                                  f"{info.build_qty} คัน" if info.build_qty else "") if x)
    title_rows = [
        ["ร่าง PD - จ่ายวัตถุดิบเพื่อผลิต (สำหรับคีย์เข้า Express)"],
        ["สำหรับแผนก", department, "หมายเหตุ", remark, "วันที่", thai_date(doc_date)],
        ["เลขที่เอกสาร", "(Express ออกให้)", "เลขที่แบบ", info.drawing_no, "Rev.", info.revision],
    ]
    missing = [line for line in lines if line.status == ST_MISSING]
    if missing:
        rows.append([])
        rows.append(["", "ไม่พบรหัสใน Express – ต้องเปิดรหัสหรือผูกรหัสสโตร์ก่อน"])
        for line in missing:
            rows.append(["", "", line.name, "", math.ceil(line.required), line.unit, "", ""])
    write_table(path, PD_HEADERS, rows, title_rows=title_rows, sheet_title="PD")
    return len(pd_lines(lines, warehouse))


NEW_ITEM_HEADERS = ["รหัส", "ชื่อไทย", "ชื่ออังกฤษ", "หมวด", "กลุ่มบัญชี", "หน่วยย่อย", "หน่วยซื้อ", "หน่วยขาย",
                    "ราคาทุนมาตรฐาน", "หมายเหตุ", "ตรวจรหัส"]


def new_items(partlist: PartList, stock: StockList) -> list[Part]:
    """Parts with a part number that Express does not have yet (made in-house, e.g. RRS-...)."""
    seen, out = set(), []
    for part in partlist.parts:
        if part.part_no and not find_by_code(part.part_no, stock) and _key(part.part_no) not in seen:
            seen.add(_key(part.part_no))
            out.append(part)
    return out


def export_new_items(partlist: PartList, stock: StockList, path: str | Path, category: str = "21",
                     account_group: str = "ST01") -> int:
    rows = []
    for part in new_items(partlist, stock):
        remark = " ".join(x for x in (part.material, part.spec, f"แบบ {part.drawing_no}" if part.drawing_no else "")
                          if x)
        rows.append([part.part_no, part.name, "", category, account_group, part.unit, part.unit, part.unit, 0,
                     remark, " / ".join(code_issues(part.part_no)) or "OK"])
    title_rows = [["รายการสินค้าใหม่สำหรับเปิดใน Express (4.สินค้า → รายละเอียดสินค้า → เพิ่มใหม่)"]]
    write_table(path, NEW_ITEM_HEADERS, rows, title_rows=title_rows, sheet_title="NewItems")
    return len(rows)


# --------------------------------------------------------------------------
# Keeping Express, the Google Sheet and this program the same
# --------------------------------------------------------------------------
SYNC_SAME = "ตรงกัน"
SYNC_DIFF = "ไม่ตรงกัน"
SYNC_ONLY_A = "มีเฉพาะ"
COMPARE_FIELDS = [("name", "ชื่อสินค้า"), ("unit", "หน่วย"), ("on_hand", "ยอดคงเหลือ"), ("unit_cost", "ราคาต่อหน่วย")]


@dataclass
class SyncRow:
    code: str
    name: str
    status: str
    detail: str = ""


def compare_stock(a: StockList, b: StockList, a_name: str = "Express", b_name: str = "Google Sheet") -> list[SyncRow]:
    rows: list[SyncRow] = []
    b_left = list(b.items)
    for item in a.items:
        other = _same_item(item, b_left)
        if other is None:
            rows.append(SyncRow(item.code, item.name, f"{SYNC_ONLY_A} {a_name}"))
            continue
        b_left.remove(other)
        diffs = []
        both_counted = a.has_quantities and b.has_quantities
        for fld, label in COMPARE_FIELDS:
            if fld in ("on_hand", "unit_cost") and not both_counted:
                continue
            va, vb = item.get(fld), other.get(fld)
            if fld == "unit":
                va, vb = item.unit_name, other.unit_name
            if isinstance(va, (int, float)) or isinstance(vb, (int, float)):
                if abs(float(va or 0) - float(vb or 0)) > 1e-6:
                    diffs.append(f"{label}: {a_name} {va:g} / {b_name} {vb:g}")
            elif str(va).strip() and str(vb).strip() and _key(str(va)) != _key(str(vb)):
                diffs.append(f"{label}: {a_name} '{va}' / {b_name} '{vb}'")
        full_code = other.code if item.code_truncated else item.code
        rows.append(SyncRow(full_code, item.name, SYNC_DIFF if diffs else SYNC_SAME, " · ".join(diffs)))
    rows += [SyncRow(i.code, i.name, f"{SYNC_ONLY_A} {b_name}") for i in b_left]
    order = {SYNC_DIFF: 0}
    return sorted(rows, key=lambda r: (order.get(r.status, 1 if r.status != SYNC_SAME else 2), r.code))


def _same_item(item: StockItem, pool: list[StockItem]) -> StockItem | None:
    key = _key(item.code)
    for other in pool:
        if _key(other.code) == key:
            return other
    for other in pool:  # one side read from a text report with the code cut to 16 characters
        okey = _key(other.code)
        if (item.code_truncated and okey.startswith(key)) or (other.code_truncated and key.startswith(okey)):
            return other
    return None


@dataclass
class CodeCheck:
    part_no: str
    name: str
    express_code: str
    status: str
    detail: str = ""


def check_part_codes(partlist: PartList, stock: StockList) -> list[CodeCheck]:
    """Part List rows versus Express item codes (part number for made parts, stock code for materials)."""
    out = []
    for part in partlist.parts:
        code = part.part_no or part.stock_code
        if not code:
            out.append(CodeCheck("", part.name, "", "ไม่มีรหัส", "ใส่รหัสชิ้นส่วนหรือรหัสสโตร์"))
            continue
        item = find_by_code(part.part_no, stock) or find_by_code(part.stock_code, stock)
        issues = code_issues(code)
        variants = find_variants(code, stock) if item is None else []
        if item is None and variants:
            out.append(CodeCheck(code, part.name, "", f"มีรุ่นย่อย {len(variants)} รายการ",
                                 "เลือกรหัสเต็ม: " + ", ".join(f"{v.code} {v.name}" for v in variants[:6])))
        elif item is None:
            out.append(CodeCheck(code, part.name, "", "ไม่พบใน Express", " / ".join(issues)))
        elif item.code_truncated:
            out.append(CodeCheck(code, part.name, item.code, "พบ (รหัสในรายงานถูกตัด)",
                                 "นำเข้าจาก Excel ของ Express เพื่อยืนยันรหัสเต็ม"))
        else:
            out.append(CodeCheck(code, part.name, item.code, "ตรงกัน", " / ".join(issues)))
    return out
