"""จับคู่ชิ้นส่วนในแบบกับรายการในสต็อก – which stock item a Part List row (from a DWG) is.

The code in the drawing is the main key, but drawings and the stock file do not always use the same codes:
a drawing numbers its parts RRS-T-001, RRS-T-002 ... while Express has one code per model, size and side
(ราง 4 คู่หน้าเฟรมบน = RRS-A-003, บังอาย80 = RRS-T-024-80-L and RRS-A-024-80). The part number (024) is
usually the same, the rest is told by the name. So a part is looked up, first match wins:

1. the stock code written on the Part List row (รหัสสโตร์ – by a person or kept from an earlier check)
2. its own code in the stock file: as it is, cut to 16 characters (Express reports), or through the code
   cross-reference table (ตารางเทียบรหัส)
3. the same part code: a code is read RRS-<brand>-<part number>-<variant>. The 2nd place is the brand of the
   vehicle (T Toyota, I Isuzu, M Mitsubishi, F Ford, N Nissan, S Suzuki); A (ALL) is an item for every brand.
   The drawing's RRS-T-039 (เต้า1) is the stock's RRS-A-039-NO1-PR (เต้าพื้นเรียบเบอร์ 1): same part number,
   A goes with any brand. The brand is the one chosen on the dashboard, else the letter in the drawing's
   codes. Among the items of that number the name, size, stall height, body length and side pick the variant;
   an item of the vehicle's own brand comes before an A item. Items under the same number that are another
   part by their name (หูบนตัวใน / หูบนตัวนอก) are not taken.
4. its name, with the analysis used for the model BOMs (express_codes): what the part is and where it sits,
   stall height, body length, left/right and model; the part number in its code weighs strongly.
   The model, stall height and body length come from the whole drawing (TOYOTA, เสา80, พื้น250).
   Express keeps the left and the right part apart: a flat pattern without a side is split between both -
   unless the drawing tells the side: the name says it (the DWG import names the pieces of a part drawn
   side by side หูช้าง (ซ้าย) / (ขวา) - the piece on the left is the left one), two parts of one drawing matched
   to the same left/right pair are its left and its right piece: drawn side by side (laid out horizontally)
   the one on the left is ซ้าย and the one on the right is ขวา, otherwise by their number (กระดูกหมาชิ้นที่1 =
   ซ้าย, ชิ้นที่2 = ขวา), and a part the drawing gives as 1 ชิ้น is one side (sides_of_pairs).
5. the item of the same part number whose name or size differs (ชิ้นที่ 5 = RRS-A-037-PR บังโคลนพื้นเรียบ)
6. a name match that is not clear, then a name that is the same once the spelling is made the same
   (บังโครน = บังโคลน) - not another number of a numbered part (เต้า4 is not เต้าเบอร์ 1)
7. nothing found: check_requirements falls back to the raw material (same material and thickness).

7. still nothing (match_parts(nearest=True), the material check): the code cross-reference table - a row for
   the same part code (3 places, A = every brand) or a close name whose other code is in the stock - then the
   nearest item of the name match (the ใกล้เคียง list), of the vehicle's brand or A, not another number of a
   numbered part.

The code cross-reference table (ตารางเทียบรหัส) also gives a stock-count code (01-0001-0039) its Express code,
so the item is found by the three places of that code (step 3).

Close results (several variants near each other, 5, 6 and 7) are matched all the same - the material check and
the Part List use them - and say so (ใกล้เคียง) with the other choices, so a person can change one.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from .express_codes import STALL_HEIGHTS
from .models import Part, PartList
from .stock import StockItem, StockList, _find_code, _key, find_by_code

M_STOCK_CODE = "รหัสสโตร์ใน Part List"
M_CODE = "รหัสตรง"
M_XREF = "ตารางเทียบรหัส"
M_PART_NO = "รหัสชิ้นส่วนเดียวกัน"
M_PART_CLOSE = "รหัสเดียวกัน (ใกล้เคียง)"
M_NAME = "จับคู่จากชื่อ"
M_NAME_CLOSE = "ชื่อใกล้เคียง"
M_MATERIAL = "วัสดุ/ความหนา"
M_NONE = "ไม่พบ"
M_XREF_CLOSE = "ตารางเทียบรหัส (ใกล้เคียง)"
M_NEAREST = "ใกล้เคียงที่สุด"
SURE = {M_STOCK_CODE, M_CODE, M_XREF, M_PART_NO, M_PART_CLOSE, M_NAME, M_NAME_CLOSE, M_XREF_CLOSE, M_NEAREST,
        M_MATERIAL}
CLOSE = {M_PART_CLOSE, M_NAME_CLOSE, M_XREF_CLOSE, M_NEAREST}  # from a close result: listed first, other choices
METHOD_ORDER = [M_NONE, M_NEAREST, M_XREF_CLOSE, M_NAME_CLOSE, M_PART_CLOSE, M_MATERIAL, M_NAME, M_PART_NO,
                M_XREF, M_CODE, M_STOCK_CODE]  # weakest first
NEAR_NAME = 0.9  # names alike once the spelling is the same (บังโครน / บังโคลน)
NEAR_XREF = 0.8  # a name in the code cross-reference table close to the part's

# The 2nd place of a code (RRS-T-039): the brand of the vehicle. A (ALL) = used with every brand.
ALL_BRANDS = "A"
BRAND_LETTERS = {"A": "ทุกยี่ห้อ (ALL)", "T": "Toyota", "I": "Isuzu", "M": "Mitsubishi", "F": "Ford",
                 "N": "Nissan", "S": "Suzuki"}
_LETTER_BRAND = {"T": "TOYOTA", "I": "ISUZU", "M": "MITSU", "F": "FORD", "N": "NISSAN", "S": "SUZUKI"}
_TEXT_BRAND = [("T", ("TOYOTA", "TOYATA", "โตโยต้า", "CHAMP", "REVO", "VIGO")), ("I", ("ISUZU", "อีซูซุ", "D-MAX")),
               ("M", ("MITSU", "มิตซู", "TRITON")), ("F", ("FORD", "ฟอร์ด", "RANGER")),
               ("N", ("NISSAN", "นิสสัน", "NAVARA")), ("S", ("SUZUKI", "ซูซูกิ"))]
FROM_DASHBOARD = "Dashboard"
_CODE_RE = re.compile(r"([A-Z]{2,4})-([A-Z])\d?-(\d{3})(?:-(.*))?")
_NO_RE = re.compile(r"NO\.?0*(\d+)")

NUMBER_WEIGHT = 3.0
_HEIGHT_PARTS = re.compile(r"(?:เสา|บังอาย|หน้าโปร|ซองเสา|แผ่นปิดเสา|ฉากฝาข้าง|คอก)\D{0,12}?(\d{2})(?!\d)")
_LENGTH_PARTS = re.compile(r"(?:พื้น|ข้างเฟรม|กระบะ)\D{0,6}?(2(?:[.,]\d{1,2}|\d{2}))(?!\d)")


@dataclass
class PartMatch:
    items: list[tuple[StockItem, float]] = field(default_factory=list)  # (item, share of the part's quantity)
    method: str = M_NONE
    score: float = 0
    alternatives: list[str] = field(default_factory=list)
    note: str = ""  # how the code was read: 'เลขชิ้นส่วน 039 ตรงกัน · A = ทุกยี่ห้อ ใช้กับ T (Toyota)'

    @property
    def item(self) -> StockItem | None:
        return self.items[0][0] if self.items else None

    @property
    def sure(self) -> bool:
        return self.method in SURE

    @property
    def close(self) -> bool:
        return self.method in CLOSE

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
    brand: str = ""  # letter of the vehicle's brand: "T"
    brand_from: str = ""  # FROM_DASHBOARD / "รหัสในแบบ" / "ชื่อในแบบ"


@dataclass(frozen=True)
class CodeParts:
    """RRS-A-039-NO1-PR -> RRS · A · 039 · (NO1, PR)."""
    prefix: str
    brand: str  # A / T / I / M / F / N / S (A1, M1: the letter)
    number: str  # the part: 039 = เต้าที่ 1, 040 = เต้าที่ 2
    rest: tuple[str, ...] = ()
    code: str = ""  # the code read


def split_code(code: str) -> CodeParts | None:
    text = re.sub(r"\s+", "", (code or "").upper())
    found = _CODE_RE.fullmatch(text)
    if not found:
        return None
    rest = tuple(x for x in (found.group(4) or "").split("-") if x)
    return CodeParts(found.group(1), found.group(2), found.group(3), rest, text)


def xref_aliases(stock: StockList) -> dict[int, list[CodeParts]]:
    """id(item) -> its Express codes from the code cross-reference table, for items whose own code is not read
    (stock-count codes 01-0001-0039). One pass per check: the table is read once per item, not per part."""
    from . import stock as stock_mod

    look = stock_mod.XREF_LOOKUP
    out: dict[int, list[CodeParts]] = {}
    if look is None:
        return out
    for item in stock.items:
        if item.code and split_code(item.code) is None:
            codes = [c for c in map(split_code, look(item.code)) if c]
            if codes:
                out[id(item)] = codes
    return out


def _codes_of(item: StockItem, aliases: dict[int, list[CodeParts]] | None) -> list[CodeParts]:
    own = split_code(item.code)
    return ([own] if own else []) + (aliases or {}).get(id(item), [])


def brand_label(letter: str) -> str:
    """'T' -> 'T (Toyota)'."""
    return f"{letter} ({BRAND_LETTERS[letter]})" if letter in BRAND_LETTERS else letter


def drawing_contexts(partlist: PartList) -> dict[str, DrawingContext]:
    """drawing_no -> context, from the names of the parts of that drawing and the job header."""
    groups: dict[str, list[Part]] = {}
    for part in partlist.parts:
        groups.setdefault(part.drawing_no, []).append(part)
    info = partlist.info
    chosen = (info.vehicle_brand or "").strip().upper()[:1]
    out = {}
    for drawing_no, parts in groups.items():
        names = " ".join(p.name for p in parts)
        files = " ".join(d.file_name + " " + d.title for d in partlist.drawings if d.drawing_no == drawing_no)
        ctx = DrawingContext(text=" ".join(x for x in (drawing_no, files, info.vehicle_model, info.drawing_no,
                                                         _model_words(names)) if x))
        ctx.heights = set(_HEIGHT_PARTS.findall(names)) & STALL_HEIGHTS
        ctx.lengths = {_length(v) for v in _LENGTH_PARTS.findall(names)} - {""}
        letters = Counter(c.brand for c in map(split_code, (p.part_no for p in parts))
                          if c and c.brand in _LETTER_BRAND)
        by_text = {letter for letter, words in _TEXT_BRAND if any(w in ctx.text.upper() for w in words)}
        if chosen in _LETTER_BRAND:
            ctx.brand, ctx.brand_from = chosen, FROM_DASHBOARD
        elif letters:
            ctx.brand, ctx.brand_from = letters.most_common(1)[0][0], "รหัสในแบบ"
        elif len(by_text) == 1:
            ctx.brand, ctx.brand_from = by_text.pop(), "ชื่อในแบบ"
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


def match_parts(partlist: PartList, stock: StockList, nearest: bool = False) -> list[tuple[Part, PartMatch]]:
    """Every row of the Part List with its stock item(s); nearest = a part not found takes the closest result
    of the code cross-reference table or of its name (step 7)."""
    contexts = drawing_contexts(partlist)
    aliases = xref_aliases(stock)
    matched = [(p, match_part(p, stock, contexts.get(p.drawing_no), nearest, aliases)) for p in partlist.parts]
    sides_of_pairs(matched)
    _side_notes(matched)
    return matched


def _side_notes(matched: list[tuple[Part, PartMatch]]) -> None:
    """A part whose side the DWG import read from where it is drawn says so in its match."""
    from .express_codes import _item_side

    for part, match in matched:
        if part.side_source and any(_item_side(i) for i, _s in match.items) and part.side_source not in match.note:
            told = ("ข้างจาก" if part.side_source.startswith("แบบ") else "ข้าง") + part.side_source
            match.note = " · ".join(x for x in (match.note, told) if x)


_PIECE_NO = re.compile(r"(?:ชิ้นที่|ตัวที่|อันที่|เบอร์|ที่)\s*(\d+)|(\d+)\s*$")


def _piece_order(part: Part) -> tuple:
    """ชิ้นที่1 before ชิ้นที่2, then the lower code, then the row."""
    found = _PIECE_NO.search(part.name or "")
    code = split_code(part.part_no)
    return (int(found.group(1) or found.group(2)) if found else 9999, code.number if code else part.part_no,
            part.item_no)


def _one_side(match: PartMatch, side: str, why: str) -> None:
    """Keep the item of one side of a left/right pair; the other side becomes the first other choice."""
    from .express_codes import _item_side

    kept = next(i for i, _s in match.items if _item_side(i) == side)
    dropped = next(i for i, _s in match.items if i is not kept)
    match.items = [(kept, 1.0)]
    match.note = " · ".join(x for x in (match.note.replace(dropped.name, kept.name), why) if x)
    match.alternatives = [f"{dropped.code} {dropped.name}"] + [a for a in match.alternatives
                                                                 if not a.startswith(dropped.code + " ")]


def sides_of_pairs(matched: list[tuple[Part, PartMatch]]) -> None:
    """A drawing part without a side matched to a left and a right item (half each): the program picks the side
    when the drawing tells it - two parts of one drawing on the same pair are its left and its right piece:
    drawn side by side (laid out horizontally) the one placed on the left is ซ้าย and the one on the right is ขวา,
    else by their number (RRS-T-045 กระดูกหมาชิ้นที่1 -> RRS-T-009-L, RRS-T-046 ชิ้นที่2 -> RRS-T-009-R-) - and a
    part the drawing gives as 1 ชิ้น is one side (the left). Otherwise it stays on both sides, half each (หูช้าง)."""
    from .express_codes import _item_side
    from .sides import left_right

    groups: dict[tuple, list[tuple[Part, PartMatch]]] = {}
    for part, match in matched:
        if (match.method != M_STOCK_CODE and len(match.items) == 2
                and {_item_side(i) for i, _s in match.items} == {"L", "R"}):
            # a part found by its own code keeps both sides; close results on the pair are grouped apart
            key = (part.drawing_no, tuple(sorted(_key(i.code) for i, _s in match.items)), match.close)
            groups.setdefault(key, []).append((part, match))
    for rows in groups.values():
        names = {(_key(p.part_no), _key(p.name)) for p, _m in rows}
        placed = left_right(rows[0][0].drawing_box, rows[1][0].drawing_box) if len(rows) == 2 else None
        if placed:  # drawn side by side: the piece placed on the left is the left one
            (left, ml), (right, mr) = rows[placed[0]], rows[placed[1]]
            why = (f"แบบวาง 2 ชิ้นนี้ในแนวนอน ({left.part_no or left.name} ฝั่งซ้าย / "
                   f"{right.part_no or right.name} ฝั่งขวา)")
            _one_side(ml, "L", f"{why}: ชิ้นที่วางฝั่งซ้าย = ข้างซ้าย")
            _one_side(mr, "R", f"{why}: ชิ้นที่วางฝั่งขวา = ข้างขวา")
        elif len(rows) == 2 and len(names) == 2:  # two parts, not the same part listed twice
            rows.sort(key=lambda t: _piece_order(t[0]))
            (first, m1), (second, m2) = rows
            _one_side(m1, "L", f"แบบมี 2 ชิ้นที่ตรงกับคู่ซ้าย/ขวานี้ ({first.part_no or first.name} / "
                               f"{second.part_no or second.name}): ชิ้นแรก = ข้างซ้าย")
            _one_side(m2, "R", f"แบบมี 2 ชิ้นที่ตรงกับคู่ซ้าย/ขวานี้ ({first.part_no or first.name} / "
                               f"{second.part_no or second.name}): ชิ้นที่สอง = ข้างขวา")
        else:
            for part, match in rows:
                if part.drawing_qty == 1:
                    _one_side(match, "L", "แบบระบุ 1 ชิ้น ไม่ระบุข้าง – ใช้ข้างซ้าย")


def match_part(part: Part, stock: StockList, context: DrawingContext | None = None, nearest: bool = False,
               aliases: dict[int, list[CodeParts]] | None = None) -> PartMatch:
    """The stock item(s) of a Part List row – see the module text for the order."""
    context = context or DrawingContext()
    aliases = xref_aliases(stock) if aliases is None else aliases
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
    pool = StockList(items=[i for i in stock.items if i.code])
    same, loose = match_by_part_no(part, pool, context, aliases)
    if same is not None:
        return same
    named = PartMatch()
    by_name = bool(part.name) and part.process != "ซื้อสำเร็จ"
    if by_name:
        named = match_by_name(part, pool, context)
    if named.items and named.method == M_NAME:
        return named
    if loose:  # the code says it is this part though the name or the size differs
        return _loose_match(part, loose, pool, context)
    if named.items:
        return named
    near = match_near_name(part, pool, context, aliases) if by_name else None
    if near is not None or not nearest:
        return near or named
    return (match_xref_near(part, pool, context)
            or (match_nearest(part, pool, context, named.alternatives, aliases) if by_name else None) or named)


def _part_brand(code: CodeParts, context: DrawingContext) -> str:
    """The brand letter the part is for: the dashboard's, else its own code's, else the drawing's."""
    if context.brand_from == FROM_DASHBOARD or code.brand not in _LETTER_BRAND:
        return context.brand
    return code.brand


