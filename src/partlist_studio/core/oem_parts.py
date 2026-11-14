"""แคตตาล็อกอะไหล่แท้ Ford (OEM) – นำเข้าแผนภาพ (assembly) และรายการอะไหล่ เช่น Electrical > Headlamp Components
ของ 2026 Ford F-350 Super Duty จาก ford.oempartsonline.com (ไฟล์ JSON ที่ดึงมาแล้ว)

รูปแบบไฟล์ (หนึ่งไฟล์ = หนึ่งรุ่นรถ + หนึ่งหมวด)::

    {"source": "...", "vehicle": "2026 Ford F-350 Super Duty XL 7.3L V8 Gas",
     "category": "Electrical - Headlamp Components", "fetched_at": "2026-11-14T08:00:00Z",
     "assemblies": [{"assembly": 1, "title": "...", "url": "...", "diagram_image_url": "...",
                     "parts": [{"callout": "1", "part_number": "PC3Z-13008-A", "description": "...",
                                "notes": "...", "qty": "1", "msrp": "$1,234.56", "price": "$987.65", "url": "..."}]}]}

คลังแคตตาล็อกเก็บใน <data>/oem_catalogs/*.json – นำเข้าซ้ำ (รุ่น + หมวดเดียวกัน) จะแทนที่ของเดิม
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .models import Part

FORD_PN = re.compile(r"^([A-Z0-9]{4})-([A-Z0-9]{4,7})-([A-Z]{1,3}\d?)$")
PROCESS = "สั่งซื้อ (อะไหล่แท้ Ford)"


def _text(v) -> str:
    return "" if v is None else re.sub(r"\s+", " ", str(v)).strip()


def money(v) -> float:
    """'$1,234.56' / 'USD 12' / 12.5 → 12.5 · nothing → 0."""
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d[\d,]*(?:\.\d+)?", _text(v))
    return float(m.group(0).replace(",", "")) if m else 0.0


def qty_of(v) -> float:
    m = re.search(r"\d+(?:\.\d+)?", _text(v))
    return float(m.group(0)) if m else 1.0


def split_ford_pn(pn: str) -> tuple[str, str, str]:
    """Ford part number = prefix (model year / engineering) - base (what the part is) - suffix (version):
    'PC3Z-13008-A' → ('PC3Z', '13008', 'A'). Not a Ford number → ('', pn, '')."""
    m = FORD_PN.match(_text(pn).upper())
    return (m.group(1), m.group(2), m.group(3)) if m else ("", _text(pn), "")


@dataclass
class OemPart:
    callout: str = ""
    part_number: str = ""
    description: str = ""
    notes: str = ""
    qty: str = ""
    msrp: str = ""
    price: str = ""
    url: str = ""
    seller: str = ""  # dealer that gives the price ('Sewell Ford')

    @property
    def base(self) -> str:
        return split_ford_pn(self.part_number)[1]

    @classmethod
    def from_dict(cls, d: dict) -> OemPart:
        get = lambda *keys: next((d[k] for k in keys if k in d and d[k] not in (None, "")), "")
        return cls(_text(get("callout", "ref", "position", "number")), _text(get("part_number", "partNumber", "sku")),
                   _text(get("description", "name", "title")), _text(get("notes", "note", "fitment", "applies_to")),
                   _text(get("qty", "quantity")), _text(get("msrp", "list_price")), _text(get("price", "sale_price")),
                   _text(get("url", "link")), _text(get("seller", "dealer", "vendor")))


@dataclass
class Assembly:
    number: int
    title: str = ""
    url: str = ""
    image_url: str = ""
    parts: list[OemPart] = field(default_factory=list)
    image_file: str = ""  # picture of the diagram kept in <library>/images (name only)
    callouts: str = ""  # the numbers printed on the diagram, as typed: '1-12' · '1-4, 6, 8'

    def callout_numbers(self) -> list[str]:
        return parse_callouts(self.callouts)

    def missing_callouts(self) -> list[str]:
        """Numbers on the picture that no part row has (the page was not read whole, or rows to add)."""
        have = {p.callout for p in self.parts}
        return [c for c in self.callout_numbers() if c not in have]

    @classmethod
    def from_dict(cls, d: dict) -> Assembly:
        n = d.get("assembly", d.get("number", 0))
        try:
            n = int(n)
        except (TypeError, ValueError):
            n = 0
        return cls(n, _text(d.get("title") or d.get("name")), _text(d.get("url")),
                   _text(d.get("diagram_image_url") or d.get("image_url") or d.get("image")),
                   [OemPart.from_dict(p) for p in d.get("parts") or [] if isinstance(p, dict)],
                   _text(d.get("image_file")), _text(d.get("callouts")))


@dataclass
class OemCatalog:
    vehicle: str = ""
    category: str = ""
    source: str = ""
    fetched_at: str = ""
    assemblies: list[Assembly] = field(default_factory=list)

    @property
    def key(self) -> str:
        return re.sub(r"[^0-9A-Za-z]+", "_", f"{self.vehicle}__{self.category}").strip("_")[:120] or "catalog"

    @property
    def part_count(self) -> int:
        return sum(len(a.parts) for a in self.assemblies)

    def unique_numbers(self) -> list[str]:
        return sorted({p.part_number for a in self.assemblies for p in a.parts if p.part_number})

    def rows(self) -> list[tuple[Assembly, OemPart]]:
        return [(a, p) for a in self.assemblies for p in a.parts]

    def search(self, text: str) -> list[tuple[Assembly, OemPart]]:
        words = _text(text).lower().split()
        if not words:
            return self.rows()
        out = []
        for a, p in self.rows():
            hay = " ".join((p.part_number, p.description, p.notes, a.title, f"#{a.number}")).lower()
            if all(w in hay for w in words):
                out.append((a, p))
        return out

    def where_used(self, part_number: str) -> list[int]:
        return sorted({a.number for a in self.assemblies for p in a.parts if p.part_number == part_number})

    @classmethod
    def from_dict(cls, d: dict) -> OemCatalog:
        if not isinstance(d.get("assemblies"), list):
            raise ValueError("ไม่ใช่ไฟล์แคตตาล็อกอะไหล่ (ไม่มี assemblies)")
        asm = sorted((Assembly.from_dict(a) for a in d["assemblies"] if isinstance(a, dict)), key=lambda a: a.number)
        return cls(_text(d.get("vehicle")), _text(d.get("category")), _text(d.get("source")), _text(d.get("fetched_at")), asm)

    def to_dict(self) -> dict:
        return {"source": self.source, "vehicle": self.vehicle, "category": self.category,
                "fetched_at": self.fetched_at,
                "assemblies": [{"assembly": a.number, "title": a.title, "url": a.url, "diagram_image_url": a.image_url,
                                "image_file": a.image_file, "callouts": a.callouts,
                                "parts": [asdict(p) for p in a.parts]} for a in self.assemblies]}

    def assembly(self, number: int) -> Assembly | None:
        return next((a for a in self.assemblies if a.number == number), None)

    @classmethod
    def load(cls, path: str | Path) -> OemCatalog:
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")


class OemLibrary:
    """All imported catalogues, one JSON file each in a folder."""

    def __init__(self, folder: str | Path):
        self.folder = Path(folder)
        self.catalogs: list[OemCatalog] = []
        self.problems: list[str] = []
        self.reload()

    def reload(self) -> None:
        self.catalogs, self.problems = [], []
        if not self.folder.is_dir():
            return
        for f in sorted(self.folder.glob("*.json")):
            try:
                self.catalogs.append(OemCatalog.load(f))
            except (OSError, ValueError) as e:
                self.problems.append(f"{f.name}: {e}")

    def add(self, path: str | Path) -> OemCatalog:
        cat = OemCatalog.load(path)
        self.folder.mkdir(parents=True, exist_ok=True)
        cat.save(self.folder / f"{cat.key}.json")
        self.reload()
        return next(c for c in self.catalogs if c.key == cat.key)

    def remove(self, cat: OemCatalog) -> None:
        for a in cat.assemblies:
            if a.image_file:
                (self.images / a.image_file).unlink(missing_ok=True)
        (self.folder / f"{cat.key}.json").unlink(missing_ok=True)
        self.reload()

    @property
    def images(self) -> Path:
        return self.folder / "images"

    def image_path(self, asm: Assembly) -> Path | None:
        if asm.image_file and (self.images / asm.image_file).is_file():
            return self.images / asm.image_file
        return None

    def save(self, cat: OemCatalog) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        cat.save(self.folder / f"{cat.key}.json")
        self.reload()

    def attach_image(self, cat: OemCatalog, number: int, image: str | Path, title: str = "") -> Assembly:
        """Keep a copy of the picture of diagram `number` (the diagram is made when the catalogue has none yet)."""
        import shutil

        src = Path(image)
        asm = cat.assembly(number)
        if asm is None:
            asm = Assembly(number, title)
            cat.assemblies = sorted(cat.assemblies + [asm], key=lambda a: a.number)
        self.images.mkdir(parents=True, exist_ok=True)
        if asm.image_file:
            (self.images / asm.image_file).unlink(missing_ok=True)
        asm.image_file = f"{cat.key}_{number:02d}{src.suffix.lower() or '.png'}"
        shutil.copyfile(src, self.images / asm.image_file)
        self.save(cat)
        return asm


# --------------------------------------------------------------------------- to the program
def to_part(a: Assembly, p: OemPart, vehicle: str = "", sets: float = 1) -> Part:
    """A row of the Part List for an OEM part to order (one per vehicle × sets)."""
    remark = " · ".join(x for x in (f"Ford OEM แผนภาพ #{a.number} ตำแหน่ง {p.callout}" if p.callout else
                                    f"Ford OEM แผนภาพ #{a.number}", vehicle, p.notes) if x)
    return Part(part_no=p.part_number, drawing_no=f"FORD-ASM-{a.number:02d}", name=p.description, spec=a.title,
                qty=qty_of(p.qty) * sets, unit="ชิ้น", process=PROCESS, status="รอตรวจ", remark=remark)


EXPORT_HEADERS = ["แผนภาพ", "ชื่อแผนภาพ", "ตำแหน่ง", "Part Number", "Base", "รายละเอียด", "หมายเหตุ / รุ่นที่ใช้",
                  "จำนวน", "MSRP", "ราคาขาย", "ลิงก์"]


def export_rows(rows: list[tuple[Assembly, OemPart]]) -> list[list]:
    return [[a.number, a.title, p.callout, p.part_number, p.base, p.description, p.notes, qty_of(p.qty), money(p.msrp),
             money(p.price), p.url] for a, p in rows]


def export_xlsx(cat: OemCatalog, rows: list[tuple[Assembly, OemPart]], path: str | Path) -> int:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "OEM Parts"
    ws.append([f"{cat.vehicle} – {cat.category}"])
    ws.append([f"ที่มา {cat.source} · ดึงข้อมูล {cat.fetched_at}"])
    ws.append(EXPORT_HEADERS)
    for c in ws[3]:
        c.font = Font(bold=True)
    for r in export_rows(rows):
        ws.append(r)
    for col, w in zip("ABCDEFGHIJK", (8, 40, 8, 18, 10, 40, 50, 8, 10, 10, 40)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A4"
    wb.save(path)
    return len(rows)


# --------------------------------------------------------------------------- pages saved from the browser
# The parts site blocks automated access, so the pages are saved in Chrome (⌘S / Ctrl+S, "Webpage, HTML only")
# or their text is copied (⌘A ⌘C) and read here. The reading is by the visible text, so it does not depend on
# the site's HTML classes: "Diagram 1: Headlamp Assembly", then per row the callout, the name, "MSRP $1,079.68",
# the price "$717.77", the dealer, and the part number where the page shows it (or in the link of the part).
_PN_ANY = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,7}-[A-Z]{1,3}\d?|[WN]\d{6}-S\d{2,4}[A-Z]?)\b")
_LINK = re.compile(r"""(?i)<a\b[^>]*?href=["']([^"']*/oem-parts/[^"']+)["'][^>]*>""")
_MONEY = re.compile(r"^\$\s?\d[\d,]*(?:\.\d{2})?$")
_DIAGRAM = re.compile(r"Diagram\s+(\d+)\s*[:：]\s*(.+)")
_STOP = ("add to cart", "quantity", "qty", "in stock", "ships", "more info", "view details", "−", "+", "-")


