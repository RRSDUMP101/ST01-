"""Give every row of the model BOMs ("Parts List All Model") its exact Express item code.

The workbook uses base part numbers (RRS-T-024 บังอาย) while Express has one code per model,
size and side (RRS-T-024-L-84 บังอาย Champ 84(ซ้าย)), and Express numbering is not uniform
(เสาหน้า is 022 or 099). So a row is matched on the part name plus what the sheet says about the
model: brand (Toyota / Champ / Mitsubishi / Isuzu / Nissan / พื้นเรียบ), stall height (84, 80, 60, 40),
and left/right. A "1+1" row becomes one line for ซ้าย and one for ขวา when Express has both.
Every result carries a status so a person checks what was chosen automatically.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field, replace

from .company_files import ModelBOM, ModelRow, base_code
from .stock import StockItem, StockList, _key, find_by_code, find_variants

ST_EXACT = "รหัสตรง"
ST_AUTO = "จับคู่อัตโนมัติ"
ST_CHECK = "ควรตรวจ"
ST_NONE = "ไม่พบใน Express"
ST_NOCODE = "ไม่มีรหัสในแบบ"

_BRAND_WORDS = {
    "CHAMP": ["CHAMP", "แชมป์", "CLAMP", "CRAMP"],
    "REVO": ["REVO"],
    "MITSU": ["MITSU", "มิตซู"],
    "ISUZU": ["ISUZU", "อีซูซุ", "ALLNEW", "ALL NEW", "XLS", "SLX"],
    "NISSAN": ["NISSAN", "N.V", "NV", "F.T", "FT", "N/V", "N/F"],
    "PR": ["พื้นเรียบ", "-PR"],
    "CRANE": ["เครน", "CRANE"],
    "MITYX": ["MITY", "MIGHTY"],
    "SUZUKI": ["SUZUKI"],
    "FORD": ["FORD", "ฟอร์ด", "RANGER"],
}
_CODE_BRAND = {"RRS-T": "TOYOTA", "RRS-M": "MITSU", "RRS-M1": "MITSU", "RRS-I": "ISUZU", "RRS-N": "NISSAN",
               "RRS-S": "SUZUKI", "RRS-F": "FORD"}
# Words in the BOM sheets -> words used in Express names
_SYNONYMS = [("ปิดหน้าเฟรมล่าง", "หน้าเฟรมล่าง"), ("ปิดหลังเฟรมล่าง", "ท้ายเฟรมล่าง"), ("ปิดท้ายเฟรม", "ท้ายเฟรม"),
             ("ด้านข้างเฟรม", "ข้างเฟรม"), ("ตัวเสริมท้าย", "เสริมท้ายเฟรมล่าง"), ("หูล็อค", "หูล็อก"),
             ("ราง4คู่หน้า", "ราง4คู่หน้าเฟรม"), ("ราง3คู่หน้า", "ราง3คู่หน้าเฟรมล่าง"), ("หน้าโปรคอกสูง", "หน้าโปร"),
             ("หน้าโปรคอกเตี้ย", "หน้าโปร"), ("พื้นคอกสูง", "พื้น"), ("พื้นคอกเตี้ย", "พื้น"),
             ("หูบน(ตัวล่าง)", "หูบนตัวนอก"), ("หูบน(ตัวใน)", "หูบนตัวใน"), ("เหล็กซองเสา", "ซองเสา"),
             ("ป้ายทะเบียน", "กรอบป้ายทะเบียน"), ("เหล็กรางกลางเบอร์", "เหล็กรางกลางพื้นเรียบเบอร์"),
             ("กระดูกกลางเบอร์", "กระดูกกลางพื้นเรียบเบอร์"),
             ("กล่องปิดท้าย", "กล่องฝาท้าย")]
_NOISE = re.compile(r"(พื้นเรียบ|ซ้าย|ขวา|ข้างซ้าย|ข้างขวา|ใช้กับทุกรุ่น|ใช้ด้วยกันทุกรุ่น|new|old|เก่า|ใหม่|\d+(?:\.\d+)?|"
                    r"champ|clamp|cramp|revo|mitsu\w*|isuzu|nissan|toyota|t-|i-|m-|n\.v|f\.t|cm|mm|มิล|"
                    r"[a-z]+|[()\[\]\s.,+\-/])", re.IGNORECASE)


@dataclass
class Context:
    brands: set[str] = field(default_factory=set)
    heights: set[str] = field(default_factory=set)
    frame: str = ""  # "เฟรมบน" / "เฟรมล่าง" for frame sheets
    toyota_plain: bool = False
    lengths: set[str] = field(default_factory=set)  # body length chosen by the user: {"230"}
    fixed: bool = False  # chosen by the user (variant dialog): sizes in the row names do not count
    number_weight: float = 1.0  # the part number in the code (RRS-T-024 -> 024) found in an Express code


@dataclass
class Resolved:
    model: str
    item_no: str
    old_code: str
    name: str
    qty: float
    qty_text: str
    code: str = ""
    express_name: str = ""
    status: str = ST_NONE
    score: float = 0
    side: str = ""
    alternatives: list[str] = field(default_factory=list)
    remark: str = ""
    image: str = ""
    size: str = ""


def model_context(model: ModelBOM) -> Context:
    text = f"{model.name} {model.title}".upper()
    ctx = Context()
    if "CHAMP" in text or "แชมป์" in text or "CLAMP" in text:
        ctx.brands |= {"CHAMP", "TOYOTA"}
    if "TOYOTA" in text or "TOYATA" in text or re.search(r"(เฟรมบน|เฟรมล่าง)\s*T\b", text):
        ctx.brands.add("TOYOTA")
        ctx.toyota_plain = "CHAMP" not in ctx.brands
    if "MITSU" in text or re.search(r"(เฟรมบน|เฟรมล่าง)\s*M\b", text):
        ctx.brands.add("MITSU")
    if "ISUZU" in text or re.search(r"(เฟรมบน|เฟรมล่าง)\s*I\b", text):
        ctx.brands.add("ISUZU")
    if "พื้นเรียบ" in text:
        ctx.brands.add("PR")
    if "4 ราว" in text or "4ราว" in text:
        ctx.heights.add("84")
    elif "3 ราว" in text or "3ราว" in text:
        ctx.heights.add("80")
    elif "2 ราว" in text or "2ราว" in text:
        ctx.heights.add("60")
    if "คอกเตี้ย" in text:
        ctx.heights.add("40")
    if "เฟรมบน" in text:
        ctx.frame = "เฟรมบน"
    elif "เฟรมล่าง" in text:
        ctx.frame = "เฟรมล่าง"
    if "2024" in text:
        ctx.brands.add("2024")
    return ctx


def _brands(text: str, code: str = "") -> set[str]:
    upper = (text or "").upper()
    out = {b for b, words in _BRAND_WORDS.items() if any(w.upper() in upper for w in words)}
    cu = (code or "").upper().replace(" ", "")
    fam = "-".join(cu.split("-")[:2])
    if fam in _CODE_BRAND:
        out.add(_CODE_BRAND[fam])
    if "-PR" in cu or cu.endswith("PR"):
        out.add("PR")
    if "CHAMP" in cu or "CHAM" in cu:
        out.add("CHAMP")
    if "CRANE" in cu or "CRAMP" in cu:
        out.add("CRANE")
    if "2024" in upper or "2024" in cu or "M24" in upper:
        out.add("2024")
    return out


def _side(text: str) -> str:
    t = text or ""
    if "ซ้าย" in t and "ขวา" not in t:
        return "L"
    if "ขวา" in t and "ซ้าย" not in t:
        return "R"
    return ""


def _code_side(code: str) -> str:
    parts = (code or "").upper().replace(" ", "").split("-")
    if "L" in parts[2:]:
        return "L"
    if "R" in parts[2:]:
        return "R"
    return ""


def _numbers(text: str) -> set[str]:
    return {n.rstrip("0").rstrip(".") if "." in n else n for n in re.findall(r"\d+(?:\.\d+)?", text or "")}


def _core(text: str) -> str:
    t = _ORDINAL.sub("", (text or "").replace("\xa0", " "))
    t = _RAILS.sub("", t).replace(" ", "")  # "ซองเสา 2ราว" is the 2-rail ซองเสา, not a ราว
    for a, b in _SYNONYMS:
        t = t.replace(a, b)
    return _NOISE.sub("", t).strip()


# "เต้าที่ 1" / "เต้าพื้นเรียบเบอร์ 1" / "ขาเซฟตี้ตัวที่1": the word before the number of a numbered part
_ORDINAL = re.compile(r"(?:เบอร์|ตัวที่|ชิ้นที่|อันที่|ที่|NO\.?)\s*(?=\d)", re.IGNORECASE)
# "ซองเสา 2ราว(ซ้าย)" -> the version for 2-rail (60 cm) stalls
_RAILS = re.compile(r"(?<=\S)\s+([234])\s*ราว")
_RAIL_HEIGHT = {"2": "60", "3": "80", "4": "84"}


def _rail_heights(text: str) -> set[str]:
    return {_RAIL_HEIGHT[n] for n in _RAILS.findall(text or "")}


# Words that say what a part is and where it sits; a candidate must agree with the sheet on them.
_PART_WORDS = ["ป้ายทะเบียน", "ปากนกแก้ว", "ซับคัดซี", "รางรถไฟ", "หน้าโปร", "บังโคลน", "บังอาย", "บานพับ", "หูช้าง",
               "หูล็อก", "กระดูก", "ผ้าใบ", "ปะกับ", "กล่อง", "ตะขอ", "กรอบ", "แผ่น", "หูบน", "พื้น", "เฟรม", "ฉาก",
               "ซอง", "ราง", "เสา", "ราว", "ฝา"]
_PLACE_WORDS = ["ข้าง", "ท้าย", "หน้า", "หลัง", "กลาง", "ล่าง", "บน", "ใน", "นอก"]
_OPPOSITE = [("ข้าง", "ท้าย"), ("กลาง", "ข้าง"), ("หน้า", "หลัง"), ("หน้า", "ท้าย"), ("บน", "ล่าง"), ("ใน", "นอก")]
_WORDS = sorted(_PART_WORDS + _PLACE_WORDS, key=len, reverse=True)


def _tokens(core: str) -> set[str]:
    out, i = set(), 0
    while i < len(core):
        for w in _WORDS:
            if core.startswith(w, i):
                out.add(w)
                i += len(w)
                break
        else:
            i += 1
    return out


def _word_score(row_words: set[str], item_words: set[str], optional: frozenset[str] = frozenset()) -> float | None:
    """None = the candidate is another part (ฝาข้าง vs ฝาท้าย); otherwise a penalty.
    `optional` are words the sheet implies (เฟรมบน on a frame sheet) that Express names may leave out."""
    every = row_words | optional
    for a, b in _OPPOSITE:
        for x, y in ((a, b), (b, a)):
            if x in every and y not in every and y in item_words and x not in item_words:
                return None
    parts_r, parts_i = row_words & set(_PART_WORDS), item_words & set(_PART_WORDS)
    if parts_r and not parts_r & parts_i:
        return None
    extra = parts_i - parts_r - optional
    places_r, places_i = row_words - parts_r, item_words - parts_i
    return (-4 * len(parts_r - parts_i) - 2 * len(extra) - 1.5 * len(places_r - places_i)
            - 1.5 * len(places_i - places_r - optional))


def _lengths(nums: set[str]) -> set[int]:
    """Body lengths: 2.30 / 230 / 2.3 -> 230."""
    out = set()
    for n in nums:
        v = float(n)
        if 2 <= v <= 2.6:
            out.add(round(v * 100))
        elif 200 <= v <= 260:
            out.add(round(v))
    return out


def _item_side(item: StockItem) -> str:
    return _side(item.name) or _code_side(item.code)


def _score(row: ModelRow, ctx: Context, item: StockItem, row_core: str, row_nums: set[str],
           row_words: set[str], optional: frozenset[str]) -> float:
    core = _core(item.name)
    if not core or not row_core:
        return 0
    words = _word_score(row_words, _tokens(core), optional)
    if words is None:
        return 0
    sim = difflib.SequenceMatcher(None, row_core, core).ratio()
    if row_core in core or core in row_core:
        sim = max(sim, 0.85 if abs(len(core) - len(row_core)) <= 4 else 0.7)
    if sim < 0.55:
        return 0
    score = 10 * sim + words
    for code in row.codes:
        b = base_code(code).upper().replace(" ", "")
        cu = item.code.upper().replace(" ", "")
        if cu == b or cu.startswith(b + "-"):
            score += 3
        elif b.split("-")[-1:] and b.split("-")[-1] in cu.split("-"):
            score += ctx.number_weight
    brands = _brands(item.name, item.code)
    for brand in brands:
        if brand in ctx.brands:
            score += 2 if brand not in ("TOYOTA",) else 1
        elif brand == "TOYOTA" and "CHAMP" in ctx.brands:
            pass
        elif brand in ("PR", "CRANE", "MITYX", "SUZUKI"):
            score -= 6
        elif brand in ("CHAMP", "REVO") and "TOYOTA" in ctx.brands:
            score -= 2.5
        elif brand == "2024":
            pass
        else:
            score -= 6
    if "PR" in ctx.brands and "PR" not in brands:
        score -= 2
    if not brands - {"2024"}:
        score += 0.5  # RRS-A: used by every model
    upper = item.name.upper()
    if "เก่า" in item.name or "OLD" in upper:
        score -= 1
    if "NEW" in upper or "2024" in upper or "2020" in upper:
        score += 0.5
    item_nums = (_numbers(_RAILS.sub("", item.name)) | _rail_heights(item.name)) - {"2024", "2020", "5"}
    wanted = row_nums | ctx.heights
    want_len, item_len = _lengths(row_nums), _lengths(item_nums | _numbers(item.code))
    if want_len and item_len:
        score += 2 if want_len & item_len else -4
        item_nums = {n for n in item_nums if not _lengths({n})}
    for n in item_nums:
        if n in wanted:
            score += 2
        elif 35 <= float(n) <= 110 and wanted & {h for h in wanted if 35 <= float(h) <= 110}:
            score -= 4  # another stall height
    return score


def _qty_parts(row: ModelRow) -> list[float]:
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", row.qty_text or "")]
    if "+" in (row.qty_text or "") and len(nums) == 2:
        return nums
    return [row.qty / 2, row.qty / 2]


def resolve_row(model: ModelBOM, ctx: Context, row: ModelRow, express: StockList) -> list[Resolved]:
    base = Resolved(model.name, row.item_no, row.raw_code or ", ".join(row.codes), row.name, row.qty, row.qty_text,
                    remark=row.remark, image=row.image, size=row.size,
                    side={"L": "ซ้าย", "R": "ขวา"}.get(_side(row.name), ""))
    # 1. a code in the sheet that Express has as it is (not when the user chose another variant)
    exact = [find_by_code(c, express) for c in row.codes]
    exact = [e for e in exact if e]
    if exact and len(exact) == len(row.codes) and not ctx.fixed:
        out = []
        for i, item in enumerate(exact):
            r = replace(base)
            r.code, r.express_name, r.status, r.score = item.code, item.name, ST_EXACT, 99
            r.qty = row.qty if len(exact) == 1 else row.qty / len(exact)
            out.append(r)
        return out
    name = row.name or ""
    if ctx.frame and "เฟรม" not in name:
        name = name + ctx.frame
    elif ctx.frame and name.endswith("เฟรม"):
        name = name + ctx.frame[4:]
    row_core = _core(name)
    row_words = _tokens(_core(row.name))
    optional = frozenset(_tokens(_core(ctx.frame)) - row_words) if ctx.frame else frozenset()
    row_nums = _numbers(row.name) | {n for c in row.codes for n in _numbers(c.split("(")[-1]) if "(" in c}
    row_nums |= {n for n in _numbers(f"{row.size} {model.name} {model.title}") if _lengths({n})}
    if ctx.fixed:
        if ctx.heights:
            row_nums = {n for n in row_nums if n not in STALL_HEIGHTS}
        if ctx.lengths:
            row_nums = {n for n in row_nums if not _lengths({n})} | ctx.lengths
    pool = [i for i in express.items if i.code.upper().startswith(("RRS", "RRA"))]
    scored = sorted(((_score(row, ctx, item, row_core, row_nums, row_words, optional), item) for item in pool), key=lambda t: -t[0])
    scored = [(s, i) for s, i in scored if s > 0]
    if not scored:
        base.status = ST_NOCODE if not row.codes else ST_NONE
        return [base]
    row_side = _side(row.name)
    wants_pair = not row_side and ("+" in (row.qty_text or "") or "ซ้าย" in row.remark or "ซ้าย" in row.name)

    def pick(side: str) -> tuple[float, StockItem, list[str]] | None:
        cands = [(s, i) for s, i in scored if not side or _item_side(i) == side]
        if not cands:
            return None
        best_s, best = cands[0]
        alts = [f"{i.code} {i.name}" for s, i in cands[1:4] if s >= best_s - 3]
        return best_s, best, alts

    def make(choice, qty: float, side: str) -> Resolved:
        s, item, alts = choice
        r = replace(base)
        r.code, r.express_name, r.score, r.side, r.qty = item.code, item.name, round(s, 1), side, qty
        r.alternatives = alts
        second = alts and next((sc for sc, it in scored if f"{it.code} {it.name}" == alts[0]), 0)
        r.status = ST_AUTO if s >= 10.5 and (not second or s - second >= 1.5) else ST_CHECK if s >= 7.5 else ST_NONE
        if r.status != ST_NONE and any(_key(item.code) == _key(c) for c in row.codes):
            r.status = ST_EXACT
        if r.status == ST_NONE:
            r.alternatives = [f"{item.code} {item.name}"] + alts
            r.code, r.express_name = "", ""
        return r

    if wants_pair:
        left, right = pick("L"), pick("R")
        near = [c for c in (left, right) if c and c[0] >= scored[0][0] - 3]
        if near and any(_item_side(c[1]) for c in near):
            q = _qty_parts(row)
            out = []
            for choice, qty, side in ((left, q[0], "ซ้าย"), (right, q[1], "ขวา")):
                if choice and choice[0] >= scored[0][0] - 3:
                    out.append(make(choice, qty, side))
                else:
                    r = replace(base)
                    r.side, r.qty, r.status = side, qty, ST_NONE
                    r.remark = f"Express ไม่มีรหัสข้าง{side} (มี {scored[0][1].code})"
                    out.append(r)
            return out
    choice = pick(row_side)
    if choice is None:
        base.status = ST_NONE
        return [base]
    return [make(choice, row.qty, {"L": "ซ้าย", "R": "ขวา"}.get(row_side, ""))]


STALL_HEIGHTS = {"40", "50", "55", "60", "65", "71", "72", "80", "84"}
# Choices of the variant dialog (เลือกรุ่นย่อย): label -> brands used for scoring
VARIANT_BRANDS = {
    "Toyota (Revo / Vigo)": {"TOYOTA", "REVO"},
    "Toyota Champ": {"TOYOTA", "CHAMP"},
    "Mitsubishi": {"MITSU"},
    "Isuzu": {"ISUZU"},
    "Nissan": {"NISSAN"},
    "ใช้ทุกรุ่น (RRS-A)": set(),
}
VARIANT_HEIGHTS = {"84 (คอกสูง 4 ราว)": "84", "80 (คอกสูง 3 ราว)": "80", "60 (คอกสูง 2 ราว)": "60", "50": "50",
                   "40 (คอกเตี้ย)": "40"}
VARIANT_LENGTHS = {"2.30 ม.": "230", "2.40 ม.": "240", "2.50 ม.": "250"}


def variant_context(model: ModelBOM, brand: str = "", height: str = "", length: str = "") -> Context:
    """Context of a model with the brand / stall height / body length the user picked ('' = as the sheet says)."""
    ctx = model_context(model)
    if brand in VARIANT_BRANDS:
        ctx.brands = {b for b in ctx.brands if b in ("PR", "2024", "CRANE")} | VARIANT_BRANDS[brand]
        ctx.toyota_plain = brand.startswith("Toyota (")
        if ctx.toyota_plain:
            ctx.brands.discard("REVO")
    if height:
        ctx.heights = {VARIANT_HEIGHTS.get(height, height)}
    if length:
        ctx.lengths = {VARIANT_LENGTHS.get(length, length)}
    ctx.fixed = bool(brand or height or length)
    return ctx


def resolve_variant(model: ModelBOM, express: StockList, brand: str = "", height: str = "",
                    length: str = "") -> list[Resolved]:
    ctx = variant_context(model, brand, height, length)
    return [r for row in model.rows for r in resolve_row(model, ctx, row, express)]


def row_options(r: Resolved, express: StockList, limit: int = 15) -> list[tuple[str, str]]:
    """Codes a person can pick for one row: the chosen one, the near alternatives, then every Express
    variant of the sheet's base code (same side)."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(code: str, name: str) -> None:
        if code and _key(code) not in seen:
            seen.add(_key(code))
            out.append((code, name))

    add(r.code, r.express_name)
    for alt in r.alternatives:
        code, _, name = alt.partition(" ")
        add(code, name)
    side = {"ซ้าย": "L", "ขวา": "R"}.get(r.side, "")
    for raw in re.split(r"[,/]", r.old_code or ""):
        base = base_code(raw.strip())
        for item in find_variants(base, express) + ([find_by_code(base, express)] if base else []):
            if item and (not side or not _item_side(item) or _item_side(item) == side):
                add(item.code, item.name)
    return out[:limit]


