"""Item code rules (ควบคุมการตั้งรหัส): one way to write a code, new codes made by that rule,
and a report of Express codes that break it.

The rule is read from the codes Express already has:

    RRS-<รุ่น>-<เลขชิ้นส่วน>[-<ข้าง>][-<ขนาด>][-<รุ่นย่อย>]       e.g. RRS-T-024-L-84-CHAMP
      รุ่น         A = ใช้ทุกรุ่น, T = Toyota, M/M1 = Mitsubishi, I = Isuzu, N = Nissan, S = Suzuki
      เลขชิ้นส่วน  3 digits, the same number for the same part in every รุ่น (024 = บังอาย, 102 = เสาหลัง)
      ข้าง         L / R
      ขนาด        stall height 40/50/60/80/84, body length 230/240/250, other sizes (209-2-50, 161CM)
      รุ่นย่อย     CHAMP, REVO, PR (พื้นเรียบ), CRANE, NEW/OLD, 2020/2024 ...
    raw material: <หมวด>-<กลุ่ม> -<ลำดับ>                     e.g. 01-B00 -0003 (as Express pads it)

Express keeps 20 characters of a code; its text reports print 16.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .stock import StockItem, StockList, _key

BRANDS = {"A": "ใช้ทุกรุ่น", "A1": "ใช้ทุกรุ่น (ชุดที่ 2)", "T": "Toyota", "M": "Mitsubishi", "M1": "Mitsubishi (ใหม่)",
          "I": "Isuzu", "N": "Nissan", "S": "Suzuki"}
VARIANTS = ["CHAMP", "REVO", "PR", "CRANE", "NEW", "OLD", "2020", "2024", "NV", "FT", "SP", "SPC", "SQ", "ST", "MT",
            "UP", "DOWN", "H", "LOW"]
HEIGHTS = ["40", "50", "51-5", "55", "60", "65", "71", "72", "80", "84", "105"]
MAX_LEN = 20  # Express code field
REPORT_LEN = 16  # Express text reports cut codes to this length

RRS_RE = re.compile(r"^RRS-(?P<brand>[A-Z]\d?)-(?P<num>\d{3})(?P<rest>(?:-[A-Z0-9]+)*)$")
RAW_RE = re.compile(r"^(?P<cat>\d{2})-(?P<grp>[A-Z]{1,3}\d{0,2}) ?-(?P<seq>\d{4})$")

LEVEL_ERROR = "ผิดรูปแบบ"
LEVEL_CHECK = "ควรตรวจ"
LEVEL_INFO = "แจ้งเตือน"
LEVEL_ORDER = {LEVEL_ERROR: 0, LEVEL_CHECK: 1, LEVEL_INFO: 2}


@dataclass
class CodeParts:
    brand: str = "A"
    number: str = ""
    side: str = ""  # "L" / "R"
    sizes: list[str] = field(default_factory=list)
    variants: list[str] = field(default_factory=list)

    def compose(self) -> str:
        bits = [f"RRS-{self.brand}-{self.number}"]
        if self.side:
            bits.append(self.side)
        bits += [s for s in self.sizes if s]
        bits += [v for v in self.variants if v]
        return "-".join(bits)


def parse_code(code: str) -> CodeParts | None:
    """'RRS-T-024-80-L' -> brand T, number 024, side L, sizes [80]. None when not an RRS code."""
    m = RRS_RE.match((code or "").strip().upper())
    if not m:
        return None
    parts = CodeParts(brand=m.group("brand"), number=m.group("num"))
    for seg in [s for s in m.group("rest").split("-") if s]:
        if seg in ("L", "R") and not parts.side:
            parts.side = seg
        elif seg in VARIANTS or seg.startswith("NO") or re.fullmatch(r"[A-Z]+", seg):
            parts.variants.append(seg)
        else:
            parts.sizes.append(seg)
    return parts


def canonical(code: str) -> str:
    """The same code written by the rule (upper case, side before sizes, sizes before variants)."""
    raw = re.sub(r"\s+", "", (code or "").upper()).replace("_", "-")
    raw = re.sub(r"-{2,}", "-", raw).strip("-")
    raw = re.sub(r"^RRA-", "RRS-", raw)
    raw = re.sub(r"^RRS-?([A-Z]1?)-?0*(\d{1,3})(?=-|$)", lambda m: f"RRS-{m.group(1)}-{int(m.group(2)):03d}", raw)
    parts = parse_code(raw)
    return parts.compose() if parts else (code or "").strip()


# --------------------------------------------------------------------------
# What the names say
# --------------------------------------------------------------------------
_PART_WORDS = ["ป้ายทะเบียน", "ปากนกแก้ว", "ซับคัดซี", "รางรถไฟ", "หน้าโปร", "บังโคลน", "บังอาย", "บานพับ", "หูช้าง",
               "หูล็อก", "กระดูก", "ผ้าใบ", "ปะกับ", "กล่อง", "ตะขอ", "กรอบ", "แผ่น", "หูบน", "พื้น", "เฟรม", "ฉาก",
               "ซอง", "ราง", "เสา", "ราว", "ฝา", "บู๊ช", "เต้า"]
_PLACE_WORDS = ["ข้าง", "ท้าย", "หน้า", "หลัง", "กลาง", "ล่าง", "บน", "ใน", "นอก"]
_WORDS = sorted(_PART_WORDS + _PLACE_WORDS, key=len, reverse=True)


def name_side(name: str) -> str:
    left, right = "ซ้าย" in (name or ""), "ขวา" in (name or "")
    return "L" if left and not right else "R" if right and not left else ""


def name_words(name: str) -> tuple[str, ...]:
    """The part words of a name in order: 'เสาหลัง(ซ้าย) 84 T-CHAMP' -> ('เสา', 'หลัง')."""
    text = re.sub(r"[\s\d().,+\-/A-Za-z]+", "", (name or "").replace("\xa0", ""))
    text = text.replace("ซ้าย", "").replace("ขวา", "").replace("หูล็อค", "หูล็อก")
    out, i = [], 0
    while i < len(text):
        for w in _WORDS:
            if text.startswith(w, i):
                out.append(w)
                i += len(w)
                break
        else:
            i += 1
    return tuple(out)


def name_heights(name: str) -> set[str]:
    nums = set(re.findall(r"(?<![\d.])(\d{2,3})(?![\d.])", (name or "").replace("\xa0", " ")))
    return {n for n in nums if n in HEIGHTS}


def _brand_in_name(name: str) -> set[str]:
    upper = (name or "").upper()
    out = set()
    if re.search(r"CHAMP|CHAM\b|แชมป์", upper):
        out.add("CHAMP")
    if "REVO" in upper:
        out.add("REVO")
    if "พื้นเรียบ" in (name or ""):
        out.add("PR")
    if "เครน" in (name or "") or "CRANE" in upper:
        out.add("CRANE")
    return out


# --------------------------------------------------------------------------
# Express code audit
# --------------------------------------------------------------------------
@dataclass
class CodeIssue:
    code: str
    name: str
    level: str
    problem: str
    suggestion: str = ""


AUDIT_HEADERS = ["รหัสสินค้า", "ชื่อสินค้า", "ระดับ", "ปัญหา", "รหัสที่ควรเป็น / ข้อเสนอ"]


def part_numbers(items: list[StockItem]) -> dict[str, tuple[str, ...]]:
    """Part number -> the part words most of its items carry (024 -> ('บังอาย',))."""
    seen: dict[str, Counter] = defaultdict(Counter)
    for item in items:
        p = parse_code(item.code)
        if p:
            words = name_words(item.name)
            if words:
                seen[p.number][words] += 1
    return {num: c.most_common(1)[0][0] for num, c in seen.items()}


def audit_codes(stock: StockList) -> list[CodeIssue]:
    items = [i for i in stock.items if i.code]
    issues: list[CodeIssue] = []

    def add(item: StockItem, level: str, problem: str, suggestion: str = "") -> None:
        issues.append(CodeIssue(item.code, item.name, level, problem, suggestion))

    by_key: dict[str, list[StockItem]] = defaultdict(list)
    for item in items:
        by_key[_key(item.code)].append(item)
    for same in by_key.values():
        if len(same) > 1:
            for item in same:
                others = ", ".join(i.code for i in same if i is not item)
                add(item, LEVEL_ERROR, f"รหัสซ้ำกับ {others} เมื่อไม่สนช่องว่าง/ขีด (ค้นหา/นำเข้าแล้วสับสน)")

    raw_spaced = sum(1 for i in items if RAW_RE.match(i.code.strip()) and " " in i.code)
    for item in items:
        code = item.code.strip()
        upper = code.upper()
        if RAW_RE.match(code):
            if raw_spaced and " " not in code:
                m = RAW_RE.match(code)
                add(item, LEVEL_CHECK, "รหัสวัตถุดิบไม่มีช่องว่างแบบรหัสอื่น", f"{m['cat']}-{m['grp']:<3} -{m['seq']}")
            continue
        if not upper.startswith(("RRS", "RRA")):
            continue
        fixed = canonical(code)
        if upper.startswith("RRA"):
            add(item, LEVEL_ERROR, "ขึ้นต้น RRA แทน RRS", fixed)
        if code != code.upper():
            p0 = parse_code(fixed)
            sib = [i.code for i in items if p0 and i is not item and (p := parse_code(canonical(i.code)))
                   and p.brand == p0.brand and p.number == p0.number][:3]
            add(item, LEVEL_ERROR, "มีตัวพิมพ์เล็ก", ("เทียบกับ " + ", ".join(sib)) if sib else fixed)
        if re.search(r"\s|_|--|-$", code):
            add(item, LEVEL_ERROR, "มีช่องว่าง / ขีดล่าง / ขีดซ้อน", fixed)
        parts = parse_code(fixed)
        if parts is None:
            add(item, LEVEL_ERROR, "ไม่ตรงรูปแบบ RRS-<รุ่น>-<เลข 3 หลัก>-…")
            continue
        if parts.brand not in BRANDS:
            add(item, LEVEL_CHECK, f"รหัสรุ่น {parts.brand} ไม่อยู่ในรายการ ({', '.join(BRANDS)})")
        segs = upper.split("-")[3:]
        if parts.side and segs and segs[0] != parts.side:
            add(item, LEVEL_CHECK, "ลำดับส่วนของรหัสต่างจากรหัสอื่น (ข้างควรอยู่ต่อจากเลขชิ้นส่วน)", fixed)
        if len(code) > MAX_LEN:
            add(item, LEVEL_ERROR, f"ยาว {len(code)} ตัว เกิน {MAX_LEN} ที่ Express เก็บได้")
        elif len(code) > REPORT_LEN:
            add(item, LEVEL_INFO, f"ยาว {len(code)} ตัว – รายงานข้อความของ Express ตัดเหลือ {REPORT_LEN} ตัว")
        if any(v == "CHAM" for v in parts.variants):
            add(item, LEVEL_CHECK, "CHAM ถูกตัด (ควรเป็น CHAMP) – รหัสยาวเต็ม 20 ตัว")
        side = name_side(item.name)
        if side and parts.side and side != parts.side:
            add(item, LEVEL_ERROR, f"ชื่อบอกข้าง{'ซ้าย' if side == 'L' else 'ขวา'} แต่รหัสเป็น -{parts.side}")
        elif side and not parts.side:
            p2 = CodeParts(parts.brand, parts.number, side, parts.sizes, parts.variants)
            add(item, LEVEL_CHECK, f"ชื่อบอกข้าง{'ซ้าย' if side == 'L' else 'ขวา'} แต่รหัสไม่มี -{side}", p2.compose())
        heights = name_heights(item.name)
        code_nums = set("-".join(parts.sizes).split("-"))
        missing = {h for h in heights if h not in code_nums and h.replace("-", ".") not in item.name}
        if heights and missing and not code_nums & heights:
            add(item, LEVEL_CHECK, f"ชื่อมีขนาด {', '.join(sorted(missing))} แต่รหัสไม่มี")
        brands = _brand_in_name(item.name)
        if "CHAMP" in brands and parts.brand not in ("T", "A") :
            add(item, LEVEL_CHECK, f"ชื่อเป็น Champ แต่รหัสรุ่นเป็น {parts.brand}")
        if "PR" in brands and "PR" not in parts.variants and parts.brand == "A" and "PR" not in upper:
            add(item, LEVEL_INFO, "ชื่อเป็นพื้นเรียบ แต่รหัสไม่มี PR")

    # the same part number for different parts (102 = เสาหลัง but one item says เสาหน้า)
    numbers = part_numbers(items)
    for item in items:
        parts = parse_code(canonical(item.code))
        if not parts or parts.number not in numbers:
            continue
        words, usual = name_words(item.name), numbers[parts.number]
        if words and usual and words[0] == usual[0] and words != usual and set(words) ^ set(usual) <= set(_PLACE_WORDS):
            add(item, LEVEL_CHECK, f"เลข {parts.number} ส่วนใหญ่เป็น {''.join(usual)} แต่ชื่อนี้เป็น {''.join(words)}")
    # left/right pairs written differently (RRS-T-024-L-84 / RRS-T-024-R-84-CHAMP)
    by_code = {_key(i.code): i for i in items}
    for item in items:
        parts = parse_code(canonical(item.code))
        if not parts or parts.side != "L":
            continue
        twin = CodeParts(parts.brand, parts.number, "R", parts.sizes, parts.variants).compose()
        if _key(twin) in by_code:
            continue
        others = [i for i in items if (p := parse_code(canonical(i.code))) and p.side == "R"
                  and p.brand == parts.brand and p.number == parts.number and p.sizes == parts.sizes]
        if others:
            add(item, LEVEL_CHECK, f"คู่ข้างขวาเขียนต่างกัน: {others[0].code}", twin)
    # one name, several codes
    names: dict[str, list[StockItem]] = defaultdict(list)
    for item in items:
        names[re.sub(r"\s+", "", item.name)].append(item)
    for same in names.values():
        if len(same) > 1 and len({_key(i.code) for i in same}) > 1:
            for item in same:
                others = [i.code for i in same if i is not item]
                add(item, LEVEL_CHECK, "ชื่อซ้ำกับ " + ", ".join(others[:3]) + (f" และอีก {len(others) - 3}"
                                                                                   if len(others) > 3 else ""))
    issues.sort(key=lambda i: (LEVEL_ORDER[i.level], i.code))
    return issues


def export_audit(issues: list[CodeIssue], path: str | Path, source: str = "") -> None:
    from .tabular import write_table

    rows = [[i.code, i.name, i.level, i.problem, i.suggestion] for i in issues]
    counts = Counter(i.level for i in issues)
    title = [["รายงานรหัสสินค้า Express ที่ผิดรูปแบบ / ควรตรวจ"],
             [f"ที่มา: {source}" if source else "", " · ".join(f"{k} {v}" for k, v in counts.items())]]
    write_table(path, AUDIT_HEADERS, rows, title_rows=title, sheet_title="CodeAudit")


# --------------------------------------------------------------------------
# New codes
# --------------------------------------------------------------------------
@dataclass
class NewCode:
    code: str
    exists: bool = False
    existing_name: str = ""
    number_source: str = ""  # how the part number was chosen
    warnings: list[str] = field(default_factory=list)


def next_number(stock: StockList) -> str:
    nums = [int(p.number) for i in stock.items if (p := parse_code(canonical(i.code)))]
    return f"{(max(nums) if nums else 0) + 1:03d}"


def number_for_name(name: str, stock: StockList) -> str:
    """The part number Express already uses for a part with this name (บังอาย -> 024)."""
    words = name_words(name)
    if not words:
        return ""
    numbers = part_numbers(stock.items)
    exact = [n for n, w in numbers.items() if w == words]
    if exact:
        return sorted(exact)[0]
    return ""


def new_code(stock: StockList, name: str, brand: str = "A", side: str = "", sizes: list[str] | None = None,
             variants: list[str] | None = None, number: str = "") -> NewCode:
    """A code by the rule for a new item; says if it (or the same item) already exists."""
    brand = (brand or "A").upper()
    side = {"ซ้าย": "L", "ขวา": "R"}.get(side, side or name_side(name)).upper()
    sizes = [str(s).replace(".", "-").strip().upper() for s in (sizes or []) if str(s).strip()]
    if not sizes:  # 'บังอาย T90(ซ้าย)' -> 90
        sizes = [n for n in re.findall(r"(?<![\d.])(\d{2,3})(?![\d.])", name or "") if n not in ("2020", "2024")][:1]
    variants = [v.strip().upper() for v in (variants or []) if v.strip()]
    for b in sorted(_brand_in_name(name)):
        if b not in variants and not (b == "CHAMP" and brand not in ("T", "A")):
            variants.append(b)
    source = "กำหนดเอง"
    if not number:
        number = number_for_name(name, stock)
        source = "เลขเดิมของชิ้นส่วนชื่อนี้ใน Express" if number else ""
    if not number:
        number = next_number(stock)
        source = "เลขถัดไป (ชิ้นส่วนใหม่)"
    number = f"{int(number):03d}" if str(number).isdigit() else str(number)
    code = CodeParts(brand, number, side if side in ("L", "R") else "", sizes, variants).compose()
    result = NewCode(code=code, number_source=source)
    existing = next((i for i in stock.items if _key(i.code) == _key(code)), None)
    if existing:
        result.exists, result.existing_name = True, existing.name
    same_name = next((i for i in stock.items if re.sub(r"\s+", "", i.name) == re.sub(r"\s+", "", name)), None)
    if same_name and not existing:
        result.warnings.append(f"มีชื่อนี้แล้วที่รหัส {same_name.code}")
    if brand not in BRANDS:
        result.warnings.append(f"รหัสรุ่น {brand} ไม่อยู่ในรายการ")
    if len(code) > MAX_LEN:
        result.warnings.append(f"ยาว {len(code)} ตัว เกิน {MAX_LEN}")
    elif len(code) > REPORT_LEN:
        result.warnings.append(f"ยาว {len(code)} ตัว (รายงานข้อความตัดเหลือ {REPORT_LEN})")
    return result
