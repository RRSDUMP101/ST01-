"""Cutting plan for steel sheets from the flat patterns (รูปคลี่) of the drawings: real sheet count and scrap %.

Each part is placed as its bounding rectangle (rotation 90° allowed) with a gap between parts and a margin
at the sheet edge - the way a shear / laser operator lays out rectangular blanks. It is a safe estimate:
true-shape nesting can fit odd shapes closer. Parts are grouped by material and thickness; every sheet size
the store has for that thickness (from the item names, e.g. 4x8ฟุต / 1524x3050; none in stock: 4x8 and 5x10 ฟุต)
and every size added by hand (custom sheets, for every thickness or one) is tried and the size that needs the
least steel is used - or the size the user chose for that material and thickness. A part drawn at an angle is
first turned to its smallest bounding rectangle, and thick plates get more room between parts
(gap = thickness × gap_per_mm when that is more than the gap).
    utilization = net area of the parts ÷ area of the sheets used      scrap % = 100 − utilization
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from pathlib import Path

from .cad_fix import convex_hull
from .dwg_io import density_for, parse_thickness
from .models import Part, PartList
from .stock import StockList, _key, item_size_mm, material_family

DEFAULT_SHEETS = [(1219.0, 2440.0, "", "4x8 ฟุต"), (1524.0, 3048.0, "", "5x10 ฟุต")]
CUSTOM = "เพิ่มเอง"  # name of a sheet size added by hand
# plates that are another product of the same thickness: chosen by hand only, never by the plan itself
SPECIAL_SHEET_WORDS = ("ตะแกรง", "ตีนไก่", "ตีนเป็ด", "เจาะรู", "ลูกฟูก", "กันลื่น")


@dataclass
class NestParams:
    gap: float = 10.0  # between parts (kerf + clearance), mm
    margin: float = 10.0  # at the sheet edge, mm
    rotate: bool = True
    gap_per_mm: float = 0.0  # thick plates: gap at least thickness × this (0 = the same gap for every thickness)
    align: bool = False  # turn a part drawn at an angle to its smallest bounding rectangle first

    def gap_for(self, thickness: float) -> float:
        return max(self.gap, thickness * self.gap_per_mm)


@dataclass
class NestPart:
    key: str
    code: str
    name: str
    material: str
    thickness: float
    width: float
    height: float
    qty: int
    net_area: float = 0  # mm² of one piece (holes taken out); 0 = width × height
    weight: float = 0  # kg of one piece
    outline: list = field(default_factory=list)  # [outer, hole, hole ...] in mm, origin at the bbox corner
    job: str = ""  # SO / job the pieces are cut for ("" = from the Part List)
    bend_lines: list = field(default_factory=list)  # [[(x, y), (x, y)], ...] same coordinates as the outline
    fixes: list = field(default_factory=list)  # what the import repaired in its drawing (cad_fix.fix_summary)

    @property
    def area(self) -> float:
        return self.net_area or self.width * self.height


@dataclass
class Placement:
    part: int  # index in NestGroup.parts
    x: float  # corner of the box around the placed piece (mm from the sheet corner)
    y: float
    w: float  # size of that box
    h: float
    rotated: bool  # turned 90° (the plan's own placing)
    angle: float = 0.0  # placed by hand at any angle (degrees, counter-clockwise); 0 = `rotated` says 0 or 90°


@dataclass
class SheetLayout:
    width: float
    height: float
    placements: list[Placement] = field(default_factory=list)
    code: str = ""
    name: str = ""

    @property
    def size(self) -> str:
        return f"{self.width:.0f}x{self.height:.0f}"


@dataclass
class NestGroup:
    material: str
    family: str
    thickness: float
    parts: list[NestPart]
    sheet_w: float = 0
    sheet_h: float = 0
    sheet_code: str = ""
    sheet_name: str = ""
    sheets: list[SheetLayout] = field(default_factory=list)
    too_big: list[NestPart] = field(default_factory=list)
    tried: list[tuple[str, int, float]] = field(default_factory=list)  # (size, sheets, utilization)
    by_weight: float = 0  # sheets by the weight method (part kg ÷ sheet kg)
    gap: float = 0  # mm between parts used for this thickness
    options: list = field(default_factory=list)  # (width, length, code, name) sizes it could be cut from
    chosen: bool = False  # the sheet size was chosen by the user (not the one with the least steel)
    overflow: list = field(default_factory=list)  # sheets picked by hand for the parts too big for the main sheet

    @property
    def key(self) -> tuple[str, float]:
        return self.family, self.thickness

    @property
    def parts_area(self) -> float:
        return sum(self.parts[pl.part].area for s in self.sheets for pl in s.placements)

    @property
    def sheet_area(self) -> float:
        return sum(s.width * s.height for s in self.sheets)

    def sheet_counts(self) -> list[tuple[str, str, str, int]]:
        """(size, code, name, sheets) per sheet size used."""
        out: dict[str, list] = {}
        for s in self.sheets:
            row = out.setdefault(s.size, [s.size, s.code, s.name, 0])
            row[3] += 1
        return [tuple(r) for r in out.values()]

    @property
    def utilization(self) -> float:
        return self.parts_area / self.sheet_area if self.sheet_area else 0

    @property
    def scrap_pct(self) -> float:
        return 100 * (1 - self.utilization) if self.sheet_area else 0

    @property
    def last_sheet_use(self) -> float:
        """Share of the last sheet that is used (the rest can be kept as an offcut)."""
        if not self.sheets:
            return 0
        s = self.sheets[-1]
        return sum(self.parts[p.part].area for p in s.placements) / (s.width * s.height)

    @property
    def pieces(self) -> int:
        return sum(len(s.placements) for s in self.sheets)


# --------------------------------------------------------------------------
# MaxRects (best short side fit)
# --------------------------------------------------------------------------
class _MaxRects:
    def __init__(self, w: float, h: float):
        self.free = [(0.0, 0.0, w, h)]

    def insert(self, w: float, h: float, rotate: bool) -> tuple[float, float, float, float, bool] | None:
        best, score = None, (math.inf, math.inf)
        for fx, fy, fw, fh in self.free:
            for rw, rh, rot in ((w, h, False), (h, w, True)) if rotate and w != h else ((w, h, False),):
                if rw <= fw + 1e-6 and rh <= fh + 1e-6:
                    s = (min(fw - rw, fh - rh), max(fw - rw, fh - rh))
                    if s < score:
                        best, score = (fx, fy, rw, rh, rot), s
        if best:
            self._split(best[:4])
        return best

    def _split(self, used: tuple[float, float, float, float]) -> None:
        ux, uy, uw, uh = used
        out = []
        for fx, fy, fw, fh in self.free:
            if ux >= fx + fw or ux + uw <= fx or uy >= fy + fh or uy + uh <= fy:
                out.append((fx, fy, fw, fh))
                continue
            if ux > fx:
                out.append((fx, fy, ux - fx, fh))
            if ux + uw < fx + fw:
                out.append((ux + uw, fy, fx + fw - ux - uw, fh))
            if uy > fy:
                out.append((fx, fy, fw, uy - fy))
            if uy + uh < fy + fh:
                out.append((fx, uy + uh, fw, fy + fh - uy - uh))
        out = [r for r in out if r[2] > 1e-6 and r[3] > 1e-6]
        self.free = [r for i, r in enumerate(out)
                     if not any(j != i and _contains(o, r) and (o != r or j < i) for j, o in enumerate(out))]


def _contains(a, b) -> bool:
    return a[0] <= b[0] + 1e-6 and a[1] <= b[1] + 1e-6 and a[0] + a[2] >= b[0] + b[2] - 1e-6 and \
        a[1] + a[3] >= b[1] + b[3] - 1e-6


def pack(parts: list[NestPart], sheet_w: float, sheet_h: float, params: NestParams) -> tuple[list[SheetLayout], list[int]]:
    """Place every piece; returns the sheets and the indexes of parts that do not fit on this sheet size."""
    g, m = params.gap, params.margin
    usable_w, usable_h = sheet_w - 2 * m + g, sheet_h - 2 * m + g
    pieces = [(i, p.width + g, p.height + g) for i, p in enumerate(parts) for _ in range(max(0, int(p.qty)))]
    pieces.sort(key=lambda t: (-max(t[1], t[2]), -t[1] * t[2]))
    too_big = sorted({i for i, w, h in pieces if not _fits(w, h, usable_w, usable_h, params.rotate)})
    sheets: list[tuple[SheetLayout, _MaxRects]] = []
    for i, w, h in pieces:
        if i in too_big:
            continue
        spot = None
        for layout, packer in sheets:
            spot = packer.insert(w, h, params.rotate)
            if spot:
                break
        if spot is None:
            layout, packer = SheetLayout(sheet_w, sheet_h), _MaxRects(usable_w, usable_h)
            sheets.append((layout, packer))
            spot = packer.insert(w, h, params.rotate)
        x, y, rw, rh, rot = spot
        layout.placements.append(Placement(i, x + m, y + m, rw - g, rh - g, rot))
    return [s for s, _p in sheets], too_big


def free_space(sheet: SheetLayout, params: NestParams) -> _MaxRects:
    """The free rectangles of a sheet that already has parts on it (gap and edge margin kept)."""
    g, m = params.gap, params.margin
    packer = _MaxRects(sheet.width - 2 * m + g, sheet.height - 2 * m + g)
    for pl in sheet.placements:
        packer._split((pl.x - m, pl.y - m, pl.w + g, pl.h + g))
    return packer


def fill_sheet(sheet: SheetLayout, part_index: int, part: NestPart, qty: int, params: NestParams) -> int:
    """Put up to `qty` more pieces of `part` (qty <= 0: as many as fit) in the free space of the sheet.
    Returns the pieces placed - the ones that fit; the parts already there do not move."""
    g, m = params.gap, params.margin
    packer = free_space(sheet, params)
    placed = 0
    while qty <= 0 or placed < qty:
        spot = packer.insert(part.width + g, part.height + g, params.rotate)
        if spot is None:
            break
        x, y, rw, rh, rot = spot
        sheet.placements.append(Placement(part_index, x + m, y + m, rw - g, rh - g, rot))
        placed += 1
        if placed >= 10000:
            break
    return placed


def free_pct(sheet: SheetLayout, params: NestParams) -> float:
    """Share of the usable sheet not covered by the parts' rectangles (with their gap)."""
    g, m = params.gap, params.margin
    usable = max(1e-6, (sheet.width - 2 * m + g) * (sheet.height - 2 * m + g))
    used = sum((pl.w + g) * (pl.h + g) for pl in sheet.placements)
    return max(0.0, 1 - used / usable)