def _brand_note(part_code: CodeParts, item: StockItem, letter: str, item_code: CodeParts | None = None) -> str:
    """'เลขชิ้นส่วน 039 ตรงกัน · A = ทุกยี่ห้อ ใช้กับ T (Toyota)' (+ the Express code of a stock-count code)."""
    item_code = item_code or split_code(item.code)
    text = f"เลขชิ้นส่วน {part_code.number} ตรงกัน"
    if item_code and item_code.brand == ALL_BRANDS:
        text += " · A = ทุกยี่ห้อ" + (f" ใช้กับ {brand_label(letter)}" if letter else "")
    elif item_code:
        text += f" · {brand_label(item_code.brand)}"
    if item_code and split_code(item.code) is None:
        text += f" · {item.code} = {item_code.code} ตามตารางเทียบรหัส"
    return text


def _name_context(part: Part, context: DrawingContext, letter: str = ""):
    """The model, the express_codes scoring context and the row of a drawing part."""
    from .company_files import ModelBOM, ModelRow
    from .express_codes import model_context

    title = " ".join(sorted(context.lengths))  # body length: read from the title for every row
    model = ModelBOM(context.text, title)
    ctx = model_context(model)
    ctx.heights |= context.heights
    ctx.number_weight = NUMBER_WEIGHT
    brand = _LETTER_BRAND.get(letter or context.brand, "")
    if brand:  # the drawing says T (or the dashboard does): Toyota items are its own
        ctx.brands.add(brand)
    row = ModelRow(item_no=part.item_no, raw_code=part.part_no, codes=[part.part_no] if part.part_no else [],
                   name=part.name, size=part.spec, qty=1, qty_text="1")
    return model, ctx, row