def _visible_lines(page: str) -> list[str]:
    import html as _html

    if "<" in page and ">" in page:
        page = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", page)
        page = _LINK.sub(lambda m: f"\nlink:{m.group(1)}\n", page)  # the link of each part stays in its row
        page = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|td|th|h\d|a|span|section|article|button|label)>", "\n", page)
        page = re.sub(r"<[^>]+>", " ", page)
        page = _html.unescape(page)
    return [x for x in (re.sub(r"\s+", " ", ln).strip() for ln in page.splitlines()) if x]


def slug_part_number(url: str) -> str:
    """The Ford number in the link of a part: '/oem-parts/ford-headlamp-assembly-pc3z13008a' → 'PC3Z-13008-A',
    '.../ford-bolt-w716593s450' → 'W716593-S450'. Not readable → ''."""
    token = re.split(r"[/?#]", url.rstrip("/").split("/oem-parts/")[-1])[0].split("-")[-1].lower()
    if m := re.fullmatch(r"([wn]\d{6})(s\d{2,4}[a-z]?)", token):
        return f"{m.group(1)}-{m.group(2)}".upper()
    if m := re.fullmatch(r"([a-z0-9]{4})([a-z0-9]{4,7}?)([a-z]{1,3}\d?)", token):
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}".upper()
    return ""


