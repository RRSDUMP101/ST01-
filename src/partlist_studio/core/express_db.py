"""อ่านข้อมูล Express (อ่านอย่างเดียว): Express keeps each company in a folder of Visual FoxPro tables (.DBF, Thai text in
code page 874) on the server, e.g. \\\\<เครื่องเซิร์ฟเวอร์>\\<โฟลเดอร์แชร์>\\ExpressA\\ffff. This module only READS them - it never opens a
file for writing, never locks it and ignores the .CDX indexes - so it is safe while Express is in use: at worst a
record being saved at that moment is read half-written and skipped.

What is known: a company folder holds ISINFO.DBF (the company, Thai name in THINAM); dates are YYYYMMDD in the
Christian year; a deleted record starts with "*". Which tables hold the stock documents (PD / OU / JU …) and their
lines is NOT assumed: probe() lists every table with its fields and find_value() finds where a known Express number
(PD0000526) or item code is stored - from that the mapping is made once for this company's Express.
"""

from __future__ import annotations

import struct
import unicodedata
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

ENCODING = "cp874"
COMPANY_FILE = "ISINFO.DBF"


@dataclass
class Field:
    name: str
    type: str
    offset: int
    length: int
    decimals: int
    flags: int = 0


@dataclass
class DbfTable:
    path: Path
    version: int = 0
    updated: date | None = None
    count: int = 0
    header_len: int = 0
    record_len: int = 0
    fields: list[Field] = field(default_factory=list)

    @classmethod
    def open(cls, path: str | Path) -> DbfTable:
        path = Path(path)
        with open(path, "rb") as fh:  # read only - nothing in this module writes
            head = fh.read(32)
            if len(head) < 32:
                raise ValueError(f"{path.name}: ไม่ใช่ไฟล์ DBF")
            version = head[0]
            yy, mm, dd = head[1], head[2], head[3]
            count, header_len, record_len = struct.unpack("<IHH", head[4:12])
            if header_len < 33 or record_len < 1:
                raise ValueError(f"{path.name}: หัวไฟล์ DBF ไม่ถูกต้อง")
            desc = fh.read(header_len - 32)
        fields, pos, running = [], 0, 1
        while pos + 32 <= len(desc) and desc[pos] != 0x0D:
            raw = desc[pos:pos + 32]
            name = raw[:11].split(b"\0", 1)[0].decode("ascii", "replace").strip()
            ftype = chr(raw[11])
            disp = struct.unpack("<I", raw[12:16])[0]
            length, decimals, flags = raw[16], raw[17], raw[18]
            fields.append(Field(name, ftype, disp or running, length, decimals, flags))
            running += length
            pos += 32
        try:
            updated = date(1900 + yy, mm, dd) if mm else None  # the year is kept as years since 1900
        except ValueError:
            updated = None
        return cls(path, version, updated, count, header_len, record_len, fields)

    @property
    def names(self) -> list[str]:
        return [f.name for f in self.fields if f.type != "0"]  # "0" = _NullFlags of Visual FoxPro

    def _decode(self, f: Field, raw: bytes, nulls: int | None):
        t = f.type
        if t in ("C", "V"):
            return raw.decode(ENCODING, "replace").replace("\0", "").rstrip()
        if t in ("N", "F"):
            text = raw.decode("ascii", "replace").strip()
            if not text or text.strip("*") == "":
                return None
            try:
                return int(text) if f.decimals == 0 and "." not in text else float(text)
            except ValueError:
                return None
        if t == "D":
            text = raw.decode("ascii", "replace").strip()
            if len(text) != 8 or not text.isdigit():
                return None
            try:
                return date(int(text[:4]), int(text[4:6]), int(text[6:]))
            except ValueError:
                return None
        if t == "B":
            return struct.unpack("<d", raw)[0] if len(raw) == 8 else None
        if t == "I":
            return struct.unpack("<i", raw)[0] if len(raw) == 4 else None
        if t == "Y":
            return struct.unpack("<q", raw)[0] / 10000 if len(raw) == 8 else None
        if t == "T":
            if len(raw) != 8:
                return None
            jd, ms = struct.unpack("<ii", raw)
            if jd <= 0:
                return None
            return date(1, 1, 1) + timedelta(days=jd - 1721426)
        if t == "L":
            ch = raw[:1].upper()
            return True if ch in (b"T", b"Y") else False if ch in (b"F", b"N") else None
        return None  # M, G, W: memo / picture blocks, not read

    def records(self, start: int = 0, stop: int | None = None, with_recno: bool = False):
        """Live records as dicts (deleted ones skipped); start / stop are record numbers (0-based)."""
        stop = self.count if stop is None else min(stop, self.count)
        if start >= stop:
            return
        null_field = next((f for f in self.fields if f.type == "0"), None)
        with open(self.path, "rb") as fh:
            fh.seek(self.header_len + start * self.record_len)
            for recno in range(start, stop):
                raw = fh.read(self.record_len)
                if len(raw) < self.record_len:
                    break  # being written at this moment / file shorter than the header says
                if raw[:1] == b"*":
                    continue
                nulls = int.from_bytes(raw[null_field.offset:null_field.offset + null_field.length], "little") \
                    if null_field else None
                rec = {f.name: self._decode(f, raw[f.offset:f.offset + f.length], nulls)
                       for f in self.fields if f.type != "0"}
                if with_recno:
                    rec["_recno"] = recno
                yield rec

    def tail(self, n: int, with_recno: bool = False) -> list[dict]:
        return list(self.records(max(self.count - n, 0), None, with_recno))