def match_by_part_no(part: Part, stock: StockList, context: DrawingContext,
                     aliases: dict[int, list[CodeParts]] | None = None
                     ) -> tuple[PartMatch | None, list[tuple[float, StockItem, str, CodeParts]]]:
    """The item(s) with the same part number for the vehicle's brand or every brand (A):
    RRS-T-039 เต้า1 -> RRS-A-039-NO1-PR เต้าพื้นเรียบเบอร์ 1. Returns (match, loose): loose are items of the
    same number whose name or size differs: (score, item, why, code read)."""
    from .express_codes import _code_side, _core, _item_side, _numbers, _score, _side, _tokens, _word_score

    own = split_code(part.part_no)
    if own is None:
        return None, []
    letter = _part_brand(own, context)
    allowed = {ALL_BRANDS, letter}
    want = _side(part.name) or _code_side(part.part_no)
    pool = []
    for item in stock.items:
        if want and _item_side(item) not in (want, ""):
            continue
        code = next((c for c in _codes_of(item, aliases)
                     if c.prefix == own.prefix and c.number == own.number and c.brand in allowed), None)
        if code is not None:
            pool.append((item, code))
    if not pool:
        return None, []
    read = {id(item): code for item, code in pool}
    model, ctx, row = _name_context(part, context, letter)
    row_core = _core(part.name)
    row_words = _tokens(row_core)
    row_nums = _numbers(part.name) | {n for n in _numbers(model.title) if n}
    scored, loose = [], []
    for item, code in pool:
        if part.name and _word_score(row_words, _tokens(_core(item.name))) is None:
            continue  # another part under the same number (หูบนตัวใน / หูบนตัวนอก)
        conflict = variant_conflict(part, item, context)
        score = _score(row, ctx, item, row_core, row_nums, row_words, frozenset()) if part.name else 0
        if score <= 0 or conflict:
            why = conflict or (f"ชื่อในแบบ {part.name} ≠ {item.name}" if part.name else "ไม่มีชื่อในแบบ")
            loose.append((score + (1.5 if code.brand == letter else 0), item, why, code))
            continue
        score += 1.5 if code.brand == letter else 0  # the vehicle's own item before the one for every brand
        score += sum(1 for x in own.rest if x in code.rest and x not in ("L", "R"))
        scored.append((score, item))
    if not scored:
        return None, loose
    scored.sort(key=lambda t: -t[0])
    best_s, best = scored[0]
    items = _paired(part, best, [i for _s, i in scored], stock)  # Express has left and right apart: half each
    rivals = [(s, i) for s, i in scored[1:] if all(i is not x for x, _share in items)]
    lead = best_s - rivals[0][0] if rivals else 99
    alternatives = [f"{i.code} {i.name}" for s, i in rivals[:3] if s >= best_s - 3]
    method = M_PART_NO if lead >= 1.5 else M_PART_CLOSE  # close variants: the best one, the others listed
    note = _brand_note(own, best, letter, read[id(best)])
    return PartMatch(items, method, round(best_s, 1), alternatives, note), loose


