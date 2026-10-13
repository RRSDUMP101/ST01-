"""The company's own Excel files, read and written in their existing layouts.

* "7. รายการชิ้นส่วนประกอบกระบะ Parts List All Model.xlsx"
    - one sheet per bed / frame model: ลำดับ | รหัส | รายการ | ภาพประกอบ | ขนาด | จำนวนที่ใช้ | หมายเหตุ
      (quantities like "1+1" = left + right, codes like "RRS-T-028,029" or "RRS-T018", pictures in ภาพประกอบ)
    - "อะไหล่กระบะ": balances written as text ("3 คัน", "68 อัน")
    - "สต๊อกเหล็ก": steel ledger ลำดับ | รายการ | ยอดยกมา | ยอดรับเข้า | จ่ายออก (one column per day) | รวมจ่าย | คงเหลือ
* "10. รายการ Stock ชิ้นส่วนกระบะดั้มพ์.นับสต๊อค.xls"
    - "STBALLL": รหัสสินค้า | รายการ | จำนวน | หน่วย | หมายเหตุ  (codes 01-0001-0001 ...)
    - "Format Stock R1": the printed count form with Minimum (pcs.) and ยอดคงเหลือ (pcs.)
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path, PurePosixPath

from .mapping import normalize
from .models import Part, PartList, to_number
from .stock import StockItem, StockList, RequirementLine, ST_MISSING
from .tabular import Sheet, read_table, write_workbook

SHEET_BOM = "bom"
SHEET_STOCK = "stock"
SHEET_STEEL = "steel"
SHEET_PARTS_BALANCE = "parts_balance"
SHEET_UNKNOWN = "unknown"
SHEET_KIND_LABELS = {
    SHEET_BOM: "Part List แบบกระบะ",
    SHEET_STOCK: "สต็อกชิ้นส่วน (มีรหัส)",
    SHEET_STEEL: "สต๊อกเหล็ก (ยกมา/รับ/จ่าย/คงเหลือ)",
    SHEET_PARTS_BALANCE: "ยอดอะไหล่กระบะ",
    SHEET_UNKNOWN: "ไม่รู้จัก",
}

BOM_HEADER = ["ลำดับ", "รหัส", "รายการ", "ภาพประกอบ", "ขนาด", "จำนวนที่ใช้", "หมายเหตุ"]


def _clean(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()


# --------------------------------------------------------------------------
# Codes and quantities as typed in the company files
# --------------------------------------------------------------------------
def normalize_code(code: str) -> str:
    """'RRS-T018' -> 'RRS-T-018', 'RRS-A_102' -> 'RRS-A-102', 'RRS-A--033' -> 'RRS-A-033', '( R)' -> '(R)'."""
    text = _clean(code).upper().replace("_", "-").replace(" ", "")
    text = re.sub(r"-{2,}", "-", text)
    text = re.sub(r"^([A-Z]{2,4}-[A-Z]\d?)(\d{3})", r"\1-\2", text)
    return text.strip("-")


def base_code(code: str) -> str:
    """Without the size/side suffix: 'RRS-T-017(40)' -> 'RRS-T-017'."""
    return re.sub(r"\(.*?\)", "", normalize_code(code)).strip("-")


def split_codes(raw: str) -> list[str]:
    """'RRS-T-028,029' -> ['RRS-T-028', 'RRS-T-029'];
    'RRS-A-029-เสาหน้า , RRS-A-028-เสาหลัง' -> ['RRS-A-029', 'RRS-A-028']."""
    out: list[str] = []
    for piece in re.split(r"[,/]|\s+และ\s+", _clean(raw)):
        piece = re.sub(r"[-\s]*[฀-๿].*$", "", piece.strip())  # trailing Thai words
        if not piece:
            continue
        if re.fullmatch(r"\d{2,3}(\(.*\))?", piece) and out:  # "029" continues the previous code
            prefix = out[-1].rsplit("-", 1)[0]
            piece = f"{prefix}-{piece}"
        code = normalize_code(piece)
        if code and code not in out:
            out.append(code)
    return out


def parse_qty(text) -> tuple[float, str]:
    """'1+1' -> (2, 'ซ้าย+ขวา 1+1'); '6' -> (6, ''); '' -> (1, 'ไม่ระบุจำนวน')."""
    raw = _clean(text)
    if not raw or raw == "0":
        return (1, "ไม่ระบุจำนวน") if not raw else (0, "")
    nums = re.findall(r"\d+(?:\.\d+)?", raw)
    if "+" in raw and nums:
        return sum(float(n) for n in nums), raw
    return to_number(raw) or 1, ""


# --------------------------------------------------------------------------
# Model BOM library
# --------------------------------------------------------------------------
@dataclass
class ModelRow:
    item_no: str = ""
    raw_code: str = ""
    codes: list[str] = field(default_factory=list)
    name: str = ""
    size: str = ""
    qty_text: str = ""
    qty: float = 1
    remark: str = ""
    image: str = ""

    @property
    def code(self) -> str:
        return self.codes[0] if self.codes else ""


@dataclass
class ModelBOM:
    name: str
    title: str = ""
    rows: list[ModelRow] = field(default_factory=list)
    source: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> ModelBOM:
        rows = [ModelRow(**{k: v for k, v in r.items() if k in ModelRow.__dataclass_fields__})
                for r in data.get("rows", [])]
        return cls(name=data.get("name", ""), title=data.get("title", ""), rows=rows, source=data.get("source", ""))

    def to_parts(self, sets: float = 1) -> list[Part]:
        parts = []
        for r in self.rows:
            remarks = [r.remark]
            if len(r.codes) > 1:
                remarks.append("รหัสร่วม " + ", ".join(r.codes[1:]))
            if r.qty_text:
                remarks.append(f"จำนวน {r.qty_text}")
            parts.append(Part(item_no=r.item_no, part_no=r.code, drawing_no=self.name, name=r.name, spec=r.size,
                              qty=r.qty * sets, unit="ชิ้น", remark=" · ".join(x for x in remarks if x),
                              image=r.image))
        return parts


def parse_bom_sheet(name: str, rows: list[list], images: dict[int, str] | None = None) -> ModelBOM:
    """rows are raw sheet rows (index = Excel row - 1) so pictures can be matched by row."""
    images = images or {}
    model = ModelBOM(name=name)
    header_cols: dict[str, int] | None = None
    for idx, row in enumerate(rows):
        cells = [_clean(c) for c in row]
        if not any(cells):
            continue
        if not model.title and len([c for c in cells if c]) == 1 and "ลำดับ" not in cells:
            model.title = cells[0] if cells[0] else next(c for c in cells if c)
            continue
        if "รหัส" in cells and "รายการ" in cells:
            header_cols = {normalize(c): i for i, c in enumerate(cells) if c}
            continue
        if header_cols is None:
            continue

        def col(label, cells=cells):
            i = header_cols.get(normalize(label))
            return cells[i] if i is not None and i < len(cells) else ""

        name_cell, code_cell = col("รายการ"), col("รหัส")
        if not name_cell and not code_cell:
            continue
        qty, qty_text = parse_qty(col("จำนวนที่ใช้"))
        model.rows.append(ModelRow(item_no=col("ลำดับ"), raw_code=code_cell, codes=split_codes(code_cell),
                                   name=name_cell, size=col("ขนาด"), qty_text=qty_text, qty=qty,
                                   remark=col("หมายเหตุ"), image=images.get(idx, "")))
    return model


def models_from_partlist(partlist: PartList, name: str = "") -> ModelBOM:
    rows = [ModelRow(item_no=p.item_no, raw_code=p.part_no, codes=[p.part_no] if p.part_no else [], name=p.name,
                     size=p.spec, qty=p.qty, remark=p.remark, image=p.image) for p in partlist.parts]
    info = partlist.info
    title = name or "รายการชิ้นส่วนประกอบ " + " ".join(x for x in (info.job_type, info.vehicle_model) if x)
    return ModelBOM(name=name or info.drawing_no or "Part List", title=title, rows=rows)


def bom_sheet(model: ModelBOM) -> Sheet:
    rows, images = [], {}
    for i, r in enumerate(model.rows):
        rows.append([r.item_no or str(i + 1), r.raw_code or ", ".join(r.codes), r.name, "", r.size,
                     r.qty_text or (f"{r.qty:g}" if r.qty else ""), r.remark])
        if r.image:
            images[i] = r.image
    return Sheet(model.name, BOM_HEADER, rows, title_rows=[[model.title or model.name]], images=images,
                 image_col=3, blank_after_title=False)


def export_models(models: list[ModelBOM], path: str | Path) -> None:
    """Same layout as 'Parts List All Model' (one sheet per model, pictures in ภาพประกอบ)."""
    write_workbook(path, [bom_sheet(m) for m in models])


# --------------------------------------------------------------------------
# Pictures inside the workbook
# --------------------------------------------------------------------------
_NS = {
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
}


def _rels(z: zipfile.ZipFile, part: str) -> dict[str, str]:
    p = PurePosixPath(part)
    rel_path = str(p.parent / "_rels" / (p.name + ".rels"))
    if rel_path not in z.namelist():
        return {}
    root = ET.fromstring(z.read(rel_path))
    out = {}
    for rel in root.findall("rel:Relationship", _NS):
        target = rel.get("Target", "")
        resolved = PurePosixPath(target[1:]) if target.startswith("/") else p.parent / target
        parts: list[str] = []
        for seg in resolved.parts:
            if seg == "..":
                parts.pop()
            elif seg != ".":
                parts.append(seg)
        out[rel.get("Id")] = "/".join(parts)
    return out


def extract_images(path: str | Path, out_dir: str | Path, max_px: int = 640) -> dict[str, dict[int, str]]:
    """{sheet name: {row index (0-based): saved picture}} for pictures anchored in cells."""
    path, out_dir = Path(path), Path(out_dir)
    result: dict[str, dict[int, str]] = {}
    with zipfile.ZipFile(path) as z:
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        wb_rels = _rels(z, "xl/workbook.xml")
        for sheet in wb.findall("main:sheets/main:sheet", _NS):
            name = sheet.get("name")
            sheet_part = wb_rels.get(sheet.get(f"{{{_NS['r']}}}id"), "")
            for drawing_part in [t for t in _rels(z, sheet_part).values() if "/drawings/" in t]:
                media = _rels(z, drawing_part)
                root = ET.fromstring(z.read(drawing_part))
                for anchor in list(root):
                    frm = anchor.find("xdr:from", _NS)
                    blip = anchor.find(".//a:blip", _NS)
                    if frm is None or blip is None:
                        continue
                    row = int(frm.find("xdr:row", _NS).text)
                    target = media.get(blip.get(f"{{{_NS['r']}}}embed"))
                    if not target or target not in z.namelist():
                        continue
                    sheet_dir = out_dir / re.sub(r'[\\/:*?"<>|]', "_", name)
                    sheet_dir.mkdir(parents=True, exist_ok=True)
                    dest = sheet_dir / f"row{row + 1:03d}{Path(target).suffix.lower()}"
                    saved = _save_picture(z.read(target), dest, max_px)
                    result.setdefault(name, {}).setdefault(row, str(saved))
    return result


def _save_picture(data: bytes, dest: Path, max_px: int) -> Path:
    """Saves a reduced JPEG copy (the workbook keeps full-size photos). Returns the file written."""
    try:
        from io import BytesIO

        from PIL import Image

        img = Image.open(BytesIO(data))
        img.thumbnail((max_px, max_px))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        jpg = dest.with_suffix(".jpg")
        img.save(jpg, "JPEG", quality=85)
        return jpg
    except Exception:  # noqa: BLE001 - keep the original bytes if Pillow cannot read it
        dest.write_bytes(data)
        return dest


# --------------------------------------------------------------------------
# Stock sheets
# --------------------------------------------------------------------------
@dataclass
class SteelLedger:
    """'สต๊อกเหล็ก' sheet: items without codes, a column per issue date."""

    stock: StockList
    dates: list[str] = field(default_factory=list)


def parse_steel_sheet(rows: list[list], source: str = "") -> SteelLedger:
    header_idx = next(i for i, r in enumerate(rows) if "ยอดยกมา" in [_clean(c) for c in r])
    header = [_clean(c) for c in rows[header_idx]]
    sub = [_clean(c) for c in rows[header_idx + 1]] if header_idx + 1 < len(rows) else []
    col = {name: header.index(name) for name in ("รายการ", "ยอดยกมา", "ยอดรับเข้า", "รวมจ่าย", "คงเหลือ")
           if name in header}
    issue_from = header.index("จ่ายออก") if "จ่ายออก" in header else None
    issue_to = col.get("รวมจ่าย", len(header))
    dates = [_date_text(c) for c in sub[issue_from:issue_to]] if issue_from is not None else []
    items = []
    for row in rows[header_idx + 2:]:
        cells = list(row) + [None] * (len(header) - len(row))
        name = _clean(cells[col["รายการ"]])
        if not name:
            continue
        b_f, rec, out = (to_number(cells[col[k]]) if k in col else 0 for k in ("ยอดยกมา", "ยอดรับเข้า", "รวมจ่าย"))
        bal_cell = cells[col["คงเหลือ"]] if "คงเหลือ" in col else None
        balance = to_number(bal_cell) if _clean(bal_cell) != "" else b_f + rec - out
        unit = "แผ่น" if "แผ่น" in name else "เส้น"
        item = StockItem(name=name, unit=unit, on_hand=balance,
                         remark=f"ยกมา {b_f:g} · รับ {rec:g} · จ่าย {out:g}")
        item.infer_from_name()
        items.append(item)
    return SteelLedger(StockList(items=items, source=source), dates)


def _date_text(value) -> str:
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    return _clean(value)[:10]


def export_stock_count(stock: StockList, path: str | Path, section: str = "RRS Dump") -> None:
    """Both sheets of '10. รายการ Stock ชิ้นส่วนกระบะดั้มพ์.นับสต๊อค' (STBALLL and Format Stock R1)."""
    stball = [[i.code, i.name, i.on_hand, i.unit, i.remark] for i in stock.items]
    form = [[i.code, i.name, i.min_qty or "", i.on_hand, i.unit, i.remark] for i in stock.items]
    write_workbook(path, [
        Sheet("STBALLL", ["รหัสสินค้า", "รายการ", "จำนวน", "หน่วย", "หมายเหตุ"], stball),
        Sheet("Format Stock R1", ["รหัสสินค้า", "รายการ", "Minimum (pcs.)", "ยอดคงเหลือ (pcs.)", "ยอดคงเหลือ",
                                  "หมายเหตุ"], form,
              title_rows=[["Rungrueng group"], [f"Section :  {section}"], []]),
    ])


def export_steel_issue(lines: list[RequirementLine], ledger: StockList, path: str | Path,
                       reference: str = "", issue_date: date | None = None) -> int:
    """Sheets to issue for this job, named exactly like the rows of 'สต๊อกเหล็ก' so the store can
    write them in that day's จ่ายออก column."""
    from .stock import _key

    names = {_key(i.name): i.name for i in ledger.items}
    rows = []
    for line in lines:
        if line.status == ST_MISSING or line.required <= 0:
            continue
        if line.unit not in ("แผ่น", "ผน", "เส้น", "สน") and _key(line.name) not in names:
            continue
        rows.append([len(rows) + 1, names.get(_key(line.name), line.name), _ceil(line.required), line.unit,
                     line.on_hand, line.on_hand - _ceil(line.required)])
    when = (issue_date or date.today()).strftime("%d/%m/%Y")
    write_workbook(path, [Sheet("จ่ายเหล็ก", ["ลำดับ", "รายการ", "จ่ายออก", "หน่วย", "คงเหลือก่อนจ่าย",
                                             "คงเหลือหลังจ่าย"], rows,
                                title_rows=[[f"ใบจ่ายเหล็กเพื่อผลิต (สำหรับลงช่องจ่ายออกวันที่ {when} ในแท็บ สต๊อกเหล็ก)"],
                                            ["อ้างอิง", reference]])])
    return len(rows)