def clean(text: str) -> str:
    """For comparing what Express stored with what was typed: NFC, NBSP and runs of spaces to one space."""
    text = unicodedata.normalize("NFC", text or "").replace("\xa0", " ")
    return " ".join(text.split())


def _files(folder: Path) -> dict[str, Path]:
    try:
        return {p.name.upper(): p for p in folder.iterdir() if p.is_file()}
    except OSError:
        return {}


def table(folder: str | Path, name: str) -> DbfTable | None:
    """A table of a company folder by name, any case (gljnl.dbf / GLJNL.DBF)."""
    p = _files(Path(folder)).get(name.upper() if name.upper().endswith(".DBF") else name.upper() + ".DBF")
    return DbfTable.open(p) if p else None


@dataclass
class Company:
    folder: Path
    name: str
    year: str  # "69" from RRSDP69, "" when the folder name ends without a year


def companies(root: str | Path) -> list[Company]:
    """The Express company folders under the data folder (each holds ISINFO.DBF), with the Thai name."""
    root = Path(root)
    out = []
    folders = [root] + sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name.lower()) \
        if root.is_dir() else []
    for folder in folders:
        info = _files(folder).get(COMPANY_FILE)
        if info is None:
            continue
        name = ""
        try:
            first = next(DbfTable.open(info).records(0, 5), None)
            name = clean(str((first or {}).get("THINAM") or ""))
        except (OSError, ValueError):
            pass
        tail = folder.name[-2:]
        out.append(Company(folder, name or folder.name, tail if tail.isdigit() else ""))
    return out


def probe(folder: str | Path) -> list[list]:
    """Every table of a company folder: [table, records, last update, field, type, length, decimals]."""
    rows = []
    for name, path in sorted(_files(Path(folder)).items()):
        if not name.endswith(".DBF"):
            continue
        try:
            t = DbfTable.open(path)
        except (OSError, ValueError) as e:
            rows.append([name, "", "", f"อ่านไม่ได้: {e}", "", "", ""])
            continue
        upd = t.updated.isoformat() if t.updated else ""
        for f in t.fields:
            if f.type != "0":
                rows.append([name, t.count, upd, f.name, f.type, f.length, f.decimals])
    return rows


def find_value(folder: str | Path, value: str, limit: int = 50, max_records: int = 200_000) -> list[tuple[str, str, int]]:
    """Where a value (an Express number such as PD0000526, an item code) is stored: (table, field, record number).
    Text fields only, exact after clean(); big tables are read up to max_records from the end."""
    want = clean(value).upper()
    hits: list[tuple[str, str, int]] = []
    if not want:
        return hits
    for name, path in sorted(_files(Path(folder)).items()):
        if not name.endswith(".DBF"):
            continue
        try:
            t = DbfTable.open(path)
        except (OSError, ValueError):
            continue
        text_fields = [f for f in t.fields if f.type in ("C", "V") and f.length >= len(want)]
        if not text_fields:
            continue
        for rec in t.records(max(t.count - max_records, 0), None, with_recno=True):
            for f in text_fields:
                v = rec.get(f.name)
                if isinstance(v, str) and clean(v).upper() == want:
                    hits.append((name, f.name, rec["_recno"]))
                    if len(hits) >= limit:
                        return hits
    return hits


def folder_ok(folder: str | Path) -> bool:
    return COMPANY_FILE in _files(Path(folder))


# ---- the number Express gave a document just saved ------------------------------------------------------------------
# Which table holds the stock documents is not assumed: the text field whose last records hold numbers of the
# type (PD0000546 …) is found once and remembered (where); a document just saved is the last live record there.
def _doc_no_re(prefix: str):
    import re

    return re.compile(rf"^{re.escape(prefix.upper())}[A-Z0-9*/-]{{3,14}}$")


def find_doc_field(folder: str | Path, prefix: str, tail: int = 200) -> tuple[str, str] | None:
    """(table, field) holding the numbers of documents of a type: the text field whose last records match most."""
    want = _doc_no_re(prefix)
    best, best_n = None, 0
    for name, path in sorted(_files(Path(folder)).items()):
        if not name.endswith(".DBF"):
            continue
        try:
            t = DbfTable.open(path)
        except (OSError, ValueError):
            continue
        fields = [f for f in t.fields if f.type in ("C", "V") and 6 <= f.length <= 20]
        if not fields or not t.count:
            continue
        seen: dict[str, set] = {f.name: set() for f in fields}  # distinct numbers: a table of lines repeats them
        try:
            for rec in t.tail(tail):
                for f in fields:
                    v = rec.get(f.name)
                    if isinstance(v, str) and want.match(v.strip().upper()):
                        seen[f.name].add(v.strip().upper())
        except OSError:
            continue
        name_f, n = max(((k, len(v)) for k, v in seen.items()), key=lambda kv: kv[1])
        # a table of documents (one record each) beats one of lines (the same number on many records) at equal count
        if n > best_n or (n == best_n and n and best and t.count < best[2]):
            best, best_n = (name, name_f, t.count), n
    return (best[0], best[1]) if best else None


def last_doc_no(folder: str | Path, prefix: str, where: tuple[str, str] | None = None) -> tuple[str, tuple | None]:
    """The number of the last document of a type saved in Express ("" when none), and where it was read."""
    where = where or find_doc_field(folder, prefix)
    if not where:
        return "", None
    want = _doc_no_re(prefix)
    t = table(folder, where[0])
    if t is None:
        return "", None
    for rec in reversed(t.tail(50)):
        v = rec.get(where[1])
        if isinstance(v, str) and want.match(v.strip().upper()):
            return v.strip().upper(), where
    return "", where