def resolved_to_parts(model: ModelBOM, rows: list[Resolved], sets: float = 1,
                      express: StockList | None = None) -> list:
    """Part List rows with the Express code (or the sheet's code when Express has none)."""
    from .models import Part

    parts = []
    for r in rows:
        item = find_by_code(r.code, express) if r.code and express else None
        notes = [r.remark] if r.remark else []
        if r.code and _key(r.code) != _key(r.old_code) and r.old_code:
            notes.append(f"รหัสเดิม {r.old_code}")
        if r.status not in (ST_EXACT, ST_AUTO):
            notes.append(r.status)
        code = r.code or r.old_code.split(",")[0].strip()
        name = r.express_name if r.code and r.express_name else side_name(r)
        parts.append(Part(item_no=r.item_no, part_no=code, drawing_no=model.name, name=name, spec=r.size,
                          qty=r.qty * sets, unit=(item.unit_name if item else "") or "ชิ้น",
                          stock_code=r.code, remark=" · ".join(n for n in notes if n), image=r.image))
    return parts


def resolve_models(models: list[ModelBOM], express: StockList) -> dict[str, list[Resolved]]:
    return {m.name: [r for row in m.rows for r in resolve_row(m, model_context(m), row, express)] for m in models}


_BOTH = re.compile(r"\s*\(?\s*(ข้าง)?ซ้าย\s*[-+/]\s*(ข้าง)?ขวา\s*\)?")