def add_to_group(group: NestGroup, sheet_index: int, part: NestPart, qty: int, params: NestParams) -> int:
    """Nest a part by hand in the free space of one sheet of a plan (filler pieces, ตัดเพิ่มเอง)."""
    from dataclasses import replace as _replace

    index = next((i for i, p in enumerate(group.parts) if p.key == part.key), None)
    if index is None:
        group.parts.append(_replace(part, qty=0))
        index = len(group.parts) - 1
    gp = _replace(params, gap=group.gap or params.gap_for(group.thickness))
    placed = fill_sheet(group.sheets[sheet_index], index, group.parts[index], qty, gp)
    group.parts[index].qty += placed
    return placed


def _pack_on(items: list[NestPart], which: list[int], sheet: tuple[float, float, str, str],
             params: NestParams) -> tuple[list[SheetLayout], list[int]]:
    """Pack the parts `which` on one sheet size; returns the sheets and the parts that did not fit."""
    w, h, code, name = sheet
    subset = [items[i] for i in which]
    sheets, too_big = pack(subset, w, h, params)
    for s in sheets:
        s.code, s.name = code, name
        for pl in s.placements:
            pl.part = which[pl.part]
    return sheets, [which[i] for i in too_big]


def _fits(w: float, h: float, uw: float, uh: float, rotate: bool) -> bool:
    return (w <= uw + 1e-6 and h <= uh + 1e-6) or (rotate and h <= uw + 1e-6 and w <= uh + 1e-6)


