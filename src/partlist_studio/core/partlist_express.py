"""'Parts List All Model' rebuilt on Express item codes ("Parts List All Model (รหัส Express)").

One workbook that keeps every company layout and ties it to Express:

* one tab per model in the original layout (ลำดับ | รหัส | รายการ | ภาพประกอบ | ขนาด | จำนวนที่ใช้ | หมายเหตุ),
  where รหัส is now the full Express code (RRS-T-024-L-84 instead of RRS-T-024) and a "1+1" row is one line
  for ซ้าย and one for ขวา; extra columns show the Express name, unit, balance and how the code was found
* เทียบรหัสแบบกระบะ - every row of every model with its match status (what a person must check)
* ฟอร์มเพิ่มสินค้าใหม่ - pre-filled with the parts Express does not have yet, with a code in Express style
* อะไหล่กระบะ / สต๊อกเหล็ก - the balance sheets with the Express code of each line
* ทะเบียนสินค้า, สรุป, กลุ่มรหัส, สต็อกนับ, รายการเลือก, ความหนาแน่น - see item_form

The program reads the model tabs back as they are (Express codes are typed values, the rest are formulas).
"""

from __future__ import annotations

import difflib
import re
from pathlib import Path

from .company_files import ModelBOM, normalize_code
from .express import code_family
from .express_codes import (ST_AUTO, ST_CHECK, ST_EXACT, ST_NOCODE, ST_NONE, Resolved, model_context, resolve_models,
                            side_name, summary)
from .stock import StockItem, StockList, _key
from .xref import CodeXref, name_key

MODEL_HEADERS = ["ลำดับ", "รหัส", "รายการ", "ภาพประกอบ", "ขนาด", "จำนวนที่ใช้", "หมายเหตุ",
                 "ชื่อใน Express", "หน่วย", "ยอดคงเหลือ", "ราคามาตรฐาน", "การจับคู่", "ตรวจรหัส", "รหัสเดิมในแบบ",
                 "ตัวเลือกอื่น"]
REVIEW_HEADERS = ["แบบกระบะ", "ลำดับ", "รายการในแบบ", "ด้าน", "จำนวน/คัน", "รหัสเดิมในแบบ", "รหัส Express",
                  "ชื่อใน Express", "การจับคู่", "ตรวจรหัส", "ตัวเลือกอื่น"]
STATUS_FILLS = {ST_EXACT: "E2F0D9", ST_AUTO: "E2F0D9", ST_CHECK: "FFF2CC", ST_NONE: "FDECEC", ST_NOCODE: "FDECEC"}
NAME_EXACT = "ชื่อตรงกัน"


# --------------------------------------------------------------------------
# Lines without a code (อะไหล่กระบะ, สต๊อกเหล็ก) -> Express code by name
# --------------------------------------------------------------------------
def _nums(text: str) -> list[str]:
    return [n.rstrip("0").rstrip(".") if "." in n else n for n in re.findall(r"\d+(?:\.\d+)?", text or "")]


def match_names(items: list[StockItem], express: StockList) -> list[tuple[str, str, str, list[str]]]:
    """(code, Express name, status, alternatives) for each item; numbers (thickness, size) must agree."""
    by_key: dict[str, list[StockItem]] = {}
    for e in express.items:
        by_key.setdefault(name_key(e.name), []).append(e)
    out = []
    for item in items:
        k = name_key(item.name)
        same = by_key.get(k, [])
        if len(same) == 1:
            out.append((same[0].code, same[0].name, NAME_EXACT, []))
            continue
        nums = _nums(item.name)
        head = re.split(r"[\s\d(]", item.name.strip(), maxsplit=1)[0]
        scored = []
        for e in express.items:
            e_nums = _nums(e.name)
            if any(nums.count(n) > e_nums.count(n) for n in set(nums)):
                continue
            # Express names carry notes: "เหล็กแผ่นดำ 3 มม.4x8ฟุต(พื้น2.3,2.4)1219x2440"
            plain = name_key(re.sub(r"\(.*?\)|\d{3,4}\s*[x*]\s*\d{3,4}$", "", e.name))
            ratio = max(difflib.SequenceMatcher(None, k, name_key(e.name)).ratio(),
                        difflib.SequenceMatcher(None, k, plain).ratio())
            if head and head not in e.name:
                ratio -= 0.15
            if ratio >= 0.55:
                scored.append((ratio, e))
        scored.sort(key=lambda t: -t[0])
        if not scored:
            out.append(("", "", ST_NONE, []))
            continue
        best_r, best = scored[0]
        alts = [f"{e.code} {e.name}" for r, e in scored[1:4] if r >= best_r - 0.1]
        status = ST_AUTO if best_r >= 0.75 and not alts else ST_CHECK
        out.append((best.code, best.name, status, alts))
    return out