def _paired(part: Part, best: StockItem, near: list[StockItem], stock: StockList) -> list[tuple[StockItem, float]]:
    """best alone, or with its other side half each when the drawing part has no side."""
    from .express_codes import _code_side, _item_side, _side

    side = _item_side(best)
    if side and not (_side(part.name) or _code_side(part.part_no)):
        other = _counterpart(best, side, StockList(items=near)) or _counterpart(best, side, stock)
        if other is not None:
            return sorted([(best, 0.5), (other, 0.5)], key=lambda t: _item_side(t[0]) != "L")
    return [(best, 1.0)]


def _loose_match(part: Part, loose: list, stock: StockList, context: DrawingContext) -> PartMatch:
    """The item of the same part number though its name or size differs (the nearest one when there are
    several), matched as a close result with why. loose: (score, item, why, code read)."""
    ranked = sorted(loose, key=lambda t: -t[0])
    score, best, why, code = ranked[0]
    items = _paired(part, best, [t[1] for t in ranked], stock)
    taken = {id(i) for i, _s in items}
    own = split_code(part.part_no)  # loose items come from match_by_part_no: the code is read
    note = _brand_note(own, best, _part_brand(own, context), code) + f" · {why}"
    alternatives = [f"{t[1].code} {t[1].name}" for t in ranked if id(t[1]) not in taken][:3]
    return PartMatch(items, M_PART_CLOSE, round(max(score, 5.0), 1), alternatives, note)