# --------------------------------------------------------------------------
# From the Part List
# --------------------------------------------------------------------------
_SPEC_DIMS = re.compile(r"(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*$")
_NET_AREA = re.compile(r"พื้นที่สุทธิ\s*([\d.,]+)\s*m²")


def part_size(part: Part) -> tuple[float, float] | None:
    """Flat size from the outline, or from a spec like 't2.5 x 300 x 1200'."""
    outline = getattr(part, "outline", None)
    if outline and outline[0]:
        xs = [p[0] for p in outline[0]]
        ys = [p[1] for p in outline[0]]
        return max(xs) - min(xs), max(ys) - min(ys)
    spec = re.sub(r"^\s*(?:t|thk\.?|หนา)\s*=?\s*\d+(?:\.\d+)?\s*(?:mm)?\s*[xX×*]?\s*", "", part.spec or "", flags=re.I)
    m = _SPEC_DIMS.search(spec)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None


def spec_thickness(spec: str) -> float:
    """Only an explicit thickness: 't2.5 x 300 x 1200', 'THK 3', '3 x 300 x 1200' - never a length."""
    text = spec or ""
    m = re.match(r"\s*(?:t|thk\.?|หนา)\s*=?\s*(\d+(?:\.\d+)?)", text, re.I)
    if m:
        return float(m.group(1))
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)", text)
    if m:
        a, b, c = (float(v) for v in m.groups())
        if a <= 25 and a < min(b, c):  # 3 x 100 x 200 is a plate; 50 x 50 x 2.3 is a tube
            return a
    return 0


