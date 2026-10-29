"""Store map (ผังสโตร์) for finding a shelf slot with the AR camera of a phone.

A shelf location (ตำแหน่งเก็บ) is written zone-rack-slot, as on the shelf labels: `P-POST-04`, `R-B-03`.
The rack is the location without its last number (`P-POST`); a rack set on the map says where it stands and how
its slots are numbered:
    aisle          ทางเดินที่ … from the entrance of the store
    side           L / R of the aisle, walking in from the entrance
    order          place along the aisle (1 = nearest to the entrance)
    levels, slots  number of levels and slots per level - slot numbers go along a level, then to the next level
                   (`P-POST-07` with 5 slots per level = level 2, slot 2 of that level)
    bottom_first   level 1 (the first slot numbers) at the bottom
    left_to_right  slot 1 at the left when facing the rack
A location may also give the level itself: `P-POST-2-04` = level 2, slot 4.

From any label the camera sees (a shelf label or a location label) the phone knows the slot it looks at, so it
can point to the slot of the part to pick on the same rack (slots to the left / right, levels up / down) or tell
the way to another rack (aisle, side, place along the aisle).
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

SIDES = {"L": "ซ้าย", "R": "ขวา"}


@dataclass
class Rack:
    code: str  # start of the locations on it: 'P-POST'
    name: str = ""  # 'ชั้นเสา'
    aisle: int = 1
    side: str = "L"
    order: int = 1
    levels: int = 1
    slots: int = 0  # per level (0 = every slot on one level)
    bottom_first: bool = True
    left_to_right: bool = True

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> Rack:
        kw = {k: v for k, v in (data or {}).items() if k in cls.__dataclass_fields__}
        rack = cls(**kw)
        rack.code = norm(rack.code)
        rack.side = "R" if str(rack.side).upper().startswith(("R", "ข")) else "L"
        for key in ("aisle", "order", "levels", "slots"):
            try:
                setattr(rack, key, max(0, int(getattr(rack, key) or 0)))
            except (TypeError, ValueError):
                setattr(rack, key, 0)
        rack.aisle = rack.aisle or 1
        rack.order = rack.order or 1
        rack.levels = rack.levels or 1
        return rack

    @property
    def where(self) -> str:
        """'ทางเดิน 2 ฝั่งขวา ลำดับที่ 3'."""
        return f"ทางเดิน {self.aisle} ฝั่ง{SIDES.get(self.side, 'ซ้าย')} ลำดับที่ {self.order}"


@dataclass
class Slot:
    location: str
    rack_code: str = ""
    number: int = 0  # slot number written in the location (0 = none)
    level: int = 0  # 1 = bottom (0 = not known)
    column: int = 0  # 1 = leftmost when facing the rack (0 = not known)
    rack: Rack | None = None

    def to_dict(self) -> dict:
        rack = self.rack
        return {"location": self.location, "rack": self.rack_code, "number": self.number, "level": self.level,
                "column": self.column, "on_map": rack is not None,
                "rack_name": rack.name if rack else "", "aisle": rack.aisle if rack else 0,
                "side": rack.side if rack else "", "order": rack.order if rack else 0,
                "levels": rack.levels if rack else 0, "where": rack.where if rack else ""}


def norm(text: str) -> str:
    return re.sub(r"\s+", "", str(text or "")).upper().strip("-")


_TAIL = re.compile(r"^(?P<rack>.+?)-(?:(?P<level>\d)-)?(?P<slot>\d+)$")  # P-POST-04, P-POST-2-04 (level 2)


def parse_location(location: str, racks: list[Rack] | None = None) -> Slot:
    loc = norm(location)
    slot = Slot(location=loc)
    if not loc:
        return slot
    racks = racks or []
    rack = max((r for r in racks if r.code and (loc == r.code or loc.startswith(r.code + "-"))),
               key=lambda r: len(r.code), default=None)
    level = number = 0
    if rack is not None:
        rest = loc[len(rack.code):].strip("-")
        nums = [int(n) for n in re.findall(r"\d+", rest)] if re.fullmatch(r"[\d\-/.]*", rest) else []
        if len(nums) >= 2:
            level, number = nums[-2], nums[-1]
        elif nums:
            number = nums[0]
        slot.rack_code = rack.code
    else:
        m = _TAIL.match(loc)
        if m is None:
            slot.rack_code = loc
            return slot
        slot.rack_code = m.group("rack")
        level = int(m.group("level") or 0)
        number = int(m.group("slot"))
    slot.rack = rack
    slot.number = number
    if level:  # written in the location
        slot.level, slot.column = level, number
    elif rack is not None and rack.slots and number:
        row = (number - 1) // rack.slots
        slot.level = row + 1 if rack.bottom_first else max(1, rack.levels - row)
        slot.column = (number - 1) % rack.slots + 1
    else:
        slot.level, slot.column = (1 if number else 0), number
    if rack is not None and not rack.left_to_right and slot.column and rack.slots:
        slot.column = rack.slots - slot.column + 1
    return slot


@dataclass
class Direction:
    same_rack: bool
    here: bool  # the very slot
    dx: int = 0  # slots to the right (+) / left (-) when facing the rack
    dy: int = 0  # levels up (+) / down (-)
    text: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def direction(seen: Slot, target: Slot) -> Direction:
    """From the slot the camera sees to the slot of the part."""
    if not target.location:
        return Direction(False, False, text="ยังไม่ได้ตั้งตำแหน่งเก็บ")
    if seen.location == target.location:
        return Direction(True, True, text="ช่องนี้")
    if seen.rack_code and seen.rack_code == target.rack_code:
        dx = target.column - seen.column if target.column and seen.column else 0
        if not (target.rack and target.rack.slots) and seen.rack is not None and not seen.rack.left_to_right:
            dx = -dx  # numbers go right to left and the levels are not known
        dy = target.level - seen.level if target.level and seen.level else 0
        words = []
        if dx:
            words.append(f"{'ขวา' if dx > 0 else 'ซ้าย'} {abs(dx)} ช่อง")
        if dy:
            words.append(f"{'ขึ้น' if dy > 0 else 'ลง'} {abs(dy)} ชั้น")
        return Direction(True, False, dx, dy, " · ".join(words) or f"ช่อง {target.location}")
    return Direction(False, False, text=way_to(target))


def way_to(target: Slot) -> str:
    rack = target.rack
    where = f"ไปชั้นวาง {target.rack_code}" if target.rack_code else f"ไปที่ {target.location}"
    if rack is not None:
        where += f" ({rack.name}) " if rack.name else " "
        where += rack.where
    level = f" · ชั้นที่ {target.level} จากล่าง" if target.level and rack is not None and rack.levels > 1 else ""
    return (where + level).strip()


def racks_from_locations(locations, racks: list[Rack] | None = None) -> list[Rack]:
    """Racks for the locations not on the map yet: one aisle per zone (first part of the code), racks of a zone
    along it left and right in the order of their codes, slots = the highest slot number seen."""
    racks = list(racks or [])
    known = {r.code for r in racks}
    found: dict[str, int] = {}
    for loc in locations:
        slot = parse_location(loc, racks)
        if slot.rack_code and slot.rack is None:
            found[slot.rack_code] = max(found.get(slot.rack_code, 0), slot.number)
    zones = sorted({code.split("-")[0] for code in found} | {r.code.split("-")[0] for r in racks})
    aisles = {zone: i + 1 for i, zone in enumerate(zones)}
    for code in sorted(c for c in found if c not in known):
        zone = code.split("-")[0]
        in_aisle = [r for r in racks if r.aisle == aisles[zone]]
        n = len(in_aisle)
        racks.append(Rack(code=code, aisle=aisles[zone], side="L" if n % 2 == 0 else "R", order=n // 2 + 1,
                          levels=1, slots=0))
    return sorted(racks, key=lambda r: (r.aisle, r.order, r.side, r.code))


@dataclass
class StoreMap:
    racks: list[Rack] = field(default_factory=list)

    def slot(self, location: str) -> Slot:
        return parse_location(location, self.racks)

    def to_dict(self) -> dict:
        return {"racks": [r.to_dict() for r in self.racks]}

    @classmethod
    def from_dict(cls, data: dict | None) -> StoreMap:
        return cls([Rack.from_dict(r) for r in (data or {}).get("racks", []) if r.get("code")])