def parse_page(page: str) -> tuple[Assembly | None, str]:
    """One saved page (HTML or copied text) → its diagram with the part rows, and the vehicle line of the page."""
    lines = _visible_lines(page)
    vehicle = next((m.group(1) for ln in lines if (m := re.search(r"\bfor (\d{4} Ford .+)$", ln))), "")
    head = next(((i, m) for i, ln in enumerate(lines) if (m := _DIAGRAM.match(ln))), None)
    if head is None:
        return None, vehicle
    start, m = head
    asm = Assembly(int(m.group(1)), _text(re.sub(r"\s+\d+$", "", m.group(2))))
    asm.image_url = diagram_image_src(page, asm.number) if "<" in page else ""
    body = lines[start + 1:]
    table_at = next((i for i, ln in enumerate(body) if ln.lower().startswith("part #")), -1)
    body = body[table_at + 1:] if table_at >= 0 else body
    rows: list[list[str]] = []
    prev = ""
    for ln in body:
        if _DIAGRAM.match(ln) or ln.lower().startswith(("categories", "related parts", "customer reviews")):
            break
        if re.fullmatch(r"\d{1,3}", ln) and prev in ("-", "−", "–"):  # the quantity box  − 1 +
            if rows:
                rows[-1].append(f"qty:{ln}")
        elif re.fullmatch(r"\d{1,3}", ln) and (not rows or len(rows[-1]) > 1):
            rows.append([ln])
        elif rows:
            rows[-1].append(ln)
        prev = ln
    for row in rows:
        p = OemPart(callout=row[0])
        for ln in row[1:]:
            low = ln.lower()
            if low.startswith("qty:"):
                p.qty = ln[4:]
            elif low.startswith("link:"):
                p.url = p.url or ln[5:]
            elif low.startswith(("notes", "note:", "replaces", "replaced by", "applies", "position", "description:",
                                 "superseded", "fits")):
                p.notes = f"{p.notes} · {ln}".strip(" ·")
            elif (pn := _PN_ANY.search(ln)) and not p.part_number:
                p.part_number = pn.group(1)
                rest = _text(ln.replace(pn.group(1), "").replace("Part Number", "").strip(" :#"))
                if rest and not p.description:
                    p.description = rest
            elif low.startswith("msrp"):
                p.msrp = _text(ln[4:]).split(" ")[0]
                tail = _text(ln[4:]).split(" ")[1:]
                if tail and _MONEY.match(tail[-1]):
                    p.price = tail[-1]
            elif _MONEY.match(ln):
                p.price = p.price or ln
            elif not p.description:
                p.description = ln
            elif (p.price or p.msrp) and not p.seller and low not in _STOP and len(ln) < 40:
                p.seller = ln
            elif low not in _STOP and not re.fullmatch(r"[\d\s+−-]+", ln):
                p.notes = f"{p.notes} · {ln}".strip(" ·")
        p.part_number = p.part_number or slug_part_number(p.url)
        if p.description or p.part_number:
            asm.parts.append(p)
    return asm, vehicle