def nest_parts_from(partlist: PartList, build_qty: int | None = None,
                    default_thickness: float = 0) -> tuple[list[NestPart], list[Part]]:
    """Plate parts with a thickness and a flat size; returns (parts to nest, parts left out).
    default_thickness is used for flat patterns whose drawing gives no thickness (0 = leave them out)."""
    build = build_qty if build_qty is not None else max(1, partlist.info.build_qty)
    out, skipped = [], []
    for i, part in enumerate(partlist.parts):
        thk = part.thickness or spec_thickness(part.spec) or (default_thickness if part.outline else 0)
        size = part_size(part)
        if not thk or not size or part.process == "ซื้อสำเร็จ":
            skipped.append(part)
            continue
        m = _NET_AREA.search(part.remark or "")
        net = float(m.group(1).replace(",", "")) * 1e6 if m else 0
        out.append(NestPart(key=str(i), code=part.part_no, name=part.name, material=part.material or "SS400",
                            thickness=thk, width=size[0], height=size[1], qty=math.ceil(part.qty * build),
                            net_area=net, weight=part.weight, outline=getattr(part, "outline", None) or [],
                            bend_lines=list(part.bend_lines), fixes=list(part.cad_fixes)))
    return out, skipped


def _rotate(points, cos_a: float, sin_a: float):
    return [(x * cos_a - y * sin_a, x * sin_a + y * cos_a) for x, y in points]


def best_orientation(part: NestPart, min_gain: float = 0.03) -> NestPart:
    """The part turned so its bounding rectangle is smallest (a bracket drawn at 30° takes a smaller blank);
    the same part when turning saves less than min_gain of the rectangle."""
    if not part.outline or len(part.outline[0]) < 3:
        return part
    outer = [(float(x), float(y)) for x, y in part.outline[0]]
    hull = convex_hull(outer)
    xs, ys = [p[0] for p in outer], [p[1] for p in outer]
    now = (max(xs) - min(xs)) * (max(ys) - min(ys))
    best = (now, 0.0)
    for (x0, y0), (x1, y1) in zip(hull, hull[1:] + hull[:1]):
        angle = -math.atan2(y1 - y0, x1 - x0)
        pts = _rotate(hull, math.cos(angle), math.sin(angle))
        px, py = [p[0] for p in pts], [p[1] for p in pts]
        area = (max(px) - min(px)) * (max(py) - min(py))
        if area < best[0] - 1e-6:
            best = (area, angle)
    area, angle = best
    if not now or area > now * (1 - min_gain):
        return part
    c, s = math.cos(angle), math.sin(angle)
    loops = [_rotate([(float(x), float(y)) for x, y in loop], c, s) for loop in part.outline]
    bends = [_rotate([(float(x), float(y)) for x, y in line], c, s) for line in part.bend_lines]
    ox = min(p[0] for p in loops[0])
    oy = min(p[1] for p in loops[0])
    loops = [[(round(x - ox, 2), round(y - oy, 2)) for x, y in loop] for loop in loops]
    bends = [[(round(x - ox, 2), round(y - oy, 2)) for x, y in line] for line in bends]
    w = max(p[0] for p in loops[0])
    h = max(p[1] for p in loops[0])
    return replace(part, outline=loops, bend_lines=bends, width=round(w, 2), height=round(h, 2))


def sheet_options(stock: StockList, family: str, thickness: float) -> list[tuple[float, float, str, str]]:
    """(width, length, code, name) of the sheets in stock with this material family and thickness: every item
    with a code (two items of one size are two choices, the one with more on hand first); a sheet without a code
    (the สต๊อกเหล็ก tab of the company file) only when no coded item has its size (3048 vs 3050 is one size)."""
    out = []
    for item in stock.items:
        if not item.is_sheet:
            continue
        if material_family(item.material or item.name) != family or parse_thickness(item.spec) != thickness:
            continue
        size = item_size_mm(item)
        if size:
            w, h = sorted(size)
            out.append((w, h, item.code, item.name, item.on_hand))
    out.sort(key=lambda o: (not o[2], -o[4]))
    coded = {(round(o[0] / 10), round(o[1] / 10)) for o in out if o[2]}
    seen: set = set()
    kept = []
    for w, h, code, name, _qty in out:
        size_key = (round(w / 10), round(h / 10))
        key = _key(code) if code else size_key
        if key in seen or (not code and size_key in coded):
            continue
        seen.add(key)
        kept.append((w, h, code, name))
    return kept


def custom_options(custom: list, thickness: float) -> list[tuple[float, float, str, str]]:
    """Sizes added by hand: custom = [(width, length, thickness or 0 = every thickness, note)]."""
    out = []
    for w, h, thk, note in custom or []:
        if w <= 0 or h <= 0 or (thk and abs(thk - thickness) > 1e-6):
            continue
        w, h = sorted((float(w), float(h)))
        out.append((w, h, "", f"{CUSTOM}: {note}" if note else CUSTOM))
    return out