# --------------------------------------------------------------------------
# Codes for the parts Express does not have yet
# --------------------------------------------------------------------------
def suggest_code(model: ModelBOM, r: Resolved, taken: set[str] | None) -> str:
    """An Express-style code: base code + side + stall height + brand (RRS-T-023-R-84-CHAMP)."""
    raw = r.old_code.split(",")[0].strip()
    base = normalize_code(re.sub(r"\(.*?\)", "", raw)).replace("_", "-").replace(" ", "")
    base = re.sub(r"^(DP-ST-)", "", base)
    base = re.sub(r"^RRS-?([A-Z])-?0*(\d+)", lambda m: f"RRS-{m.group(1)}-{int(m.group(2)):03d}", base)
    base = re.sub(r"^RRS-?0*(\d+)", lambda m: f"RRS-A-{int(m.group(1)):03d}", base)
    if not re.match(r"^RRS-[A-Z0-9]+-\d{3}", base):
        return ""
    base = "-".join(base.split("-")[:3])
    ctx = model_context(model)
    parts = [base]
    if r.side:
        parts.append("L" if r.side == "ซ้าย" else "R")
    heights = [h for h in ctx.heights if h in r.name or h in (r.size or "")]
    if heights:
        parts.append(heights[0])
    if "CHAMP" in ctx.brands and base.startswith("RRS-T"):
        parts.append("CHAMP")
    if "PR" in ctx.brands:
        parts.append("PR")
    code = "-".join(parts)
    if taken is None:
        return code
    candidate, n = code, 2
    while _key(candidate) in taken:
        candidate, n = f"{code}-{n}", n + 1
    return candidate


def new_item_rows(models: list[ModelBOM], resolved: dict[str, list[Resolved]], express: StockList,
                  requester: str = "", today: str = "") -> list[list]:
    """Rows for ฟอร์มเพิ่มสินค้าใหม่ (FORM_HEADERS order), one per part Express is missing."""
    taken = {_key(i.code) for i in express.items}
    by_name: dict[tuple[str, str], list] = {}
    for model in models:
        for r in resolved.get(model.name, []):
            if r.status not in (ST_NONE, ST_NOCODE) or not r.name:
                continue
            name = side_name(r)
            key = (name_key(name), _key(suggest_code(model, r, None)))
            if key in by_name:
                by_name[key][13] += f", {model.name}"
                continue
            code = suggest_code(model, r, taken)
            if code:
                taken.add(_key(code))
            by_name[key] = [code, name, "", "21", code_family(code) if code else "", "ชิ้น", "ชิ้น", 1, "ชิ้น", 1,
                            "ST01", None, "", f"จากแบบ {model.name}", requester, today]
    return list(by_name.values())


# --------------------------------------------------------------------------
# Workbook tabs (called from item_form.build_item_form)
# --------------------------------------------------------------------------
def _safe_title(name: str, used: set[str]) -> str:
    title = re.sub(r"[\[\]:*?/\\]", "-", name)[:31] or "แบบ"
    out, n = title, 2
    while out in used:
        out, n = f"{title[:28]}-{n}", n + 1
    used.add(out)
    return out


