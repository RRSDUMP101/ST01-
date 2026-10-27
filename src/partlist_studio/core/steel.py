"""สต็อกเหล็ก - the raw-material plates, bars and tubes the laser and the shop cut from.

The steel register (ไฟล์สต็อกเหล็ก: the ทะเบียนสินค้า tab of the ฟอร์มทะเบียนสินค้า, or any file with its columns
รหัสสินค้า · ชื่อสินค้า · กลุ่มวัสดุ · ความหนา (มม.) · กว้าง (มม.) · ยาว (มม.) · รหัสนับสต็อก) gives every item its
material, thickness and plate size. The balance is the one of the stock - Express, the ไฟล์นับสต๊อค, the documents
of this program - by the item's code: a register without balances gives way to a list that has them (AppState
merges the sources and fills in the size). This module makes the store's view of it: weight per piece and on hand,
the sheets the laser queue still has to cut from each plate, and what is left after them.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .models import parse_thickness
from .stock import MATERIAL_FAMILIES, StockItem, StockList, _key, item_size_mm

SOURCE_PREFIX = "สต็อกเหล็ก: "
FORM_SHEET, FORM_BAR, FORM_OTHER = "แผ่น", "เส้น / ท่อ", "อื่นๆ"
ST_OK, ST_LOW, ST_SHORT, ST_EMPTY, ST_NO_BALANCE = "พอ", "ต่ำกว่า Min", "ขาด", "หมด", "ยังไม่มียอด"
STATUSES = [ST_SHORT, ST_EMPTY, ST_LOW, ST_NO_BALANCE, ST_OK]
FAMILY_NAMES = {"STEEL": "เหล็ก", "SUS": "สแตนเลส", "AL": "อลูมิเนียม", "GALV": "เหล็กชุบ"}
_DENSITY_KEY = {"STEEL": "SS400", "SUS": "SUS", "AL": "AL", "GALV": "SGCC"}
_BAR_UNITS = {"เส้น", "สน", "ท่อน", "ม.", "เมตร"}
_BAR_WORDS = ("ท่อ", "แป๊ป", "กล่อง", "แฟลตบาร์", "FB", "เพลา", "ราง", "ฉาก", "ไวร์", "ตะแกรงเหล็ก")
HEADERS = ["รหัสสินค้า", "ชื่อสินค้า", "วัสดุ", "รูปแบบ", "หนา (มม.)", "กว้าง × ยาว (มม.)", "หน่วย", "คงเหลือ",
           "กก./หน่วย", "น้ำหนักคงเหลือ (กก.)", "คิวเลเซอร์ใช้", "เหลือหลังตัด", "Min", "สถานะ", "ยอดจาก"]


def family_of(item: StockItem) -> str:
    """STEEL / SUS / AL / GALV from the material (กลุ่มวัสดุ) or the name, '' when it is no metal stock."""
    text = (item.material or "") + " " + (item.name or "")
    upper = text.upper().replace(" ", "")
    for fam, words in MATERIAL_FAMILIES:
        if any(w.upper() in upper for w in words):
            return fam
    if any(w in text for w in ("ท่อ", "แฟลตบาร์", "ตะแกรง")):
        return "STEEL"
    return ""


def is_steel(item: StockItem) -> bool:
    """A raw material of metal: a code of the raw-material families (01-B00 เหล็กแผ่น, 03-S00 สแตนเลส, 04-B00 ท่อ …),
    a row of a steel register, or a plate without a code (the สต๊อกเหล็ก tab of the company file)."""
    from .catalog import item_type

    if not family_of(item):
        return False
    kind = item_type(item.code, item.name, item.unit)
    if kind == "RM" or item.extra.get("width_mm") or item.extra.get("item_kind") == "วัตถุดิบ":
        return True
    return not item.code and item.is_sheet


def form_of(item: StockItem) -> str:
    if item.is_sheet:
        return FORM_SHEET
    if item.unit.strip() in _BAR_UNITS or any(w in item.name for w in _BAR_WORDS):
        return FORM_BAR
    return FORM_OTHER


def kg_each(item: StockItem, densities: dict[str, float] | None = None) -> float:
    """Weight of one plate: width × length × thickness × density (0 for bars and plates without a size)."""
    from .dwg_io import density_for

    if not item.is_sheet:
        return 0.0
    size, thk = item_size_mm(item), parse_thickness(item.spec)
    if not size or not thk:
        return 0.0
    density = density_for(_DENSITY_KEY.get(family_of(item), item.material or "SS400"), densities)
    return round(size[0] * size[1] * thk * density * 1e-6, 2)


@dataclass
class SteelLine:
    item: StockItem
    family: str
    form: str
    thickness: float
    width: float
    length: float
    kg_each: float
    reserved: float = 0  # sheets the laser queue still has to cut from this plate
    counted: bool = True  # the balance comes from a list with balances or from documents of this program
    source: str = ""

    @property
    def on_hand(self) -> float:
        return self.item.on_hand

    @property
    def kg_total(self) -> float:
        return round(self.kg_each * max(0.0, self.on_hand), 1)

    @property
    def after(self) -> float:
        return round(self.on_hand - self.reserved, 3)

    @property
    def status(self) -> str:
        if not self.counted and not self.on_hand:
            return ST_SHORT if self.reserved else ST_NO_BALANCE
        if self.after < 0:
            return ST_SHORT
        if self.on_hand <= 0:
            return ST_EMPTY
        if self.item.min_qty and self.after < self.item.min_qty:
            return ST_LOW
        return ST_OK


def reserved_sheets(programs) -> dict[str, float]:
    """Stock code -> sheets still to cut in the laser queue (waiting or being cut)."""
    from .laser import OPEN

    out: dict[str, float] = {}
    for prog in programs or []:
        if prog.status in OPEN and prog.sheet_code:
            left = max(0, prog.repeat - prog.cut_sheets)
            out[_key(prog.sheet_code)] = out.get(_key(prog.sheet_code), 0) + left
    return out


def steel_lines(stock: StockList, programs=None, densities: dict[str, float] | None = None,
                origin: dict[int, tuple[str, bool]] | None = None) -> list[SteelLine]:
    """The steel items of the (merged) stock, plates first, by material and thickness.
    origin: id(item) -> (source name, the source has balances)."""
    reserved = reserved_sheets(programs)
    out = []
    for item in stock.items:
        if not is_steel(item):
            continue
        size = item_size_mm(item) if item.is_sheet else None
        w, h = sorted(size) if size else (0.0, 0.0)
        source, counted = (origin or {}).get(id(item), ("", True))
        out.append(SteelLine(item, family_of(item), form_of(item), parse_thickness(item.spec), w, h,
                             kg_each(item, densities), reserved.get(_key(item.code), 0) if item.code else 0,
                             counted, source))
    order = {FORM_SHEET: 0, FORM_BAR: 1, FORM_OTHER: 2}
    families = {fam: n for n, fam in enumerate(FAMILY_NAMES)}
    out.sort(key=lambda s: (order[s.form], families.get(s.family, 9), s.thickness, s.width * s.length, s.item.code))
    return out


def rows(lines: list[SteelLine]) -> list[list]:
    def num(v: float) -> str:
        return f"{v:g}" if v else ""

    return [[s.item.code, s.item.name, FAMILY_NAMES.get(s.family, s.family), s.form, num(s.thickness),
             f"{s.width:g} × {s.length:g}" if s.width else "", s.item.unit_name, s.on_hand if s.counted else "",
             s.kg_each or "", s.kg_total or "", num(s.reserved), s.after if (s.counted or s.reserved) else "",
             num(s.item.min_qty), s.status, s.source] for s in lines]


def summary(lines: list[SteelLine]) -> str:
    plates = [s for s in lines if s.form == FORM_SHEET]
    kg = sum(s.kg_total for s in lines)
    short = sum(1 for s in lines if s.status in (ST_SHORT, ST_EMPTY, ST_LOW))
    return (f"{len(lines)} รายการ · แผ่น {len(plates)} · เส้น/ท่อ {sum(1 for s in lines if s.form == FORM_BAR)} · "
            f"คงเหลือ {sum(s.on_hand for s in plates if s.counted):g} แผ่น (≈ {kg:,.0f} กก.)"
            + (f" · ต้องสั่ง/ตรวจ {short} รายการ" if short else ""))


def read_register(path: str | Path) -> StockList:
    """A steel stock file: every sheet of the workbook is looked at, the one with the stock table is read."""
    stock = StockList.from_file(path)
    stock.source = str(path)
    return stock


def export_lines(lines: list[SteelLine], path: str | Path, title: str = "") -> None:
    from .tabular import Sheet, write_workbook

    write_workbook(path, [Sheet("สต็อกเหล็ก", HEADERS, rows(lines),
                                title_rows=[[title or "สต็อกเหล็ก (แผ่น / เส้น / ท่อ)"], [summary(lines)]])])