def group_options(stock: StockList, family: str, thickness: float,
                  custom: list | None = None) -> list[tuple[float, float, str, str]]:
    """The sheets a material/thickness can be cut from, smallest first: the plates in stock - each item of the
    steel stock with its code - (none: the standard 4x8 and 5x10 ฟุต) and the sizes added by hand that no stock
    item has."""
    stocked = sheet_options(stock, family, thickness) or list(DEFAULT_SHEETS)
    sizes = {(round(o[0] / 10), round(o[1] / 10)) for o in stocked}
    added = [o for o in custom_options(custom, thickness) if (round(o[0] / 10), round(o[1] / 10)) not in sizes]
    seen: set = set()
    options = []
    for opt in added:
        key = (round(opt[0] / 10), round(opt[1] / 10))
        if key not in seen:
            seen.add(key)
            options.append(opt)
    return sorted(stocked + options, key=lambda o: (is_special(o), o[0] * o[1]))


def is_special(option: tuple) -> bool:
    """A mesh, checker or perforated plate (ตะแกรง / ตีนไก่ / เจาะรู …): offered in the list, not picked by the plan."""
    return any(w in option[3] for w in SPECIAL_SHEET_WORDS)


def same_size(option: tuple, size: tuple) -> bool:
    w, h = sorted(size[:2])
    return round(option[0] / 10) == round(w / 10) and round(option[1] / 10) == round(h / 10)


def chosen_option(options: list[tuple], want: tuple) -> tuple | None:
    """The option a person picked: want = (width, length) or (width, length, code) - the item of that code,
    else the size."""
    code = want[2] if len(want) > 2 else ""
    if code:
        found = next((o for o in options if o[2] and _key(o[2]) == _key(code)), None)
        if found is not None:
            return found
    return next((o for o in options if same_size(o, want)), None)


def _typed(options: list[tuple], want: tuple) -> tuple:
    """The option picked by hand, or a size typed for this plan."""
    pick = chosen_option(options, want)
    if pick is None:
        w, h = sorted(want[:2])
        pick = (float(w), float(h), "", f"{CUSTOM} {w:.0f}x{h:.0f}")
    return pick


def overflow_options(group: NestGroup, size: str, params: NestParams | None = None) -> list[tuple]:
    """The sheets of the group's list every part on its `size` sheets ('1524x3048') fits on - the ones that can
    be picked instead for the parts too big for the main sheet."""
    gp = replace(params or NestParams(), gap=group.gap or (params or NestParams()).gap)
    on = {pl.part for s in group.sheets if s.size == size for pl in s.placements}
    out = []
    for option in group.options:
        uw, uh = option[0] - 2 * gp.margin + gp.gap, option[1] - 2 * gp.margin + gp.gap
        if all(_fits(group.parts[i].width + gp.gap, group.parts[i].height + gp.gap, uw, uh, gp.rotate) for i in on):
            out.append(option)
    return out


def plan(parts: list[NestPart], stock: StockList | None = None, params: NestParams | None = None,
         densities: dict[str, float] | None = None, custom: list | None = None,
         chosen: dict[tuple[str, float], tuple] | None = None,
         overflow: dict[tuple[str, float], list[tuple]] | None = None) -> list[NestGroup]:
    """custom: sheet sizes added by hand (custom_options) · chosen: (family, thickness) -> (width, length) or
    (width, length, stock code) the user picked for that group, instead of the sheet with the least steel ·
    overflow: (family, thickness) -> the sheets picked for the parts too big for the main sheet, tried in that
    order before the smallest size they fit."""
    params = params or NestParams()
    stock = stock or StockList()
    groups: dict[tuple[str, float], list[NestPart]] = {}
    for p in parts:
        groups.setdefault((material_family(p.material), p.thickness), []).append(p)
    out = []
    for (family, thk), items in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        if params.align and params.rotate:
            items = [best_orientation(p) for p in items]
        gp = replace(params, gap=params.gap_for(thk))
        group = NestGroup(material=items[0].material, family=family, thickness=thk, parts=items, gap=gp.gap)
        options = group_options(stock, family, thk, custom)
        plain = [o for o in options if not is_special(o)] or options
        primaries = plain
        want = (chosen or {}).get((family, thk))
        if want:
            pick = _typed(options, want)
            if pick not in options:  # a size typed for this plan
                options = sorted(options + [pick], key=lambda o: (is_special(o), o[0] * o[1]))
            primaries, group.chosen = [pick], True
        group.options = options
        group.overflow = [_typed(options, w) for w in (overflow or {}).get((family, thk), [])]
        best = None
        tried: set = set()
        for primary in primaries:
            size_key = (round(primary[0] / 10), round(primary[1] / 10))
            if size_key in tried:
                continue  # another item of a size already tried (the one with more on hand came first)
            tried.add(size_key)
            sheets, left = _pack_on(items, list(range(len(items))), primary, gp)
            for pick in group.overflow:  # the sheets picked for them first
                if left:
                    more, left = _pack_on(items, left, pick, gp)
                    sheets += more
            # parts too big for this size go on the smallest size they fit
            for bigger in sorted(plain, key=lambda o: o[0] * o[1]):
                if not left or bigger[0] * bigger[1] <= primary[0] * primary[1]:
                    continue
                more, left = _pack_on(items, left, bigger, gp)
                sheets += more
            area = sum(x.width * x.height for x in sheets)
            placed = sum(items[pl.part].area for x in sheets for pl in x.placements)
            group.tried.append((f"{primary[0]:.0f}x{primary[1]:.0f}", len(sheets), placed / area if area else 0))
            rank = (len(left), area, len(sheets))
            if best is None or rank < best[0]:
                best = (rank, primary, sheets, left)
        _rank, primary, group.sheets, left = best
        group.sheet_w, group.sheet_h, group.sheet_code, group.sheet_name = primary
        group.too_big = [items[i] for i in left]
        sheet_kg = group.sheet_w * group.sheet_h * thk * density_for(group.material, densities) * 1e-6
        part_kg = sum((p.weight or p.area * thk * density_for(p.material, densities) * 1e-6) * p.qty for p in items)
        group.by_weight = part_kg / sheet_kg if sheet_kg else 0
        out.append(group)
    return out


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
PLAN_HEADERS = ["วัสดุ", "ความหนา (มม.)", "แผ่นที่ใช้", "รหัสแผ่น", "ขนาดแผ่น (มม.)", "จำนวนแผ่น (วางจริง)",
                "จำนวนแผ่น (คิดจากน้ำหนัก)", "ชิ้นงาน (ชิ้น)", "ใช้เนื้อเหล็ก %", "เศษ %", "แผ่นสุดท้ายใช้ %",
                "ขนาดที่ลอง", "ชิ้นใหญ่เกินแผ่น"]


