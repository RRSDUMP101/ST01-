"""Code cross-reference (ตารางเทียบรหัส).

The same part has different codes in different files: Express and the Parts List workbook use
RRS-A-108-209-2-50, the stock-count file uses 01-0007-0004. The table links them so a part from a
drawing or a model BOM finds its stock balance whichever file the balance came from.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import asdict, dataclass, field

from .stock import StockList, _key

XREF_HEADERS = ["รหัส Express / แบบ", "รหัสนับสต็อก", "ชื่อสินค้า", "วิธีจับคู่", "ยืนยันแล้ว"]
METHOD_NAME = "ชื่อตรงกัน"
METHOD_SIMILAR = "ชื่อคล้าย"
METHOD_MANUAL = "กำหนดเอง"


def name_key(name: str) -> str:
    text = (name or "").replace("\xa0", " ").lower()
    return re.sub(r"[\s()\[\]{}.,_\-–]+", "", text)


@dataclass
class XrefEntry:
    code_a: str  # Express / drawing / model BOM code
    code_b: str  # stock-count code
    name: str = ""
    method: str = METHOD_MANUAL
    confirmed: bool = False


@dataclass
class CodeXref:
    entries: list[XrefEntry] = field(default_factory=list)

    def lookup(self, code: str) -> list[str]:
        key = _key(code)
        out = []
        for e in self.entries:
            if _key(e.code_a) == key and e.code_b:
                out.append(e.code_b)
            elif _key(e.code_b) == key and e.code_a:
                out.append(e.code_a)
        return out

    def to_rows(self) -> list[list]:
        return [XREF_HEADERS] + [[e.code_a, e.code_b, e.name, e.method, "Y" if e.confirmed else ""]
                                 for e in self.entries]

    @classmethod
    def from_rows(cls, rows: list[list]) -> CodeXref:
        entries = []
        header_idx = next((i for i, r in enumerate(rows[:10]) if any("รหัสนับ" in str(c) for c in r)), 0)
        for r in rows[header_idx + 1:]:
            cells = [str(c).strip() if c is not None else "" for c in r] + [""] * 5
            if cells[0] or cells[1]:
                entries.append(XrefEntry(cells[0], cells[1], cells[2], cells[3] or METHOD_MANUAL,
                                         cells[4].upper() in ("Y", "YES", "1", "TRUE", "✓")))
        return cls(entries)

    def to_dict(self) -> dict:
        return {"entries": [asdict(e) for e in self.entries]}

    @classmethod
    def from_dict(cls, data: dict) -> CodeXref:
        return cls([XrefEntry(**e) for e in data.get("entries", [])])

    def merge(self, new: list[XrefEntry]) -> int:
        """Add entries whose codes are not linked yet; confirmed/manual rows are never replaced."""
        known_a = {_key(e.code_a) for e in self.entries if e.code_a}
        known_b = {_key(e.code_b) for e in self.entries if e.code_b}
        added = 0
        for e in new:
            if _key(e.code_a) in known_a or _key(e.code_b) in known_b:
                continue
            self.entries.append(e)
            known_a.add(_key(e.code_a))
            known_b.add(_key(e.code_b))
            added += 1
        return added


def suggest_links(primary: StockList, counted: StockList, min_ratio: float = 0.9) -> list[XrefEntry]:
    """Link items of two lists that carry different codes for the same name."""
    by_name: dict[str, list] = {}
    for item in counted.items:
        if item.code:
            by_name.setdefault(name_key(item.name), []).append(item)
    keys = list(by_name)
    out = []
    used = set()
    for item in primary.items:
        if not item.code:
            continue
        k = name_key(item.name)
        if not k:
            continue
        match, method = None, METHOD_NAME
        if k in by_name and len(by_name[k]) == 1:
            match = by_name[k][0]
        else:
            close = difflib.get_close_matches(k, keys, n=1, cutoff=min_ratio)
            if close and len(by_name[close[0]]) == 1:
                ratio = difflib.SequenceMatcher(None, k, close[0]).ratio()
                match, method = by_name[close[0]][0], f"{METHOD_SIMILAR} {ratio:.0%}"
        if match is None or _key(match.code) == _key(item.code) or _key(match.code) in used:
            continue
        used.add(_key(match.code))
        out.append(XrefEntry(item.code, match.code, item.name, method, confirmed=False))
    return out