def write_model_tabs(wb, b, models: list[ModelBOM], resolved: dict[str, list[Resolved]]) -> list[tuple]:
    """One tab per model; returns (tab, row, Resolved) for the review tab."""
    from openpyxl.drawing.image import Image as XLImage
    from openpyxl.formatting.rule import CellIsRule
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation

    links = []
    used = set(wb.sheetnames)
    widths = [7, 22, 30, 24, 14, 10, 18, 32, 7, 10, 10, 14, 22, 18, 40]
    for model in models:
        rows = resolved.get(model.name, [])
        ws = wb.create_sheet(_safe_title(model.name, used))
        ws.cell(1, 1, model.title or model.name).font = Font(name=b.font, bold=True, size=13)
        ws.cell(2, 1, "รหัส = รหัสสินค้าใน Express · ช่องสีเหลือง = ควรตรวจ / เลือกจากรายการ · "
                      "ชื่อใน Express, หน่วย, ยอดคงเหลือ, ตรวจรหัส เป็นสูตร").font = \
            Font(name=b.font, italic=True, size=9, color="6B7A90")
        b.header(ws, MODEL_HEADERS, widths, header_row=3)
        first = 4
        for i, r in enumerate(rows):
            rr = first + i
            values = [r.item_no, r.code or None, side_name(r), None, r.size or None, r.qty if r.qty else None,
                      r.remark or None]
            for c, v in enumerate(values, start=1):
                if v not in (None, ""):
                    ws.cell(rr, c, v)
            ws.cell(rr, 8, f'=IF(B{rr}="","",IFERROR(VLOOKUP(B{rr},{b.master}!$A:$B,2,FALSE),""))')
            ws.cell(rr, 9, f'=IF(B{rr}="","",IFERROR(VLOOKUP(B{rr},{b.master}!$A:$H,8,FALSE),""))')
            ws.cell(rr, 10, f'=IF(B{rr}="","",IFERROR(INDEX({b.master}!$AA:$AA,MATCH(B{rr},{b.master}!$A:$A,0)),""))')
            ws.cell(rr, 11, f'=IF(B{rr}="","",IFERROR(INDEX({b.master}!$P:$P,MATCH(B{rr},{b.master}!$A:$A,0)),""))')
            ws.cell(rr, 12, r.status)
            ws.cell(rr, 13, f'=IF(B{rr}="","ยังไม่มีรหัส – ขอเปิดรหัสใหม่",IF(COUNTIF({b.master}!$A:$A,B{rr})=0,'
                            f'"ไม่มีรหัสนี้ใน Express","มีใน Express"))')
            ws.cell(rr, 14, r.old_code or None)
            if r.alternatives:
                ws.cell(rr, 15, " | ".join(r.alternatives))
            for c in range(1, len(MODEL_HEADERS) + 1):
                ws.cell(rr, c).font = b.body_font
                ws.cell(rr, c).alignment = Alignment(vertical="center", wrap_text=c in (3, 8, 15))
            if r.status in (ST_CHECK, ST_NONE, ST_NOCODE):
                ws.cell(rr, 2).fill = b.input_fill
            ws.cell(rr, 12).fill = PatternFill("solid", fgColor=STATUS_FILLS.get(r.status, "FFFFFF"))
            if r.image and Path(r.image).is_file():
                try:
                    img = XLImage(r.image)
                    scale = min(160 / max(img.width, 1), 90 / max(img.height, 1), 1)
                    img.width, img.height = int(img.width * scale), int(img.height * scale)
                    ws.row_dimensions[rr].height = max(ws.row_dimensions[rr].height or 15, img.height * 0.78)
                    ws.add_image(img, f"D{rr}")
                except Exception:  # noqa: BLE001 - unreadable picture, keep the row
                    pass
            links.append((ws.title, rr, model, r))
        last = first + max(len(rows), 1) - 1
        dv = DataValidation(type="list", formula1=f"={b.master}!$A$2:$A${b.master_rows + 1}", allow_blank=True,
                            showErrorMessage=False)
        ws.add_data_validation(dv)
        dv.add(f"B{first}:B{last + 20}")
        ws.conditional_formatting.add(f"M{first}:M{last}", CellIsRule(
            operator="notEqual", formula=['"มีใน Express"'], fill=PatternFill("solid", fgColor="FDECEC")))
        ws.auto_filter.ref = f"A3:O{last}"
    return links


def write_review_tab(wb, b, title: str, links: list[tuple]) -> int:
    from openpyxl.styles import PatternFill

    ws = b.sheet(title, REVIEW_HEADERS, [24, 7, 30, 6, 9, 18, 22, 32, 14, 22, 50])
    for i, (tab, row, model, r) in enumerate(links, start=2):
        ref = f"'{tab}'!"
        ws.cell(i, 1, model.name)
        ws.cell(i, 2, r.item_no)
        ws.cell(i, 3, r.name)
        if r.side:
            ws.cell(i, 4, r.side)
        ws.cell(i, 5, r.qty)
        if r.old_code:
            ws.cell(i, 6, r.old_code)
        ws.cell(i, 7, f'=IF({ref}B{row}="","",{ref}B{row})')
        ws.cell(i, 8, f'={ref}H{row}')
        ws.cell(i, 9, r.status)
        ws.cell(i, 10, f'={ref}M{row}')
        if r.alternatives:
            ws.cell(i, 11, " | ".join(r.alternatives))
        ws.cell(i, 9).fill = PatternFill("solid", fgColor=STATUS_FILLS.get(r.status, "FFFFFF"))
    b.style_body(ws, 2, len(links) + 1, len(REVIEW_HEADERS))
    ws.auto_filter.ref = f"A1:K{len(links) + 1}"
    return len(links)