def plan_rows(groups: list[NestGroup]) -> list[list]:
    """One row per material/thickness and sheet size."""
    rows = []
    for g in groups:
        counts = g.sheet_counts() or [(f"{g.sheet_w:.0f}x{g.sheet_h:.0f}", g.sheet_code, g.sheet_name, 0)]
        for k, (size, code, name, n) in enumerate(counts):
            first = k == 0
            rows.append([g.material, g.thickness, name, code, size.replace("x", " x "), n,
                         round(g.by_weight, 2) if first else "", g.pieces if first else "",
                         round(g.utilization * 100, 1) if first else "", round(g.scrap_pct, 1) if first else "",
                         round(g.last_sheet_use * 100, 1) if first else "",
                         ", ".join(f"{s}: {c} แผ่น {u:.0%}" for s, c, u in g.tried) if first else "",
                         ", ".join(f"{p.code or p.name} {p.width:.0f}x{p.height:.0f}" for p in g.too_big)
                         if first else ""])
    return rows


def export_plan(groups: list[NestGroup], path: str | Path, params: NestParams, title: str = "") -> None:
    from .tabular import Sheet, write_workbook

    detail = []
    for g in groups:
        for n, s in enumerate(g.sheets, start=1):
            for pl in s.placements:
                p = g.parts[pl.part]
                detail.append([f"{g.material} t{g.thickness:g}", n, p.code, p.name, round(pl.x), round(pl.y),
                               round(pl.w), round(pl.h),
                               f"หมุน {placement_angle(pl):g}°" if placement_angle(pl) else ""])
    head = [[title or "แผนตัดแผ่นเหล็กจากรูปคลี่"],
            ["ระยะห่างชิ้นงาน (มม.)", params.gap, "ขอบแผ่น (มม.)", params.margin,
             "วิธีวาง", "สี่เหลี่ยมล้อมรูป หมุน 90° ได้" if params.rotate else "สี่เหลี่ยมล้อมรูป ไม่หมุน"]]
    write_workbook(path, [
        Sheet("แผนตัด", PLAN_HEADERS, plan_rows(groups), title_rows=head),
        Sheet("ตำแหน่งชิ้นงาน", ["วัสดุ/หนา", "แผ่นที่", "รหัส", "ชิ้นงาน", "X (มม.)", "Y (มม.)", "กว้าง", "ยาว", "หมุน"],
              detail),
    ])