def _ceil(value: float) -> int:
    import math

    return math.ceil(round(value, 6))


# --------------------------------------------------------------------------
# Whole workbook
# --------------------------------------------------------------------------
@dataclass
class CompanyWorkbook:
    path: str
    kinds: dict[str, str] = field(default_factory=dict)  # sheet -> kind
    models: list[ModelBOM] = field(default_factory=list)
    stocks: dict[str, StockList] = field(default_factory=dict)  # sheet -> stock list
    steel_dates: dict[str, list[str]] = field(default_factory=dict)


def classify(rows: list[list]) -> str:
    for row in rows[:12]:
        cells = {_clean(c) for c in row}
        if "ยอดยกมา" in cells and ("คงเหลือ" in cells or "จ่ายออก" in cells):
            return SHEET_STEEL
        if "รหัส" in cells and "รายการ" in cells and ("จำนวนที่ใช้" in cells or "ภาพประกอบ" in cells):
            return SHEET_BOM
        if "รหัสสินค้า" in cells and ({"จำนวน", "หน่วย"} & cells or any("ยอดคงเหลือ" in c for c in cells)):
            return SHEET_STOCK
        if "รายการ" in cells and "ยอดคงเหลือ" in cells:
            return SHEET_PARTS_BALANCE
    return SHEET_UNKNOWN