def match_near_name(part: Part, stock: StockList, context: DrawingContext,
                    aliases: dict[int, list[CodeParts]] | None = None) -> PartMatch | None:
    """A name that is the same once the spelling is the same (บังโครน -> RRS-A-037-PR บังโคลนพื้นเรียบ), of the
    vehicle's brand or every brand, not another size or number of it (เต้า4 is not เต้าเบอร์ 1)."""
    import difflib

    from .express_codes import _code_side, _core, _item_side, _side

    core = _core(part.name)
    if len(core) < 3:
        return None
    own = split_code(part.part_no)
    letter = _part_brand(own, context) if own else context.brand
    want = _side(part.name) or _code_side(part.part_no)
    near = []
    for item in stock.items:
        brands = {c.brand for c in _codes_of(item, aliases)}
        if not brands & {ALL_BRANDS, letter} or (want and _item_side(item) not in (want, "")):
            continue
        ratio = difflib.SequenceMatcher(None, core, _core(item.name)).ratio()
        if ratio >= NEAR_NAME and not variant_conflict(part, item, context):
            near.append((ratio + (0.05 if letter in brands else 0), item))
    if not near:
        return None
    near.sort(key=lambda t: -t[0])
    ratio, best = near[0]
    items = _paired(part, best, [i for _r, i in near], stock)
    taken = {id(i) for i, _s in items}
    return PartMatch(items, M_NAME_CLOSE, round(10 * ratio, 1), [f"{i.code} {i.name}" for _r, i in near
                                                                   if id(i) not in taken][:3],
                     f"ชื่อใกล้เคียง: {part.name} ≈ {best.name}")


