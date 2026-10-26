"""ซ้าย / ขวา จากตำแหน่งในแบบ - the side of a left/right part read from where it is drawn.

When the two pieces of a pair are drawn next to each other on one row (laid out horizontally), the piece on the
left is the left part (ซ้าย, L) and the piece on the right is the right part (ขวา, R). Pieces drawn one above the
other do not tell the side. Used by the DWG import (dwg_io.read_sides: the same part drawn twice) and by the
code matching (part_match.sides_of_pairs: two parts of a drawing matched to one left/right pair of the stock).
"""

from __future__ import annotations

import re

L, R = "L", "R"
WORDS = {L: "ซ้าย", R: "ขวา"}
LABELS = {L: "ซ้าย (L)", R: "ขวา (R)"}
_SIDE_END = re.compile(r"\s*\(?\s*(?:ข้าง)?(?:ซ้าย|ขวา)\s*\)?\s*$")


def side_by_side(a, b) -> bool:
    """Two boxes (x0, y0, x1, y1) on one row and apart: they share a quarter of the lower one's height and
    overlap across by a tenth of the narrower one's width at most."""
    if len(a or ()) != 4 or len(b or ()) != 4:
        return False
    rows = min(a[3], b[3]) - max(a[1], b[1])
    across = min(a[2], b[2]) - max(a[0], b[0])
    low = min(a[3] - a[1], b[3] - b[1])
    return rows > 0 and rows >= 0.25 * low and across <= 0.1 * min(a[2] - a[0], b[2] - b[0])


def centre(box) -> tuple[float, float]:
    return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2


def left_right(a, b) -> tuple[int, int] | None:
    """(index of the left one, of the right one) of boxes a (0) and b (1) drawn side by side, else None."""
    if not side_by_side(a, b):
        return None
    return (0, 1) if centre(a)[0] <= centre(b)[0] else (1, 0)


def with_side(name: str, side: str) -> str:
    """'หูช้าง' + L -> 'หูช้าง (ซ้าย)'; a side already at the end is replaced, '' takes it off."""
    base = _SIDE_END.sub("", name or "").strip()
    return f"{base} ({WORDS[side]})".strip() if side in WORDS else base


def opposite(side: str) -> str:
    return {L: R, R: L}.get(side, "")


def side_of(name: str, code: str = "") -> str:
    """The side the name or the code says: 'หูช้าง(ซ้าย)' / RRS-A-027-L -> L ('' = none)."""
    from .express_codes import _code_side, _side

    return _side(name) or _code_side(code)