def sheet_names(path: str | Path) -> list[str]:
    path = Path(path)
    if path.suffix.lower() == ".xls":
        import xlrd

        return xlrd.open_workbook(str(path), on_demand=True).sheet_names()
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True)
    names = wb.sheetnames
    wb.close()
    return names


def _raw_rows(path: Path, sheet: str) -> list[list]:
    """All rows including empty ones, so row numbers match the pictures."""
    if path.suffix.lower() == ".xls":
        import xlrd

        ws = xlrd.open_workbook(str(path)).sheet_by_name(sheet)
        return [ws.row_values(i) for i in range(ws.nrows)]
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = [list(r) for r in wb[sheet].iter_rows(values_only=True)]
    wb.close()
    return rows


def read_company_workbook(path: str | Path, image_dir: str | Path | None = None) -> CompanyWorkbook:
    path = Path(path)
    book = CompanyWorkbook(path=str(path))
    images = {}
    if image_dir and path.suffix.lower() in (".xlsx", ".xlsm"):
        try:
            images = extract_images(path, image_dir)
        except Exception:  # noqa: BLE001 - pictures are optional
            images = {}
    for name in sheet_names(path):
        rows = _raw_rows(path, name)
        kind = classify(rows)
        book.kinds[name] = kind
        source = f"{path.name} / {name}"
        if kind == SHEET_BOM:
            model = parse_bom_sheet(name, rows, images.get(name))
            model.source = source
            if model.rows:
                book.models.append(model)
        elif kind == SHEET_STEEL:
            ledger = parse_steel_sheet(rows, source)
            book.stocks[name] = ledger.stock
            book.steel_dates[name] = ledger.dates
        elif kind in (SHEET_STOCK, SHEET_PARTS_BALANCE):
            stock = StockList.from_rows(read_table(path, name), source=source)
            if stock.items:
                book.stocks[name] = stock
    return book