def match_xref_near(part: Part, stock: StockList, context: DrawingContext) -> PartMatch | None:
    """A row of the code cross-reference table for the same part code (3 places: RRS-T-039 ~ RRS-A-039-…) or
    a close name, whose other code is in the stock."""
    import difflib

    from . import stock as stock_mod
    from .express_codes import _core

    entries = stock_mod.XREF_ENTRIES() if stock_mod.XREF_ENTRIES is not None else []
    own = split_code(part.part_no)
    letter = _part_brand(own, context) if own else context.brand
    core = _core(part.name)
    best = None
    for entry in entries:
        for mine, other in ((entry.code_a, entry.code_b), (entry.code_b, entry.code_a)):
            item = _find_code(other, stock) if mine and other else None
            if item is None:
                continue
            code = split_code(mine)
            if own and code and (code.prefix, code.number) == (own.prefix, own.number):
                score = 2.0 + (0.5 if code.brand == letter else 0) if code.brand in (ALL_BRANDS, letter) else 0
            elif len(core) >= 3 and entry.name:
                ratio = difflib.SequenceMatcher(None, core, _core(entry.name)).ratio()
                score = ratio if ratio >= NEAR_XREF else 0
            else:
                score = 0
            if score and not variant_conflict(part, item, context) and (best is None or score > best[0]):
                best = (score, item, entry, mine, other)
    if best is None:
        return None
    score, item, entry, mine, other = best
    items = _paired(part, item, [], stock)
    return PartMatch(items, M_XREF_CLOSE, round(4 * score, 1),
                     note=f"ตารางเทียบรหัส: {mine} ↔ {other}" + (f" ({entry.method})" if entry.method else ""))