def side_name(r: Resolved) -> str:
    """'ราวล่าง ซ้าย-ขวา' on the ขวา line -> 'ราวล่าง (ขวา)'."""
    if not r.side:
        return r.name
    name = _BOTH.sub("", r.name).strip()
    return name if r.side in name else f"{name} ({r.side})"


def resolved_to_model(model: ModelBOM, rows: list[Resolved], keep_unmatched: bool = True) -> ModelBOM:
    """The same model with Express codes - what the program and the Google Sheet use.
    Rows Express does not have keep the code of the sheet (keep_unmatched) so nothing is lost."""
    out = []
    for r in rows:
        code = r.code or (r.old_code if keep_unmatched else "")
        notes = [r.remark] if r.remark else []
        if r.code and _key(r.code) != _key(r.old_code):
            notes.append(f"รหัสเดิม {r.old_code}" if r.old_code else "")
        if r.status not in (ST_EXACT, ST_AUTO):
            notes.append(r.status)
        out.append(ModelRow(item_no=r.item_no, raw_code=code, codes=[code] if code else [], name=side_name(r),
                            size=r.size, qty_text="", qty=r.qty, remark=" · ".join(n for n in notes if n),
                            image=r.image))
    return ModelBOM(name=model.name, title=model.title, rows=out, source=model.source)


def summary(resolved: dict[str, list[Resolved]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for rows in resolved.values():
        for r in rows:
            counts[r.status] = counts.get(r.status, 0) + 1
    return counts