def catalog_from_pages(pages: list[str], category: str = "", source: str = "ford.oempartsonline.com") -> OemCatalog:
    """Saved pages of one category (one page per diagram) → one catalogue. A diagram met twice keeps the fuller one."""
    from datetime import datetime, timezone

    by_no: dict[int, Assembly] = {}
    vehicle = ""
    for page in pages:
        asm, veh = parse_page(page)
        vehicle = vehicle or veh
        if asm and (asm.number not in by_no or len(asm.parts) > len(by_no[asm.number].parts)):
            by_no[asm.number] = asm
        if not category:
            category = next((m.group(1).strip() for ln in _visible_lines(page)[:200]
                             if (m := re.match(r"(.+?) for \d{4} Ford ", ln))), "")
    return OemCatalog(vehicle, category, source, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                      [by_no[n] for n in sorted(by_no)])


def parse_callouts(text: str) -> list[str]:
    """'1-12' → ['1', …, '12'] · '1-4, 6, 8' → ['1', '2', '3', '4', '6', '8'] (order kept, no repeats)."""
    out: list[str] = []
    for chunk in re.split(r"[,\s]+", _text(text)):
        m = re.fullmatch(r"(\d+)\s*[-–]\s*(\d+)", chunk)
        items = [str(n) for n in range(int(m.group(1)), int(m.group(2)) + 1)] if m and int(m.group(2)) - int(m.group(1)) < 500 \
            else [chunk] if chunk else []
        out += [x for x in items if x not in out]
    return out


def diagram_image_src(page: str, number: int) -> str:
    """The picture of diagram `number` in a saved page: the first <img> after the 'Diagram N:' heading."""
    m = re.search(rf"Diagram\s+{number}\s*:", page)
    if not m:
        return ""
    img = re.search(r"""(?is)<img\b[^>]*?\bsrc=["']([^"']+)["']""", page[m.end():])
    return img.group(1) if img and not img.group(1).startswith("data:") else ""


def local_image(html_file: str | Path, src: str) -> Path | None:
    """A picture of a page saved as 'Webpage, Complete' (in its _files folder) → the file, if it is there."""
    from urllib.parse import unquote

    if not src or re.match(r"(?i)^[a-z]+:", src):
        return None
    f = (Path(html_file).parent / unquote(src.split("?")[0])).resolve()
    return f if f.is_file() else None


def missing_numbers(cat: OemCatalog, last: int) -> list[int]:
    have = {a.number for a in cat.assemblies}
    return [n for n in range(1, last + 1) if n not in have]