def match_nearest(part: Part, stock: StockList, context: DrawingContext, alternatives: list[str],
                  aliases: dict[int, list[CodeParts]] | None = None) -> PartMatch | None:
    """Not found: the nearest item of the name match (its ใกล้เคียง list), of the vehicle's brand or every
    brand, not another size or number of it (เต้า4 is not เต้าเบอร์ 1)."""
    import difflib

    from .express_codes import _core

    own = split_code(part.part_no)
    letter = _part_brand(own, context) if own else context.brand
    for n, text in enumerate(alternatives):
        item = _find_code(text.split(" ", 1)[0], stock)
        if item is None:
            continue
        brands = {c.brand for c in _codes_of(item, aliases)}
        if (brands and not brands & {ALL_BRANDS, letter}) or variant_conflict(part, item, context):
            continue  # another brand's item, another number of a numbered part
        ratio = difflib.SequenceMatcher(None, _core(part.name), _core(item.name)).ratio()
        items = _paired(part, item, [], stock)
        taken = {i.code for i, _s in items}
        rest = [a for a in alternatives[n + 1:] if a.split(" ", 1)[0] not in taken]
        return PartMatch(items, M_NEAREST, round(10 * ratio, 1), rest[:3],
                         f"ไม่พบรหัสตรง – ใช้รายการใกล้เคียงที่สุด: {item.name} (ชื่อคล้าย {ratio:.0%})")
    return None


