"""Matching of foreign column headers (ZWCAD tables/attributes, Google Sheet, Excel) to Part fields."""

from __future__ import annotations

import re

from .models import COLUMN_KEYS, COLUMN_LABELS

# Header names seen in ZWCAD (ZW2D) BOM tables, Data Extraction / TABLEEXPORT
# CSV files, title-block attribute tags and company spreadsheets.
# Compared after normalize().
ALIASES: dict[str, list[str]] = {
    "item_no": ["item", "item no", "index", "no", "seq", "序号", "ลำดับ", "ที่"],
    "part_no": ["part number", "part no", "partno", "part code", "code", "代号",
                "零件编号", "รหัสชิ้นส่วน", "รหัส"],
    "drawing_no": ["drawing no", "drawing number", "dwg no", "dwgno", "dwg", "drg no", "图号",
                   "เลขที่แบบ", "เลขแบบ"],
    "name": ["name", "part name", "description", "desc", "component", "名称", "零件名称",
             "ชื่อชิ้นส่วน", "ชื่อ", "รายการ"],
    "material": ["material", "mat", "材料", "材质", "วัสดุ"],
    "spec": ["spec", "specification", "size", "dimension", "规格", "ขนาด/ความหนา", "ขนาด", "สเปก"],
    "thickness": ["thickness", "thk", "t", "t (mm)", "厚度", "板厚", "ความหนา", "หนา", "หนา (mm)",
                  "ความหนา (mm)"],
    "qty": ["qty", "quantity", "count", "数量", "จำนวน"],
    "unit": ["unit", "uom", "单位", "หน่วย"],
    "weight": ["mass", "weight", "unit mass", "重量", "质量", "น้ำหนัก (kg)", "น้ำหนัก"],
    "stock_code": ["stock code", "item code", "material code", "rm code", "sku", "รหัสสโตร์",
                   "รหัสสินค้า", "รหัสวัตถุดิบ"],
    "process": ["process", "operation", "工艺", "กระบวนการ", "ขั้นตอน"],
    "status": ["status", "state", "状态", "สถานะ"],
    "remark": ["remark", "remarks", "note", "notes", "comment", "备注", "หมายเหตุ"],
}

# English headers written for files going back to ZWCAD (table / data link).
CAD_HEADERS: dict[str, str] = {
    "item_no": "Item",
    "part_no": "Part Number",
    "drawing_no": "Drawing No",
    "name": "Name",
    "material": "Material",
    "spec": "Specification",
    "thickness": "Thickness",
    "qty": "Quantity",
    "unit": "Unit",
    "weight": "Mass",
    "stock_code": "Stock Code",
    "process": "Process",
    "status": "Status",
    "remark": "Remark",
}


def normalize(header) -> str:
    text = "" if header is None else str(header)
    text = text.replace("\ufeff", "").strip().lower()
    text = re.sub(r"[\s_.:#\-]+", " ", text).strip()
    return text


_LOOKUP: dict[str, str] = {}
for _key, _names in ALIASES.items():
    for _name in _names + [COLUMN_LABELS[_key], CAD_HEADERS[_key], _key]:
        _LOOKUP.setdefault(normalize(_name), _key)


def match_header(header) -> str | None:
    """Return the Part field for a header, or None if unknown."""
    norm = normalize(header)
    if not norm:
        return None
    if norm in _LOOKUP:
        return _LOOKUP[norm]
    # "Mass (kg)", "Qty." , "Material [SS400]" ...
    stripped = re.sub(r"[\(\[].*?[\)\]]", "", norm).strip()
    return _LOOKUP.get(stripped)


def auto_map(headers: list) -> dict[int, str]:
    """Map column index -> Part field. Each field is used at most once (first wins)."""
    mapping: dict[int, str] = {}
    used: set[str] = set()
    for idx, header in enumerate(headers):
        key = match_header(header)
        if key and key not in used:
            mapping[idx] = key
            used.add(key)
    return mapping


def score_header_row(row: list) -> int:
    return len(auto_map(row))


def find_header_row(rows: list[list], scan: int = 20) -> int:
    """Index of the row that looks most like a header (CAD tables often have a title row above it)."""
    best, best_score = 0, 0
    for i, row in enumerate(rows[:scan]):
        score = score_header_row(row)
        if score > best_score:
            best, best_score = i, score
    return best


__all__ = ["ALIASES", "CAD_HEADERS", "COLUMN_KEYS", "auto_map", "find_header_row", "match_header", "normalize"]