def export_dxf(groups: list[NestGroup], path: str | Path) -> None:
    """All sheets side by side, one layer per material/thickness: sheet outline, parts (outline or rectangle), labels."""
    import ezdxf

    doc = ezdxf.new("R2010")
    doc.units = 4  # mm
    msp = doc.modelspace()
    x0, y0 = 0.0, 0.0
    for g in groups:
        layer = f"NEST_{g.family}_T{g.thickness:g}".replace(".", "_")
        doc.layers.add(layer)
        for n, s in enumerate(g.sheets, start=1):
            msp.add_lwpolyline([(x0, y0), (x0 + s.width, y0), (x0 + s.width, y0 + s.height), (x0, y0 + s.height)],
                               close=True, dxfattribs={"layer": layer, "color": 8})
            msp.add_text(f"{g.material} t{g.thickness:g} แผ่นที่ {n}/{len(g.sheets)}",
                         dxfattribs={"layer": layer, "height": 40}).set_placement((x0, y0 - 70))
            for pl in s.placements:
                p = g.parts[pl.part]
                loops = p.outline or [[(0, 0), (p.width, 0), (p.width, p.height), (0, p.height)]]
                for loop in loops:
                    pts = [place_point(pt, p, pl, x0, y0) for pt in loop]
                    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer, "color": 1})
                label = (p.code or p.name)[:24]
                msp.add_text(label, dxfattribs={"layer": layer, "height": min(30, max(8, min(pl.w, pl.h) / 6))}
                             ).set_placement((x0 + pl.x + pl.w / 2, y0 + pl.y + pl.h / 2),
                                             align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
            x0 += s.width + 200
        x0, y0 = 0.0, y0 + max((s.height for s in g.sheets), default=0) + 400
    doc.saveas(path)


def place_point(pt, part: NestPart, pl: Placement, x0: float, y0: float) -> tuple[float, float]:
    xs = [q[0] for q in (part.outline[0] if part.outline else [(0, 0)])]
    ys = [q[1] for q in (part.outline[0] if part.outline else [(0, 0)])]
    px, py = pt[0] - min(xs), pt[1] - min(ys)
    if pl.angle % 360:  # any angle: turned about the box corner, then moved into the placed box
        a = math.radians(pl.angle)
        _w, _h, dx, dy = rotated_box(part, pl.angle)
        rx = px * math.cos(a) - py * math.sin(a) - dx
        ry = px * math.sin(a) + py * math.cos(a) - dy
        return x0 + pl.x + rx, y0 + pl.y + ry
    if pl.rotated:  # 90° counter-clockwise inside the placed box
        px, py = part.height - py, px
    return x0 + pl.x + px, y0 + pl.y + py


# --------------------------------------------------------------------------
# Placing by hand: any angle, moved anywhere, checked against the edge and the other pieces
# --------------------------------------------------------------------------
def placement_angle(pl: Placement) -> float:
    """The angle a piece is placed at, 0 … 360°."""
    return pl.angle % 360 if pl.angle % 360 else (90.0 if pl.rotated else 0.0)


def _outer(part: NestPart) -> list:
    if part.outline:
        return part.outline[0]
    return [(0.0, 0.0), (part.width, 0.0), (part.width, part.height), (0.0, part.height)]


def rotated_box(part: NestPart, angle: float) -> tuple[float, float, float, float]:
    """(width, height, dx, dy): the box around the part's outline turned by `angle`° about its corner, and where
    that box starts (kept on the part: a piece is drawn many times while it is dragged)."""
    angle = round(angle % 360, 6)
    cache = part.__dict__.setdefault("_turned", {})
    hit = cache.get(angle)
    if hit is None:
        outer = _outer(part)
        x0, y0 = min(q[0] for q in outer), min(q[1] for q in outer)
        a = math.radians(angle)
        c, s = math.cos(a), math.sin(a)
        xs = [(x - x0) * c - (y - y0) * s for x, y in outer]
        ys = [(x - x0) * s + (y - y0) * c for x, y in outer]
        hit = tuple(round(v, 6) for v in (max(xs) - min(xs), max(ys) - min(ys), min(xs), min(ys)))
        cache[angle] = hit
    return hit


def turn(pl: Placement, part: NestPart, angle: float) -> None:
    """Turn a placed piece to `angle`° (any angle), about the middle of its box."""
    angle = angle % 360
    if abs(angle - round(angle)) < 1e-9:
        angle = float(round(angle)) % 360
    cx, cy = pl.x + pl.w / 2, pl.y + pl.h / 2
    if angle == 90:
        pl.rotated, pl.angle = True, 0.0
    elif angle == 0:
        pl.rotated, pl.angle = False, 0.0
    else:
        pl.rotated, pl.angle = False, angle
    w, h, _dx, _dy = rotated_box(part, placement_angle(pl))
    pl.w, pl.h = w, h
    pl.x, pl.y = cx - w / 2, cy - h / 2


def place_piece(sheet: SheetLayout, part_index: int, part: NestPart, cx: float, cy: float,
                angle: float = 0.0) -> Placement:
    """One piece put down by hand with the middle of its box at (cx, cy)."""
    pl = Placement(part_index, cx - part.width / 2, cy - part.height / 2, part.width, part.height, False)
    turn(pl, part, angle)
    sheet.placements.append(pl)
    return pl


def placed_outline(part: NestPart, pl: Placement) -> list:
    """The outer cut line of a placed piece in sheet coordinates."""
    return [place_point(pt, part, pl, 0, 0) for pt in _outer(part)]


def _too_close(a, b, gap: float) -> float | None:
    """Two closed outlines: None when they are at least `gap` apart, else how close they are (0 = they touch or
    overlap)."""
    import numpy as np

    pa, pb = np.asarray(a, float), np.asarray(b, float)
    lo = np.maximum(pa.min(0), pb.min(0)) - gap
    hi = np.minimum(pa.max(0), pb.max(0)) + gap
    if (lo > hi).any():
        return None

    def edges(p):
        q = np.roll(p, -1, axis=0)
        keep = ~((np.maximum(p, q) < lo).any(1) | (np.minimum(p, q) > hi).any(1))
        return p[keep], q[keep]

    a0, a1 = edges(pa)
    b0, b1 = edges(pb)
    if _inside(pa[0], pb) or _inside(pb[0], pa):
        return 0.0
    if not len(a0) or not len(b0):
        return None

    def cross(o, p, q):
        return (p[..., 0] - o[..., 0]) * (q[..., 1] - o[..., 1]) - (p[..., 1] - o[..., 1]) * (q[..., 0] - o[..., 0])

    A0, A1 = a0[:, None, :], a1[:, None, :]
    B0, B1 = b0[None, :, :], b1[None, :, :]
    d1, d2 = cross(B0, B1, A0), cross(B0, B1, A1)
    d3, d4 = cross(A0, A1, B0), cross(A0, A1, B1)
    if ((d1 * d2 < 0) & (d3 * d4 < 0)).any():
        return 0.0

    def point_seg(p, s0, s1):  # every point of p to every segment s0-s1
        d = s1 - s0
        ln = (d ** 2).sum(-1)
        t = np.clip(((p[:, None, :] - s0[None]) * d[None]).sum(-1) / np.where(ln > 0, ln, 1), 0, 1)
        near = s0[None] + t[..., None] * d[None]
        return np.sqrt(((p[:, None, :] - near) ** 2).sum(-1)).min()

    dist = min(point_seg(a0, b0, b1), point_seg(b0, a0, a1))
    return float(dist) if dist < gap - 1e-6 else None


def _inside(pt, poly) -> bool:
    x, y = float(pt[0]), float(pt[1])
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


OFF_SHEET, OVERLAP, TOO_CLOSE, NEAR_EDGE = "เกินขอบแผ่น", "ทับกัน", "ชิดกันเกิน", "ชิดขอบแผ่น"
BLOCKING = (OFF_SHEET, OVERLAP)  # cannot be cut; the others only come closer than the plan would


def layout_problems(sheet: SheetLayout, parts: list[NestPart], params: NestParams,
                    only: int | None = None) -> dict[int, tuple[str, str]]:
    """Pieces placed by hand that cannot be cut as they are: off the sheet (or inside the edge margin), on another
    piece, or closer to another piece than the gap. index -> (problem, what). only: check that piece alone."""
    outlines = [placed_outline(parts[pl.part], pl) for pl in sheet.placements]
    out: dict[int, tuple[str, str]] = {}
    m, gap = params.margin, params.gap
    for i, loop in enumerate(outlines):
        if only is not None and i != only:
            continue
        xs, ys = [q[0] for q in loop], [q[1] for q in loop]
        if min(xs) < -1e-6 or min(ys) < -1e-6 or max(xs) > sheet.width + 1e-6 or max(ys) > sheet.height + 1e-6:
            out[i] = (OFF_SHEET, "อยู่นอกแผ่น")
        elif min(xs) < m - 0.05 or min(ys) < m - 0.05 or max(xs) > sheet.width - m + 0.05 or \
                max(ys) > sheet.height - m + 0.05:
            out[i] = (NEAR_EDGE, f"ชิดขอบแผ่นเกินระยะขอบ {m:g} มม.")
    boxes = [(min(q[0] for q in o), min(q[1] for q in o), max(q[0] for q in o), max(q[1] for q in o)) for o in outlines]
    for i in range(len(outlines)):
        for j in range(i + 1, len(outlines)):
            if only is not None and only not in (i, j):
                continue
            a, b = boxes[i], boxes[j]
            if a[0] - gap > b[2] or b[0] - gap > a[2] or a[1] - gap > b[3] or b[1] - gap > a[3]:
                continue  # far apart: no need to look at the outlines
            d = _too_close(outlines[i], outlines[j], gap)
            if d is None:
                continue
            kind = OVERLAP if d <= 1e-6 else TOO_CLOSE
            for a, b in ((i, j), (j, i)):
                code = parts[sheet.placements[b].part].code or parts[sheet.placements[b].part].name
                text = f"ทับกับ {code}" if kind == OVERLAP else f"ห่าง {code} {d:.1f} มม. (ระยะห่าง {gap:g})"
                if a not in out or out[a][0] not in BLOCKING:
                    out[a] = (kind, text)
    return out
