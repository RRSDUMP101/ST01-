"""จับคู่ชิ้นส่วนในแบบกับรายการในสต็อก – which stock item a Part List row (from a DWG) is.

The code in the drawing is the main key, but drawings and the stock file do not always use the same codes:
a drawing numbers its parts RRS-T-001, RRS-T-002 ... while Express has one code per model, size and side
(ราง 4 คู่หน้าเฟรมบน = RRS-A-003, บังอาย80 = RRS-T-024-80-L and RRS-A-024-80). The part number (024) is
usually the same, the rest is told by the name. So a part is looked up, first match wins:

1. the stock code written on the Part List row (รหัสสโตร์ – by a person or kept from an earlier check)
2. its own code in the stock file: as it is, cut to 16 characters (Express reports), or through the code
   cross-reference table (ตารางเทียบรหัส)
3. its name, with the analysis used for the model BOMs (express_codes): what the part is and where it sits,
   stall height, body length, left/right and model; the part number in its code weighs strongly.
   The model, stall height and body length come from the whole drawing (TOYOTA, เสา80, พื้น250).
   Express keeps the left and the right part apart: a flat pattern without a side is split between both.
4. nothing found: check_requirements falls back to the raw material (same material and thickness).

Every match says how it was found; a name match that is not clear is marked to check.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .express_codes import STALL_HEIGHTS
from .models import Part, PartList
from .stock import StockItem, StockList, _find_code, _key, find_by_code

M_STOCK_CODE = "รหัสสโตร์ใน Part List"
M_CODE = "รหัสตรง"
M_XREF = "ตารางเทียบรหัส"
M_NAME = "จับคู่จากชื่อ"
M_CHECK = "จากชื่อ – ควรตรวจ"
M_MATERIAL = "วัสดุ/ความหนา"
M_NONE = "ไม่พบ"
SURE = {M_STOCK_CODE, M_CODE, M_XREF, M_NAME, M_MATERIAL}
METHOD_ORDER = [M_NONE, M_CHECK, M_MATERIAL, M_NAME, M_XREF, M_CODE, M_STOCK_CODE]  # weakest first

NUMBER_WEIGHT = 3.0
_HEIGHT_PARTS = re.compile(r"(?:เสา|บังอาย|หน้าโปร|ซองเสา|แผ่นปิดเสา|ฉากฝาข้าง|คอก)\D{0,12}?(\d{2})(?!\d)")
_LENGTH_PARTS = re.compile(r"(?:พื้น|ข้างเฟรม|กระบะ)\D{0,6}?(2(?:[.,]\d{1,2}|\d{2}))(?!\d)")


@dataclass
class PartMatch:
    items: list[tuple[StockItem, float]] = field(default_factory=list)  # (item, share of the part's quantity)
    method: str = M_NONE
    score: float = 0
    alternatives: list[str] = field(default_factory=list)

    @property
    def item(self) -> StockItem | None:
        return self.items[0][0] if self.items else None

    @property
    def sure(self) -> bool:
        return self.method in SURE

    def describe(self, part: Part) -> str:
        """'RRS-T-024 บังอาย80 → RRS-T-024-80-L / RRS-A-024-80 (จับคู่จากชื่อ)'."""
        label = " ".join(x for x in (part.part_no, part.name) if x)
        if not self.items:
            alt = f" – ใกล้เคียง: {'; '.join(self.alternatives[:2])}" if self.alternatives else ""
            return f"{label}: ไม่พบในสต็อก{alt}"
        codes = " / ".join(i.code or i.name for i, _s in self.items)
        return f"{label} → {codes} ({self.method})"


@dataclass
class DrawingContext:
    """What the drawing says about the vehicle, used for every part of it."""
    text: str = ""  # model words: file name, drawing no., vehicle model, TOYOTA written on the drawing
    heights: set[str] = field(default_factory=set)  # stall heights of the parts: {"80"}
    lengths: set[str] = field(default_factory=set)  # body lengths: {"250"}


def drawing_contexts(partlist: PartList) -> dict[str, DrawingContext]:
    """drawing_no -> context, from the names of the parts of that drawing and the job header."""
    groups: dict[str, list[Part]] = {}
    for part in partlist.parts:
        groups.setdefault(part.drawing_no, []).append(part)
    info = partlist.info
    out = {}
    for drawing_no, parts in groups.items():
        names = " ".join(p.name for p in parts)
        files = " ".join(d.file_name + " " + d.title for d in partlist.drawings if d.drawing_no == drawing_no)
        ctx = DrawingContext(text=" ".join(x for x in (drawing_no, files, info.vehicle_model, info.drawing_no,
                                                         _model_words(names)) if x))
        ctx.heights = set(_HEIGHT_PARTS.findall(names)) & STALL_HEIGHTS
        ctx.lengths = {_length(v) for v in _LENGTH_PARTS.findall(names)} - {""}
        out[drawing_no] = ctx
    return out



def _length(text: str) -> str:
    v = float(text.replace(",", "."))
    v = v * 100 if v < 10 else v
    return f"{v:.0f}" if 200 <= v <= 260 else ""


def _model_words(names: str) -> str:
    upper = names.upper()
    return " ".join(w for w in ("TOYOTA", "CHAMP", "REVO", "ISUZU", "MITSU", "NISSAN", "พื้นเรียบ", "เครน")
                    if w in upper)


def match_parts(partlist: PartList, stock: StockList) -> list[tuple[Part, PartMatch]]:
    """Every row of the Part List with its stock item(s)."""
    contexts = drawing_contexts(partlist)
    return [(p, match_part(p, stock, contexts.get(p.drawing_no))) for p in partlist.parts]


def match_part(part: Part, stock: StockList, context: DrawingContext | None = None) -> PartMatch:
    """The stock item(s) of a Part List row – see the module text for the order."""
    if part.stock_code:  # 'RRS-A-027-L / RRS-A-027-R': a left and a right item, half each
        codes = [c.strip() for c in re.split(r"\s*/\s*|\s*,\s*", part.stock_code) if c.strip()]
        items = [find_by_code(c, stock) for c in codes]
        if items and all(items):
            return PartMatch([(i, 1 / len(items)) for i in items], M_STOCK_CODE, 99)
    if part.part_no:
        item = _find_code(part.part_no, stock)
        if item is not None:
            return PartMatch([(item, 1.0)], M_CODE, 99)
        item = find_by_code(part.part_no, stock)
        if item is not None:
            return PartMatch([(item, 1.0)], M_XREF, 99)
    if not part.name or part.process == "ซื้อสำเร็จ":
        return PartMatch()
    return match_by_name(part, stock, context or DrawingContext())


def match_by_name(part: Part, stock: StockList, context: DrawingContext) -> PartMatch:
    from .company_files import ModelBOM, ModelRow
    from .express_codes import ST_AUTO, ST_CHECK, ST_EXACT, _item_side, _side, model_context, resolve_row

    title = " ".join(sorted(context.lengths))  # body length: read from the title for every row
    model = ModelBOM(context.text, title)
    ctx = model_context(model)
    ctx.heights |= context.heights
    ctx.number_weight = NUMBER_WEIGHT
    row = ModelRow(item_no=part.item_no, raw_code=part.part_no, codes=[part.part_no] if part.part_no else [],
                   name=part.name, size=part.spec, qty=1, qty_text="1")
    pool = StockList(items=[i for i in stock.items if i.code])
    [best] = resolve_row(model, ctx, row, pool)[:1]
    if best.status not in (ST_AUTO, ST_CHECK, ST_EXACT) or not best.code:
        return _by_number(part, pool, ctx) or PartMatch(alternatives=best.alternatives)
    item = _find_code(best.code, pool)
    method = M_NAME if best.status in (ST_AUTO, ST_EXACT) else M_CHECK
    match = PartMatch([(item, 1.0)], method, best.score, best.alternatives)
    side = _item_side(item)
    if side and not _side(part.name):  # Express has left and right apart: half each
        other = _counterpart(item, side, pool)
        if other is not None:
            pair = [(item, 0.5), (other, 0.5)]
            match.items = sorted(pair, key=lambda t: _item_side(t[0]) != "L")
            match.alternatives = [a for a in match.alternatives if not a.startswith(other.code + " ")]
            if not match.alternatives and match.score >= 10.5:
                match.method = M_NAME  # the only close one was the other side
    return match


def _by_number(part: Part, pool: StockList, ctx) -> PartMatch | None:
    """Same part number and the Express name inside the drawing name (or the other way round):
    RRS-T-009 กระดูกข้างเฟรมบน -> RRS-T-009-L กระดูกข้าง T(ซ้าย) + RRS-T-009-R กระดูกข้าง T(ขวา). Marked to check."""
    from .express_codes import _brands, _core, _item_side, _side

    found = re.search(r"-(\d{3})(?=-|$)", (part.part_no or "").upper())
    core = _core(part.name)
    if not found or len(core) < 3:
        return None
    number = found.group(1)
    allowed = ctx.brands | {"2024"}
    hits = []
    for item in pool.items:
        if number not in item.code.upper().replace(" ", "").split("-")[2:]:
            continue
        item_core = _core(item.name)
        if len(item_core) < 3 or not (item_core in core or core in item_core):
            continue
        if _brands(item.name, item.code) - allowed:  # another model
            continue
        hits.append(item)
    own = [i for i in hits if _brands(i.name, i.code) & ctx.brands]
    if own:  # the drawing's model first, items for every model only when it has none
        hits = own
    want = _side(part.name)
    if want:
        hits = [i for i in hits if _item_side(i) in (want, "")]
    sides = {_item_side(i) for i in hits}
    if len(hits) == 1 or (len(hits) == 2 and sides == {"L", "R"} and not want):
        hits.sort(key=lambda i: _item_side(i) != "L")
        return PartMatch([(i, 1 / len(hits)) for i in hits], M_CHECK, 8.0)
    return None


def _counterpart(item: StockItem, side: str, stock: StockList) -> StockItem | None:
    """The other side of a left/right part: by the code (…-L ↔ …-R), else by the name (ซ้าย ↔ ขวา)."""
    other_side = "R" if side == "L" else "L"
    parts = item.code.split("-")
    for i in range(len(parts) - 1, 1, -1):
        if parts[i].upper() == side:
            swapped = "-".join(parts[:i] + [other_side] + parts[i + 1:])
            found = _find_code(swapped, stock)
            if found is not None and found is not item:
                return found
    a, b = ("ซ้าย", "ขวา") if side == "L" else ("ขวา", "ซ้าย")
    if a in item.name:
        want = _key(item.name.replace(a, b))
        for cand in stock.items:
            if cand is not item and _key(cand.name) == want:
                return cand
    return None


def weakest(methods: list[str]) -> str:
    known = [m for m in methods if m in METHOD_ORDER]
    return min(known, key=METHOD_ORDER.index) if known else ""