# --------------------------------------------------------------------------
# All models as one flat table (Google Sheet tab)
# --------------------------------------------------------------------------
MODELS_FLAT_HEADER = ["แบบ", "ชื่อแบบ", "ลำดับ", "รหัส", "รายการ", "ขนาด", "จำนวนที่ใช้", "หมายเหตุ"]


def models_to_rows(models: list[ModelBOM]) -> list[list]:
    rows = [MODELS_FLAT_HEADER]
    for m in models:
        for r in m.rows:
            rows.append([m.name, m.title, r.item_no, r.raw_code or ", ".join(r.codes), r.name, r.size,
                         r.qty_text or (f"{r.qty:g}" if r.qty else ""), r.remark])
    return rows


def models_from_rows(rows: list[list], images_from: list[ModelBOM] | None = None) -> list[ModelBOM]:
    """Inverse of models_to_rows. Pictures are kept from the models already in the program."""
    pictures = {(m.name, _clean(r.item_no), r.name): r.image for m in images_from or [] for r in m.rows if r.image}
    header_idx = next((i for i, r in enumerate(rows[:10]) if "แบบ" in [_clean(c) for c in r]), 0)
    header = [_clean(c) for c in rows[header_idx]]
    col = {h: i for i, h in enumerate(header)}
    models: dict[str, ModelBOM] = {}
    for raw in rows[header_idx + 1:]:
        cells = [_clean(c) for c in raw] + [""] * len(header)
        name = cells[col.get("แบบ", 0)]
        if not name:
            continue
        model = models.setdefault(name, ModelBOM(name=name, title=cells[col["ชื่อแบบ"]] if "ชื่อแบบ" in col else ""))
        qty, qty_text = parse_qty(cells[col.get("จำนวนที่ใช้", 6)])
        code = cells[col.get("รหัส", 3)]
        item_no, part_name = cells[col.get("ลำดับ", 2)], cells[col.get("รายการ", 4)]
        model.rows.append(ModelRow(item_no=item_no, raw_code=code, codes=split_codes(code), name=part_name,
                                   size=cells[col.get("ขนาด", 5)], qty_text=qty_text, qty=qty,
                                   remark=cells[col.get("หมายเหตุ", 7)],
                                   image=pictures.get((name, item_no, part_name), "")))
    return list(models.values())
