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
   Express keeps the left and the right part apart: a flat pattern without a side is split between both.
5. still nothing: the item of the same part number whose name or size differs, marked to check.
6. nothing found: check_requirements falls back to the raw material (same material and thickness).

Every match says how it was found; a name match that is not clear is marked to check.
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
M_PART_CHECK = "รหัสเดียวกัน – ควรตรวจ"
M_NAME = "จับคู่จากชื่อ"
M_CHECK = "จากชื่อ – ควรตรวจ"
M_MATERIAL = "วัสดุ/ความหนา"
M_NONE = "ไม่พบ"
SURE = {M_STOCK_CODE, M_CODE, M_XREF, M_PART_NO, M_NAME, M_MATERIAL}
CHECK = {M_CHECK, M_PART_CHECK}  # found, a person should look
METHOD_ORDER = [M_NONE, M_CHECK, M_PART_CHECK, M_MATERIAL, M_NAME, M_PART_NO, M_XREF, M_CODE,
                M_STOCK_CODE]  # weakest first

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
    def to_check(self) -> bool:
        return self.method in CHECK

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


def split_code(code: str) -> CodeParts | None:
    found = _CODE_RE.fullmatch(re.sub(r"\s+", "", (code or "").upper()))
    if not found:
        return None
    rest = tuple(x for x in (found.group(4) or "").split("-") if x)
    return CodeParts(found.group(1), found.group(2), found.group(3), rest)


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


def match_parts(partlist: PartList, stock: StockList) -> list[tuple[Part, PartMatch]]:
    """Every row of the Part List with its stock item(s)."""
    contexts = drawing_contexts(partlist)
    return [(p, match_part(p, stock, contexts.get(p.drawing_no))) for p in partlist.parts]


def match_part(part: Part, stock: StockList, context: DrawingContext | None = None) -> PartMatch:
    """The stock item(s) of a Part List row – see the module text for the order."""
    context = context or DrawingContext()
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
    same, loose = match_by_part_no(part, pool, context)
    if same is not None:
        return same
    match = PartMatch()
    if part.name and part.process != "ซื้อสำเร็จ":
        match = match_by_name(part, pool, context)
    if not match.items and loose:
        return _loose_match(part, loose, context) or match
    return match


def _part_brand(code: CodeParts, context: DrawingContext) -> str:
    """The brand letter the part is for: the dashboard's, else its own code's, else the drawing's."""
    if context.brand_from == FROM_DASHBOARD or code.brand not in _LETTER_BRAND:
        return context.brand
    return code.brand


def _brand_note(part_code: CodeParts, item: StockItem, letter: str) -> str:
    """'เลขชิ้นส่วน 039 ตรงกัน · A = ทุกยี่ห้อ ใช้กับ T (Toyota)'."""
    item_code = split_code(item.code)
    text = f"เลขชิ้นส่วน {part_code.number} ตรงกัน"
    if item_code and item_code.brand == ALL_BRANDS:
        return text + " · A = ทุกยี่ห้อ" + (f" ใช้กับ {brand_label(letter)}" if letter else "")
    return text + (f" · {brand_label(item_code.brand)}" if item_code else "")


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


def match_by_part_no(part: Part, stock: StockList,
                     context: DrawingContext) -> tuple[PartMatch | None, list[tuple[StockItem, str]]]:
    """The item(s) with the same part number for the vehicle's brand or every brand (A):
    RRS-T-039 เต้า1 -> RRS-A-039-NO1-PR เต้าพื้นเรียบเบอร์ 1. Returns (match, loose): loose are items of the
    same number whose name or size differs (with why) – used only when nothing else is found."""
    from .express_codes import _code_side, _core, _item_side, _numbers, _score, _side, _tokens, _word_score

    own = split_code(part.part_no)
    if own is None:
        return None, []
    letter = _part_brand(own, context)
    allowed = {ALL_BRANDS, letter}
    want = _side(part.name) or _code_side(part.part_no)
    pool = []
    for item in stock.items:
        code = split_code(item.code)
        if (code and code.prefix == own.prefix and code.number == own.number and code.brand in allowed
                and (not want or _item_side(item) in (want, ""))):
            pool.append((item, code))
    if not pool:
        return None, []
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
            loose.append((item, conflict or "ชื่อต่างกัน"))
            continue
        score += 1.5 if code.brand == letter else 0  # the vehicle's own item before the one for every brand
        score += sum(1 for x in own.rest if x in code.rest and x not in ("L", "R"))
        scored.append((score, item))
    if not scored:
        return None, loose
    scored.sort(key=lambda t: -t[0])
    best_s, best = scored[0]
    items = [(best, 1.0)]
    rivals = scored[1:]
    side = _item_side(best)
    if side and not want:  # Express has left and right apart: half each
        other = (_counterpart(best, side, StockList(items=[i for _s, i in scored]))
                 or _counterpart(best, side, stock))
        if other is not None:
            items = sorted([(best, 0.5), (other, 0.5)], key=lambda t: _item_side(t[0]) != "L")
            rivals = [(s, i) for s, i in rivals if i is not other]
    lead = best_s - rivals[0][0] if rivals else 99
    alternatives = [f"{i.code} {i.name}" for s, i in rivals[:3] if s >= best_s - 3]
    method = M_PART_NO if lead >= 1.5 else M_PART_CHECK
    return PartMatch(items, method, round(best_s, 1), alternatives, _brand_note(own, best, letter)), loose


def _loose_match(part: Part, loose: list[tuple[StockItem, str]], context: DrawingContext) -> PartMatch | None:
    """Nothing else found: the one item (or left/right pair) of the same part number, to check."""
    from .express_codes import _item_side

    items = [i for i, _why in loose]
    sides = {_item_side(i) for i in items}
    if not (len(items) == 1 or (len(items) == 2 and sides == {"L", "R"})):
        return None
    items.sort(key=lambda i: _item_side(i) != "L")
    own = split_code(part.part_no)  # loose items come from match_by_part_no: the code is read
    why = "; ".join(dict.fromkeys(w for _i, w in loose))
    note = _brand_note(own, items[0], _part_brand(own, context)) + f" แต่{why}"
    return PartMatch([(i, 1 / len(items)) for i in items], M_PART_CHECK, 5.0, note=note)


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