def _sizes(text: str) -> set[float]:
    """Sizes in a name: 'ฝาข้าง(209)กระบะ2.50' -> {209, 250} (2.50 m = 250); years and small numbers left out."""
    from .express_codes import _numbers

    out = set()
    for n in _numbers(text):
        v = float(n)
        v = v * 100 if 2 <= v <= 2.6 else v
        if 10 <= v < 2000:
            out.add(v)
    return out


def variant_conflict(part: Part, item: StockItem, context: DrawingContext) -> str:
    """Why an item of the same part number is another size of it ('' = it fits):
    a size in the names (161 cm / 169 cm), the stall height or body length of the drawing (เสา80 / 40),
    the number of a numbered part (เต้า2 / NO1)."""
    from .express_codes import _RAILS, _numbers, _rail_heights

    def fmt(values) -> str:
        return "/".join(f"{v:g}" for v in sorted(values))

    mine = _sizes(part.name)
    theirs = _sizes(_RAILS.sub("", item.name)) | {float(h) for h in _rail_heights(item.name)}
    if mine and theirs and not any(abs(a - b) <= 1 for a in mine for b in theirs):
        return f"ขนาด {fmt(mine)} ≠ {fmt(theirs)}"
    if not mine:
        heights = {float(h) for h in context.heights}
        item_heights = {v for v in theirs if f"{v:g}" in STALL_HEIGHTS}
        if heights and item_heights and not heights & item_heights:
            return f"ความสูงคอก {fmt(heights)} ≠ {fmt(item_heights)}"
        lengths = {float(x) for x in context.lengths}
        item_lengths = {v for v in theirs if 200 <= v <= 260}
        if lengths and item_lengths and not lengths & item_lengths:
            return f"ความยาวกระบะ {fmt(lengths)} ≠ {fmt(item_lengths)}"
    code = split_code(item.code)
    numbered = [int(m.group(1)) for x in (code.rest if code else ()) if (m := _NO_RE.fullmatch(x))]
    small = {int(float(n)) for n in _numbers(part.name) if float(n) < 10 and float(n).is_integer()}
    own = split_code(part.part_no)
    small |= {int(m.group(1)) for x in (own.rest if own else ()) if (m := _NO_RE.fullmatch(x))}
    if numbered and small and not set(numbered) & small:
        return f"เบอร์ {numbered[0]} ≠ {fmt(small)}"
    return ""


def match_by_name(part: Part, stock: StockList, context: DrawingContext) -> PartMatch:
    from .express_codes import ST_AUTO, ST_CHECK, ST_EXACT, _item_side, _side, resolve_row

    model, ctx, row = _name_context(part, context)
    pool = StockList(items=[i for i in stock.items if i.code])
    [best] = resolve_row(model, ctx, row, pool)[:1]
    if best.status not in (ST_AUTO, ST_CHECK, ST_EXACT) or not best.code:
        return PartMatch(alternatives=best.alternatives)
    item = _find_code(best.code, pool)
    method = M_NAME if best.status in (ST_AUTO, ST_EXACT) else M_NAME_CLOSE
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