_LEDGER = re.compile(r"ยกมา\s*(-?[\d.]+)\s*·\s*รับ\s*(-?[\d.]+)\s*·\s*จ่าย\s*(-?[\d.]+)")


def write_balance_tab(wb, b, title: str, stock: StockList, express: StockList) -> dict[str, int]:
    """อะไหล่กระบะ / สต๊อกเหล็ก with the Express code of each line."""
    from openpyxl.styles import PatternFill

    steel = any(_LEDGER.search(i.remark or "") for i in stock.items)
    headers = (["รหัสสินค้า", "รายการ", "ยอดยกมา", "ยอดรับเข้า", "รวมจ่าย", "ยอดคงเหลือ", "หน่วย", "ชื่อใน Express",
                "การจับคู่", "น้ำหนัก/แผ่น (kg)", "น้ำหนักคงเหลือ (kg)", "ตรวจยอด", "ตัวเลือกอื่น"] if steel else
               ["รหัสสินค้า", "รายการ", "ยอดคงเหลือ", "หน่วย", "ชื่อใน Express", "การจับคู่", "ตัวเลือกอื่น"])
    widths = [22, 40, 9, 9, 9, 10, 7, 40, 13, 11, 12, 12, 50] if steel else [22, 40, 10, 7, 40, 13, 50]
    ws = b.sheet(title, headers, widths)
    counts: dict[str, int] = {}
    for i, (item, (code, _ename, status, alts)) in enumerate(zip(stock.items, match_names(stock.items, express)),
                                                               start=2):
        counts[status] = counts.get(status, 0) + 1
        if code:
            ws.cell(i, 1, code)
        if status != NAME_EXACT:
            ws.cell(i, 1).fill = b.input_fill
        ws.cell(i, 2, item.name)
        lookup = f'=IF(A{i}="","",IFERROR(VLOOKUP(A{i},{b.master}!$A:$B,2,FALSE),"ไม่มีรหัสนี้ใน Express"))'
        if steel:
            m = _LEDGER.search(item.remark or "")
            b_f, rec, out = (float(x) for x in m.groups()) if m else (0, 0, 0)
            for c, v in enumerate([b_f, rec, out, item.on_hand, item.unit], start=3):
                ws.cell(i, c, v)
            ws.cell(i, 8, lookup)
            ws.cell(i, 9, status)
            ws.cell(i, 10, f'=IF(A{i}="","",IFERROR(INDEX({b.master}!$Y:$Y,MATCH(A{i},{b.master}!$A:$A,0)),""))')
            ws.cell(i, 11, f'=IF(ISNUMBER(J{i}),ROUND(F{i}*J{i},1),"")')
            ws.cell(i, 12, f'=IF(ROUND(C{i}+D{i}-E{i},3)=ROUND(F{i},3),"","ยอดไม่ตรง: ยกมา+รับ-จ่าย = "&(C{i}+D{i}-E{i}))')
            if alts:
                ws.cell(i, 13, " | ".join(alts))
            ws.cell(i, 9).fill = PatternFill("solid", fgColor=STATUS_FILLS.get(status, "E2F0D9"))
        else:
            ws.cell(i, 3, item.on_hand)
            ws.cell(i, 4, item.unit)
            ws.cell(i, 5, lookup)
            ws.cell(i, 6, status)
            if alts:
                ws.cell(i, 7, " | ".join(alts))
            ws.cell(i, 6).fill = PatternFill("solid", fgColor=STATUS_FILLS.get(status, "E2F0D9"))
    b.style_body(ws, 2, len(stock.items) + 1, len(headers))
    return counts


def build_partlist_express(path: str | Path, models: list[ModelBOM], express: StockList,
                           counted: StockList | None = None, xref: CodeXref | None = None,
                           balances: dict[str, StockList] | None = None, densities: dict[str, float] | None = None,
                           source: str = "STMASR0200") -> dict:
    """Write the workbook; returns match statistics."""
    from datetime import date

    from .item_form import build_item_form

    resolved = resolve_models(models, express)
    form_rows = new_item_rows(models, resolved, express, today=date.today().strftime("%d/%m/%Y"))
    stats = build_item_form(express, path, counted=counted, models=models, xref=xref, densities=densities,
                            source=source, resolved=resolved, form_rows=form_rows, balances=balances or {})
    stats["status"] = summary(resolved)
    stats["new_items"] = len(form_rows)
    stats["resolved"] = resolved
    return stats
