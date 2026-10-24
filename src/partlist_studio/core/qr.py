"""QR codes on the job tickets (ใบงาน) and the shelf labels (ป้ายชั้นวาง).

The text in the QR is short and starts with RRS1 so a USB scanner (it types like a keyboard) or a phone can be
read back by the program:
    RRS1|J|<job no>|<line>|<code>|<qty>|<DWG code>|<Express code>|<material>|<size>|<name>
                                            ใบงาน: line = row of the part in the job (1 = first); the Part List
                                            details after the quantity are for a person scanning with a phone
                                            (the program reads the first six)
    RRS1|I|<code>|<location>                ป้ายชั้นวาง
"""

from __future__ import annotations

from dataclasses import dataclass, field

PREFIX = "RRS1"


def _clean(text) -> str:
    return str(text or "").replace("|", "/").strip()


def ticket_payload(job_no: str, line: int, code: str, qty: float, *details: str) -> str:
    """details: DWG code, Express code, material ('SS400 t3'), size ('150x60'), name - trailing blanks dropped."""
    fields = [PREFIX, "J", _clean(job_no), str(line), _clean(code), f"{qty:g}"] + [_clean(d) for d in details]
    while len(fields) > 6 and not fields[-1]:
        fields.pop()
    return "|".join(fields)


def item_payload(code: str, location: str = "") -> str:
    return "|".join([PREFIX, "I", _clean(code), _clean(location)])


@dataclass
class Scan:
    kind: str  # 'job' / 'item' / 'text' (anything else: a code typed or a code-only barcode)
    job_no: str = ""
    line: int = 0
    code: str = ""
    qty: float = 0
    location: str = ""
    text: str = ""
    details: list[str] = field(default_factory=list)  # ใบงาน: DWG code, Express code, material, size, name


def parse_payload(text: str) -> Scan:
    raw = (text or "").strip()
    parts = raw.split("|")
    if len(parts) >= 4 and parts[0].upper() == PREFIX and parts[1].upper() == "J":
        try:
            line = int(parts[3])
        except ValueError:
            line = 0
        try:
            qty = float(parts[5]) if len(parts) > 5 else 0
        except ValueError:
            qty = 0
        return Scan("job", job_no=parts[2], line=line, code=parts[4] if len(parts) > 4 else "", qty=qty, text=raw,
                    details=parts[6:])
    if len(parts) >= 3 and parts[0].upper() == PREFIX and parts[1].upper() == "I":
        return Scan("item", code=parts[2], location=parts[3] if len(parts) > 3 else "", text=raw)
    return Scan("text", code=raw, text=raw)


def qr_matrix(text: str) -> list[list[bool]]:
    """Modules of the QR code (True = dark), without the quiet zone; [] if the QR library is missing."""
    try:
        import segno
    except ImportError:  # pragma: no cover - segno is in requirements.txt
        return []
    code = segno.make(text, error="m", micro=False)
    return [[bool(v) for v in row] for row in code.matrix]
