"""Read ZW3D files (.Z3 / .Z3PRT / .Z3ASM) without ZW3D: the objects inside, which assembly uses what, a BOM.

The format is not published; everything below was worked out from real files and is re-checked on every read. A file
that does not pass the checks is reported as damaged / unsupported (Z3Error, message in Thai) and never half-read.

Layout of one container (all integers little-endian):

    0x000  four text lines of 128 bytes, '*'-padded, ending in '\\n':
             0  "Z3"
             1  "@,<author>,<Www Mmm dd hh:mm:ss yyyy>,<unix time> Z3(<product>,<version>,<build>)"
             2  "ZWSOFT,V1,WindowsNT,6.2,686,7,<code page>,0,0"
             3  "<format version>,0,,0,8,<build ids>[,HQR=<offset of an appended container>]"
    0x200  256 bytes of '*' ending in '\\n'
    0x300  binary header, 72 bytes, stored twice: 16 bytes (meaning unknown, not used), u64 A = offset of the record
           index, u64 B = its size, MD5(index), u32 C = size of the root-object table, MD5(table), u32 0
    0x390  root-object table, C bytes, stored twice: u32 1, 28 zero bytes, u32 count + 1, then 36-byte entries
           (name[32], u32 id of the object's root record), allocated ten at a time. A name of 32 or more bytes is
           replaced by a descriptor: u16 0, u16 3, u32 length, u64 stale pointer, u32 id of a string record, ...
    ....   data area: records back to back with no framing of their own, up to A
    A      record index: per record the byte 0x01, u16 control, u16 storage kind, up to eight fields whose widths
           come from the control word two bits at a time (offset 2/4/8 bytes, id step, size, element size, link,
           next, previous: 1/2/4 bytes, class: 1/2/4 bytes; "absent" = continue / zero), then one more byte for each
           of the four low 2-bit groups of the kind that equals 2. Kind bit 0x20 = stored raw, else packed.
    A+B    64 zero bytes, and the container ends (the HQR container, when there is one, starts here)

Record classes used here: 2 the root table itself, 3 string (NUL-terminated), 13 preview (0xFF, u32 size, zlib BMP),
67 layer (name[32] ...), 88 component = one use of another object, 89 root of a 3D object, 90 root of a 2D drawing.

A packed record is one version byte followed by 32-bit control words (16 two-bit codes, low bits first), each
followed by the data of its 16 items. Integer: 0 = 1 signed byte, 1 = 2 bytes, 2 = 4 bytes, 3 = same as the previous
integer. Character: 0 = NUL, 2 = one literal byte, 3 = same as the previous character, 1 = the value 1 (seen only in
the descriptor of a long name). A component record starts with five length-prefixed strings (instance name, file
name or "" for this file, object name, instance name again, "") and integers of which the fourth is the root-record
id of the object that owns the component (-1: not part of an assembly, e.g. a part shown in a drawing view).

What is NOT read: geometry, placements, user attributes (class 302 holds name/value pairs such as "Material", but
which object a list of them belongs to could not be established), per-object layers (only the layer names of the
whole file are listed), suppressed / excluded-from-BOM flags of components.
"""

from __future__ import annotations

import hashlib
import mmap
import os
import re
import struct
import unicodedata
import zlib
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np

Z3_SUFFIXES = (".z3", ".z3prt", ".z3asm")
KNOWN_FORMATS = (2900, 3000)  # ZW3D 2025 (ZWSim 5.0) and 2026 (ZWSim 6.0): the versions the checks were proven on

_LINE = 128
_TEXT_END = 0x300
_BINHDR = 72
_TABLE_AT = 0x390
_ENTRY = 36
_TRAILER = 64

CLS_TABLE, CLS_STRING, CLS_PREVIEW, CLS_LAYER, CLS_COMPONENT, CLS_OBJECT3D, CLS_DRAWING = 2, 3, 13, 67, 88, 89, 90
_KEEP = (CLS_TABLE, CLS_STRING, CLS_PREVIEW, CLS_LAYER, CLS_COMPONENT, CLS_OBJECT3D, CLS_DRAWING)

KIND_TH = {"part": "ชิ้นส่วน", "assembly": "ชุดประกอบ", "drawing": "แบบ 2 มิติ", "other": "ไม่ทราบชนิด"}

_MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}


class Z3Error(Exception):
    """The file is not a ZW3D file, is damaged, or is a version this reader has not been proven on (Thai text)."""

    def __init__(self, message: str, status: str = "damaged", checks: list[Z3Check] | None = None):
        super().__init__(message)
        self.status = status
        self.checks = checks or []


@dataclass
class Z3Check:
    key: str
    label: str  # Thai, shown to the user
    ok: bool
    detail: str = ""


@dataclass
class Z3Header:
    author: str = ""
    saved_text: str = ""  # as written by ZW3D, local time of the author's computer
    saved: datetime | None = None
    saved_unix: int | None = None
    zw3d_build: str = ""  # e.g. "ZWSim 6.0 075bf895fdf9"
    platform: str = ""
    code_page: str = "cp874"
    format_version: int = 0
    hqr_offset: int | None = None
    lines: list[str] = field(default_factory=list)


@dataclass
class Z3Use:
    """One row of an assembly: `count` uses of the object `name` (in `file`, "" = the same file)."""

    name: str
    file: str
    count: int
    instances: list[str] = field(default_factory=list)


@dataclass
class Z3Object:
    root_id: int
    kind: str  # part / assembly / drawing / other
    name: str
    components: list[Z3Use] = field(default_factory=list)
    record_class: int = 0

    @property
    def kind_th(self) -> str:
        return KIND_TH.get(self.kind, self.kind)


@dataclass
class Z3Embedded:
    """The container appended at HQR=<offset>: ZW3D's own backup store, not objects of the model."""

    offset: int
    size: int
    entries: int
    header: Z3Header


@dataclass
class Z3File:
    path: Path
    size: int
    status: str = "ok"  # ok / damaged / unsupported / not_z3
    message: str = ""  # Thai, empty when ok
    header: Z3Header = field(default_factory=Z3Header)
    checks: list[Z3Check] = field(default_factory=list)
    objects: list[Z3Object] = field(default_factory=list)
    preview_png: bytes | None = None
    layers: list[tuple[str, int]] = field(default_factory=list)  # (layer name, in how many objects)
    embedded: Z3Embedded | None = None
    records: int = 0
    loose_references: int = 0  # component records owned by no object (parts shown in drawing views)
    warnings: list[str] = field(default_factory=list)  # Thai

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    @property
    def failed_checks(self) -> list[Z3Check]:
        return [c for c in self.checks if not c.ok]

    def count(self, kind: str) -> int:
        return sum(1 for o in self.objects if o.kind == kind)

    def find(self, name: str) -> Z3Object | None:
        """The 3D object with this name (drawings share no names with them: "<object>_2D")."""
        index = self.__dict__.get("_by_name")
        if index is None:
            index = {}
            for o in self.objects:
                if o.kind != "drawing":
                    index.setdefault(_fold(o.name), o)
            self.__dict__["_by_name"] = index
        return index.get(_fold(name))

    def to_dict(self) -> dict:
        h = self.header
        return {
            "file": str(self.path),
            "size": self.size,
            "status": self.status,
            "message": self.message,
            "header": {
                "author": h.author,
                "saved": h.saved.isoformat(sep=" ") if h.saved else h.saved_text,
                "zw3d_build": h.zw3d_build,
                "format_version": h.format_version,
                "platform": h.platform,
            },
            "checks": [{"key": c.key, "label": c.label, "ok": c.ok, "detail": c.detail} for c in self.checks],
            "records": self.records,
            "objects": [
                {
                    "root_id": o.root_id,
                    "kind": o.kind,
                    "name": o.name,
                    "components": [{"name": u.name, "file": u.file, "count": u.count} for u in o.components],
                }
                for o in self.objects
            ],
            "layers": [{"name": n, "count": c} for n, c in self.layers],
            "has_preview": self.preview_png is not None,
            "embedded_backup": (
                {"offset": self.embedded.offset, "size": self.embedded.size, "entries": self.embedded.entries}
                if self.embedded
                else None
            ),
            "loose_references": self.loose_references,
            "warnings": list(self.warnings),
        }


def is_z3(path: str | os.PathLike) -> bool:
    return Path(path).suffix.lower() in Z3_SUFFIXES


def _fold(name: str) -> str:
    # ZW3D runs on Windows: names compare without case; NFC because a folder listing may come decomposed (macOS)
    return unicodedata.normalize("NFC", name).casefold()


# ------------------------------------------------------------------------------------------------ record index


class _Tables:
    """Widths and positions of the eight index fields for every possible control word."""

    def __init__(self) -> None:
        ctrl = np.arange(65536, dtype=np.uint32)
        widths = [(2, 4, 8, 0)] + [(1, 2, 4, 0)] * 6 + [(0, 1, 2, 4)]
        self.size = np.zeros((8, 65536), dtype=np.uint8)
        self.offs = np.zeros((8, 65536), dtype=np.uint8)
        total = np.full(65536, 5, dtype=np.uint8)
        for i, w in enumerate(widths):
            self.size[i] = np.array(w, dtype=np.uint8)[(ctrl >> (2 * i)) & 3]
            self.offs[i] = total
            total = total + self.size[i]
        self.total = total.astype(np.uint8)
        kind = np.arange(256, dtype=np.uint32)
        self.extra = sum((((kind >> (2 * j)) & 3) == 2).astype(np.uint8) for j in range(4)).astype(np.uint8)
        self.mask32 = np.array([0, 0xFF, 0xFFFF, 0, 0xFFFFFFFF], dtype=np.uint32)
        self.mask64 = np.array([0, 0, 0xFFFF, 0, 0xFFFFFFFF, 0, 0, 0, 0xFFFFFFFFFFFFFFFF], dtype=np.uint64)


_TABLES: _Tables | None = None
_CHUNK = 1 << 22  # index bytes handled at a time: bounds the memory whatever the file size
_MARGIN = 64  # longer than any index record (45 bytes)
_LEVELS = 6


@dataclass
class _Index:
    records: int = 0
    consumed: int = 0
    tail_zero: bool = True
    data_end: int = -1
    gaps: list[tuple[int, int, int]] = field(default_factory=list)  # (record number, expected offset, offset)
    n_gaps: int = 0
    unknown_codes: int = 0
    first_offset: int = -1
    ids: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    off: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    sz: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    cls: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    kind: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))

    def lookup(self, rid: int) -> int:
        """Position of the kept record with this id, or -1."""
        i = int(np.searchsorted(self.ids, rid))
        return i if i < len(self.ids) and int(self.ids[i]) == rid else -1

    def of_class(self, cls: int) -> np.ndarray:
        return np.nonzero(self.cls == cls)[0]


def _walk_index(mm, start: int, size: int, keep_ids: np.ndarray) -> _Index:
    """Decode the record index at mm[start:start+size]; keep the entries of the classes in _KEEP and of keep_ids.

    Records have variable length, so where one starts depends on all before it. To avoid a Python loop per record
    (millions), "start of the next record" is computed for every byte position at once and the chain from position 0
    is followed with jump tables (2, 4, ... 64 records ahead); Python only steps once per 64 records.
    """
    global _TABLES
    if _TABLES is None:
        _TABLES = _Tables()
    t = _TABLES
    out = _Index()
    keep_cls = np.zeros(65536, dtype=bool)
    keep_cls[list(_KEEP)] = True
    kept: list[tuple[np.ndarray, ...]] = []
    idx = np.frombuffer(mm, dtype=np.uint8, count=size, offset=start)
    try:
        pos, cur_off, cur_id = 0, -1, 0
        while pos < size:
            zone = min(size, pos + _CHUNK) - pos  # records starting before `zone` belong to this round
            n = min(size, pos + zone + _MARGIN) - pos
            a = np.zeros(n + 16, dtype=np.uint8)
            a[:n] = idx[pos : pos + n]
            ctrl_at = np.ndarray((n,), dtype="<u2", buffer=a, offset=1, strides=(1,))
            reclen = t.total[ctrl_at] + t.extra[a[3 : n + 3]]
            here = np.arange(n + 1, dtype=np.int32)
            nxt = here.copy()
            good = a[:n] == 1
            good[zone:] = False
            good &= here[:n] + reclen <= n  # only bites at the very end: a record may not run past the index
            np.add(here[:n], reclen, out=nxt[:n], where=good)
            jump = [nxt]
            for _ in range(_LEVELS):
                jump.append(jump[-1][jump[-1]])
            far = jump[-1]
            anchors = [0]
            p = 0
            while True:
                q = int(far[p])
                if q == p:
                    break
                anchors.append(q)
                p = q
            starts = np.array(anchors, dtype=np.int32)
            for level in range(_LEVELS - 1, -1, -1):
                both = np.empty(2 * len(starts), dtype=np.int32)
                both[0::2] = starts
                both[1::2] = jump[level][starts]
                starts = both
            stop_at = int(starts[-1])  # the first position that is not a record start (or the end of the zone)
            starts = starts[:-1][good[starts[:-1]]] if stop_at < n else starts[good[np.minimum(starts, n - 1)] & (starts < n)]
            del jump, far, both
            m = len(starts)
            if m:
                ctrl = ctrl_at[starts]
                kind = np.ndarray((n,), dtype="<u2", buffer=a, offset=3, strides=(1,))[starts]
                u32 = np.ndarray((n + 12,), dtype="<u4", buffer=a, strides=(1,))
                u64 = np.ndarray((n + 8,), dtype="<u8", buffer=a, strides=(1,))
                p64 = starts.astype(np.int64)
                w0 = t.size[0][ctrl]
                f0 = (u64[p64 + 5] & t.mask64[w0]).astype(np.int64)
                step = u32[p64 + t.offs[1][ctrl]] & t.mask32[t.size[1][ctrl]]
                sz = (u32[p64 + t.offs[2][ctrl]] & t.mask32[t.size[2][ctrl]]).astype(np.int64)
                cls = (u32[p64 + t.offs[7][ctrl]] & t.mask32[t.size[7][ctrl]]).astype(np.int64)
                code7 = ctrl >> 14
                out.unknown_codes += int(np.count_nonzero((code7 == 0) | (code7 == 3) | (kind > 0xFF) | (cls > 0xFFFF)))
                # offset: given explicitly, or the previous record's end
                has = w0 > 0
                excl = np.cumsum(sz) - sz
                last = np.maximum.accumulate(np.where(has, np.arange(m), -1))
                ref = np.maximum(last, 0)
                off = np.where(last >= 0, f0[ref] - excl[ref], cur_off) + excl
                expected = np.empty(m, dtype=np.int64)
                expected[0] = cur_off
                expected[1:] = off[:-1] + sz[:-1]
                bad = has & (f0 != expected)
                if out.records == 0:
                    out.first_offset = int(off[0]) if has[0] else -1
                    bad[0] = False
                    if not has[0]:
                        out.unknown_codes += 1  # the first record must say where it is
                nbad = int(np.count_nonzero(bad))
                if nbad:
                    out.n_gaps += nbad
                    for i in np.nonzero(bad)[0][: 8 - len(out.gaps)]:
                        out.gaps.append((out.records + int(i), int(expected[i]), int(f0[i])))
                ids = cur_id + np.cumsum(step.astype(np.int64))
                keep = keep_cls[np.minimum(cls, 65535)]
                if len(keep_ids):
                    keep |= np.isin(ids, keep_ids)
                if keep.any():
                    kept.append((ids[keep], off[keep], sz[keep], cls[keep], kind[keep].astype(np.int64)))
                cur_off = int(off[-1] + sz[-1])
                cur_id = int(ids[-1])
                out.records += m
            del a, ctrl_at
            if stop_at < zone or stop_at == 0:
                pos += stop_at
                break
            pos += stop_at
        out.consumed = pos
        out.tail_zero = not idx[pos:].any()
        out.data_end = cur_off
    finally:
        del idx
    if kept:
        out.ids, out.off, out.sz, out.cls, out.kind = (np.concatenate([k[i] for k in kept]) for i in range(5))
        if len(out.ids) > 1 and not (np.diff(out.ids) > 0).all():
            out.unknown_codes += 1  # ids must rise, or looking a record up by id is not safe
    return out


# ------------------------------------------------------------------------------------------------ packed records


class _Packed:
    """Sequential reader of a packed record (see the module docstring)."""

    def __init__(self, data: bytes, pos: int = 1):
        self.d = data
        self.p = pos
        self.codes: list[int] = []
        self.prev_int = 0
        self.prev_chr = 0

    def _code(self) -> int:
        if not self.codes:
            if self.p + 4 > len(self.d):
                raise ValueError("packed record ends early")
            w = int.from_bytes(self.d[self.p : self.p + 4], "little")
            self.p += 4
            self.codes = [(w >> (2 * i)) & 3 for i in range(15, -1, -1)]
        return self.codes.pop()

    def integer(self) -> int:
        c = self._code()
        if c != 3:
            n = (1, 2, 4)[c]
            if self.p + n > len(self.d):
                raise ValueError("packed record ends early")
            self.prev_int = int.from_bytes(self.d[self.p : self.p + n], "little", signed=True)
            self.p += n
        return self.prev_int

    def chars(self, n: int) -> bytes:
        out = bytearray()
        for _ in range(n):
            c = self._code()
            if c == 2:
                if self.p >= len(self.d):
                    raise ValueError("packed record ends early")
                self.prev_chr = self.d[self.p]
                self.p += 1
            elif c != 3:
                self.prev_chr = c  # 0 = NUL, 1 = the byte 1
            out.append(self.prev_chr)
        return bytes(out)

    def string(self) -> bytes | tuple[int, int]:
        """A name field: its bytes, or (length, string record id) when the name is 32+ bytes and stored apart."""
        n = self.integer()
        if not 0 <= n <= 32:
            raise ValueError(f"name field of {n} bytes")
        raw = self.chars(n)
        if n == 32 and raw[:4] == b"\0\0\x03\0":
            length, _ptr, sid = struct.unpack_from("<IQI", raw, 4)
            return (length, sid)
        if any(ch < 32 for ch in raw):
            raise ValueError("control character in a name")
        return raw


# ------------------------------------------------------------------------------------------------ one container


@dataclass
class _Container:
    header: Z3Header
    checks: list[Z3Check]
    index: _Index | None = None
    entries: list[tuple[bytes, int]] = field(default_factory=list)  # (raw 32-byte name field, root record id)
    fatal: bool = False


def _parse_header(text: bytes) -> Z3Header:
    lines = [text[i : i + _LINE].rstrip(b"\n").rstrip(b"*").decode("cp874", "replace") for i in range(0, 0x200, _LINE)]
    h = Z3Header(lines=lines)
    m = re.match(r"^@,([^,]*),([^,]*),(\d+) Z3\((.*)\)$", lines[1])
    if m:
        h.author, h.saved_text, h.saved_unix = m.group(1), m.group(2), int(m.group(3))
        h.zw3d_build = " ".join(m.group(4).split(","))
        d = re.match(r"^\w{3} (\w{3}) +(\d+) (\d+):(\d+):(\d+) (\d{4})$", h.saved_text)
        if d and d.group(1) in _MONTHS:
            try:
                h.saved = datetime(int(d[6]), _MONTHS[d[1]], int(d[2]), int(d[3]), int(d[4]), int(d[5]))
            except ValueError:
                h.saved = None
    h.platform = lines[2]
    parts = lines[2].split(",")
    if len(parts) > 6 and parts[6].isdigit():
        try:
            "".encode("cp" + parts[6])
            h.code_page = "cp" + parts[6]
        except LookupError:
            pass
    fmt = lines[3].split(",")
    if fmt and fmt[0].isdigit():
        h.format_version = int(fmt[0])
    for token in fmt:
        if token.startswith("HQR=") and token[4:].isdigit():
            h.hqr_offset = int(token[4:])
    return h


def _md5(mm, start: int, size: int) -> bytes:
    digest = hashlib.md5()
    for o in range(start, start + size, 1 << 26):
        digest.update(mm[o : min(o + (1 << 26), start + size)])
    return digest.digest()


def _read_container(mm, base: int, end: int, tag: str = "") -> _Container:
    """Check one container occupying mm[base:end] and decode its index. `tag` marks the checks of the HQR part."""
    note = " (ส่วนสำรอง HQR)" if tag else ""
    checks: list[Z3Check] = []

    def check(key: str, label: str, ok: bool, detail: str = "") -> bool:
        checks.append(Z3Check(tag + key, label + note, bool(ok), detail))
        return bool(ok)

    text = bytes(mm[base : base + _TEXT_END]) if end - base >= _TABLE_AT else b""
    header = _parse_header(text) if text else Z3Header()
    box = _Container(header, checks)
    well_formed = (
        len(text) == _TEXT_END
        and text.startswith(b"Z3*")
        and all(text[i * _LINE + _LINE - 1] == 10 for i in (0, 1, 2, 3, 5))
        and header.saved_unix is not None
        and header.format_version > 0
    )
    if not check("header", "ส่วนหัวข้อความของไฟล์ Z3", well_formed, header.lines[1] if header.lines else ""):
        box.fatal = True
        return box
    hb = bytes(mm[base + _TEXT_END : base + _TEXT_END + _BINHDR])
    check("header_copy", "ส่วนหัวสองชุดตรงกัน", hb == bytes(mm[base + _TEXT_END + _BINHDR : base + _TABLE_AT]))
    a, b = struct.unpack_from("<QQ", hb, 16)
    (c,) = struct.unpack_from("<I", hb, 48)
    fits = c >= _ENTRY and c % _ENTRY == 0 and _TABLE_AT + 2 * c <= a and b > 0 and base + a + b + _TRAILER <= end
    if not check(
        "layout", "ขนาดไฟล์ตรงกับที่ส่วนหัวระบุ", fits, f"ดัชนีที่ {a} ยาว {b} ตาราง {c} ไบต์ ไฟล์ส่วนนี้ยาว {end - base}"
    ):
        box.fatal = True
        return box
    table = bytes(mm[base + _TABLE_AT : base + _TABLE_AT + c])
    check("table_copy", "ตารางวัตถุสองชุดตรงกัน", table == bytes(mm[base + _TABLE_AT + c : base + _TABLE_AT + 2 * c]))
    check("md5_table", "รหัสตรวจสอบ MD5 ของตารางวัตถุ", hashlib.md5(table).digest() == hb[52:68])
    check("md5_index", "รหัสตรวจสอบ MD5 ของดัชนีระเบียน", _md5(mm, base + a, b) == hb[32:48])
    check("trailer", "ท้ายไฟล์เป็นศูนย์ 64 ไบต์", not any(mm[base + a + b : base + a + b + _TRAILER]))
    check("end", "ไฟล์จบตรงตำแหน่งที่ควรจบ", base + a + b + _TRAILER == end, f"{base + a + b + _TRAILER} / {end}")
    (count,) = struct.unpack_from("<I", table, 32)
    # slots past the count are not checked: a deleted entry leaves part of its old bytes behind
    table_ok = table[:4] == b"\x01\0\0\0" and not any(table[4:32]) and 1 <= count <= c // _ENTRY
    check("table", "โครงสร้างตารางวัตถุ", table_ok, f"{count - 1} รายการ")
    if any(not k.ok for k in checks):
        box.fatal = True  # offsets cannot be trusted: do not walk
        return box
    for i in range(1, count):
        e = table[_ENTRY * i : _ENTRY * i + _ENTRY]
        box.entries.append((e[:32], struct.unpack_from("<I", e, 32)[0]))
    want = np.unique(np.array([rid for _n, rid in box.entries], dtype=np.int64))
    ix = _walk_index(mm, base + a, b, want)
    box.index = ix
    check(
        "index", "อ่านดัชนีระเบียนได้ครบ", ix.consumed == b or (ix.tail_zero and ix.records > 0), f"{ix.consumed} / {b} ไบต์"
    )
    check("index_codes", "รหัสในดัชนีเป็นแบบที่รู้จัก", ix.unknown_codes == 0, f"ไม่รู้จัก {ix.unknown_codes} จุด")
    # the first record is the table itself; its second copy is the one hole in the data area
    one_hole = ix.gaps == [(1, _TABLE_AT + c, _TABLE_AT + 2 * c)] or (ix.records == 1 and not ix.gaps)
    tiled = ix.first_offset == _TABLE_AT and ix.n_gaps == len(ix.gaps) and one_hole
    tiled = tiled and ix.data_end == (a if ix.records > 1 else _TABLE_AT + c)
    check("tiling", "ระเบียนข้อมูลเรียงต่อกันพอดีจนถึงดัชนี", tiled, f"จบที่ {ix.data_end} ดัชนีเริ่มที่ {a} ช่องว่าง {ix.n_gaps}")
    box.fatal = any(not k.ok for k in checks)
    return box


def _text(raw: bytes, code_page: str) -> str:
    return raw.split(b"\0")[0].decode(code_page, "replace")


def _record(mm, base: int, ix: _Index, i: int) -> bytes:
    return bytes(mm[base + int(ix.off[i]) : base + int(ix.off[i]) + int(ix.sz[i])])


def _long_name(mm, base: int, ix: _Index, length: int, sid: int, code_page: str) -> str | None:
    """The text of a name stored apart, or None when the descriptor does not lead to a string of that length."""
    i = ix.lookup(sid)
    if i < 0 or int(ix.cls[i]) != CLS_STRING or int(ix.sz[i]) != length + 1:
        return None
    raw = _record(mm, base, ix, i)
    if raw[-1] != 0 or 0 in raw[:-1]:
        return None
    return raw[:-1].decode(code_page, "replace")


def _bmp_to_png(bmp: bytes) -> bytes | None:
    """Uncompressed 24/32-bit BMP -> PNG (the preview is always 24-bit; anything else is left out)."""
    if bmp[:2] != b"BM" or len(bmp) < 54:
        return None
    start, _hdr, w, h, _planes, bits, comp = struct.unpack_from("<IIiiHHI", bmp, 10)
    if bits not in (24, 32) or comp != 0 or w <= 0 or h == 0 or w > 8192 or abs(h) > 8192:
        return None
    step = bits // 8
    stride = (w * step + 3) & ~3
    rows = abs(h)
    if start + stride * rows > len(bmp):
        return None
    px = np.frombuffer(bmp, dtype=np.uint8, count=stride * rows, offset=start).reshape(rows, stride)
    px = px[:, : w * step].reshape(rows, w, step)[:, :, 2::-1]  # BGR(A) -> RGB
    if h > 0:
        px = px[::-1]  # BMP rows run bottom-up
    raw = np.zeros((rows, 1 + w * 3), dtype=np.uint8)
    raw[:, 1:] = px.reshape(rows, w * 3)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", w, rows, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw.tobytes(), 6)) + chunk(b"IEND", b"")


def _preview(mm, base: int, ix: _Index) -> bytes | None:
    for i in ix.of_class(CLS_PREVIEW):
        raw = _record(mm, base, ix, int(i))
        if len(raw) < 8 or raw[0] != 0xFF:
            continue
        try:
            bmp = zlib.decompress(raw[5:])
        except zlib.error:
            continue
        if len(bmp) == struct.unpack_from("<I", raw, 1)[0]:
            png = _bmp_to_png(bmp)
            if png:
                return png
    return None


# ------------------------------------------------------------------------------------------------ read_z3


def read_z3(path: str | os.PathLike, strict: bool = True) -> Z3File:
    """Read one ZW3D file. A file that is not Z3, is damaged or fails a check raises Z3Error (Thai message);
    with strict=False the result comes back instead with status / message / checks set and no objects."""
    path = Path(path)
    result = Z3File(path=path, size=0)
    try:
        result.size = path.stat().st_size
        with open(path, "rb") as f:
            head = f.read(_TABLE_AT)
            if len(head) < _TABLE_AT or not head.startswith(b"Z3*"):
                result.status = "not_z3"
                result.message = f"“{path.name}” ไม่ใช่ไฟล์ ZW3D (.Z3 / .Z3PRT / .Z3ASM)"
            else:
                mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
                try:
                    _read_into(result, mm)
                finally:
                    try:
                        mm.close()
                    except BufferError:  # an exception's traceback still holds a view: the OS unmaps it later
                        pass
    except OSError as exc:
        result.status = "damaged"
        result.message = f"เปิดไฟล์ “{path.name}” ไม่ได้: {exc.strerror or exc}"
    if not result.ok:
        result.objects, result.preview_png, result.layers = [], None, []
        if strict:
            raise Z3Error(result.message, result.status, result.checks)
    return result


def _fail(result: Z3File, status: str) -> None:
    failed = ", ".join(c.label for c in result.failed_checks)
    what = "เสียหายหรือบันทึกไม่ครบ" if status == "damaged" else "เป็นรูปแบบที่โปรแกรมยังไม่รองรับ"
    result.status = status
    result.message = f"ไฟล์ “{result.path.name}” {what} – ไม่ผ่านการตรวจ: {failed}"


def _read_into(result: Z3File, mm) -> None:
    size = len(mm)
    header = _parse_header(bytes(mm[:_TEXT_END]))
    hqr = header.hqr_offset
    if hqr is not None and not _TABLE_AT < hqr <= size - _TABLE_AT:
        result.header = header
        result.checks.append(Z3Check("hqr_offset", "ตำแหน่งส่วนสำรอง HQR อยู่ในไฟล์", False, f"{hqr} / {size}"))
        return _fail(result, "damaged")
    main = _read_container(mm, 0, hqr if hqr is not None else size)
    result.header, result.checks = main.header, main.checks
    if main.fatal:
        return _fail(result, "damaged")
    ix = main.index
    assert ix is not None
    result.records = ix.records
    if hqr is not None:
        back = _read_container(mm, hqr, size, "hqr.")
        result.checks += back.checks
        if back.fatal:
            return _fail(result, "damaged")
        result.embedded = Z3Embedded(hqr, size - hqr, len(back.entries), back.header)
    cp = header.code_page

    # ---- objects: the root table names them, the class of the root record says 3D or 2D
    objects: dict[int, Z3Object] = {}
    lost: list[str] = []
    for raw, rid in main.entries:
        i = ix.lookup(rid)
        if raw[:4] == b"\0\0\x03\0":
            length, _ptr, sid = struct.unpack_from("<IQI", raw, 4)
            name = _long_name(mm, 0, ix, length, sid, cp)
            if name is None:
                lost.append(f"วัตถุ {rid}")
                name = f"<{rid}>"
        else:
            name = _text(raw, cp)
        cls = int(ix.cls[i]) if i >= 0 else -1
        kind = {CLS_OBJECT3D: "part", CLS_DRAWING: "drawing"}.get(cls, "other")
        if i < 0 or kind == "other" or rid in objects:
            lost.append(f"{name} ({rid})")
        objects[rid] = Z3Object(rid, kind, name, record_class=cls)
    # a root record the table does not list is an object that was deleted or replaced: nothing can refer to it
    roots = ix.ids[(ix.cls == CLS_OBJECT3D) | (ix.cls == CLS_DRAWING)]
    orphans = {int(r) for r in roots} - set(objects)
    if orphans:
        result.warnings.append(f"ข้ามวัตถุที่ถูกลบแล้วแต่ยังค้างในไฟล์ {len(orphans)} ตัว")
    renamed = 0
    for obj in objects.values():
        if obj.kind == "part":  # the root record of a 3D object starts with its name: must agree with the table
            try:
                s = _Packed(_record(mm, 0, ix, ix.lookup(obj.root_id))).string()
                own = _long_name(mm, 0, ix, s[0], s[1], cp) if isinstance(s, tuple) else s.decode(cp, "replace")
            except (ValueError, IndexError, struct.error):
                own = None
            renamed += own != obj.name
    result.checks.append(
        Z3Check(
            "objects",
            "วัตถุทุกตัวในตารางมีระเบียนหลัก และชื่ออ่านได้ตรงกัน",
            not lost and not renamed,
            "; ".join(lost[:5]) or (f"ชื่อไม่ตรง {renamed} ตัว" if renamed else f"{len(objects)} วัตถุ"),
        )
    )

    # ---- components: each record names its target and carries the root id of the object that owns it
    uses: dict[int, dict[tuple[str, str], Z3Use]] = {}
    broken: list[str] = []
    for i in ix.of_class(CLS_COMPONENT):
        i = int(i)
        rid = int(ix.ids[i])
        try:
            if int(ix.kind[i]) & 0x20:
                raise ValueError("stored raw")
            pk = _Packed(_record(mm, 0, ix, i))
            names = []
            for _ in range(5):
                s = pk.string()
                if isinstance(s, tuple):
                    long = _long_name(mm, 0, ix, s[0], s[1], cp)
                    if long is None:
                        raise ValueError(f"long name {s[1]} not found")
                    names.append(long)
                else:
                    names.append(s.decode(cp, "replace"))
            owner = [pk.integer() for _ in range(4)][3]
        except (ValueError, IndexError, struct.error) as exc:
            broken.append(f"ระเบียน {rid}: {exc}")
            continue
        instance, file, target = names[0], names[1], names[2]
        if owner == -1:
            result.loose_references += 1
            continue
        if owner in orphans:
            continue
        parent = objects.get(owner)
        if parent is None or parent.kind == "drawing" or parent.kind == "other" or not (target or file):
            broken.append(f"ระเบียน {rid}: เจ้าของ {owner}")
            continue
        use = uses.setdefault(owner, {}).setdefault((_fold(file), _fold(target)), Z3Use(target, file, 0))
        use.count += 1
        use.instances.append(instance)
    result.checks.append(
        Z3Check(
            "components",
            "ระเบียนชิ้นส่วนย่อยอ่านได้ครบและมีเจ้าของ",
            not broken,
            "; ".join(broken[:5]) or f"{sum(u.count for d in uses.values() for u in d.values())} รายการ",
        )
    )
    for owner, rows in uses.items():
        objects[owner].kind = "assembly"
        objects[owner].components = sorted(rows.values(), key=lambda u: (_fold(u.name), _fold(u.file)))
    result.objects = sorted(objects.values(), key=lambda o: o.root_id)
    if result.failed_checks:
        return _fail(result, "unsupported")

    layers: dict[str, int] = {}
    for i in ix.of_class(CLS_LAYER):
        name = _text(_record(mm, 0, ix, int(i))[:32], cp)
        layers[name] = layers.get(name, 0) + 1
    result.layers = sorted(layers.items())
    result.preview_png = _preview(mm, 0, ix)
    if header.format_version not in KNOWN_FORMATS:
        result.warnings.append(
            f"รูปแบบไฟล์รุ่น {header.format_version} ยังไม่เคยทดสอบ (ทดสอบแล้ว: {', '.join(map(str, KNOWN_FORMATS))}) – ผ่านการตรวจทุกข้อ แต่ควรสุ่มตรวจรายการ"
        )
    names = [_fold(o.name) for o in result.objects if o.kind != "drawing"]
    if len(set(names)) != len(names):
        result.warnings.append("มีวัตถุชื่อซ้ำกันในไฟล์ – การอ้างอิงตามชื่อจะใช้ตัวแรก")


# ------------------------------------------------------------------------------------------------ BOM


@dataclass
class BomNode:
    name: str
    kind: str  # part / assembly / missing_file / missing_object / bad_file / external / cycle
    qty: int = 1  # in one parent
    total: int = 1  # in the whole top assembly
    file: str = ""  # file that holds the object when it is not the file being listed
    note: str = ""  # Thai
    children: list[BomNode] = field(default_factory=list)


@dataclass
class BomLine:
    name: str
    qty: int
    file: str = ""
    note: str = ""


@dataclass
class Bom:
    root: BomNode | None = None
    flat: list[BomLine] = field(default_factory=list)  # parts only (what has to be made or bought)
    assemblies: list[BomLine] = field(default_factory=list)  # sub-assemblies with their total counts
    unused: list[Z3Object] = field(default_factory=list)  # 3D objects of the file that nothing in it uses
    missing_files: list[str] = field(default_factory=list)
    depth: int = 0  # levels below the top assembly
    warnings: list[str] = field(default_factory=list)

    @property
    def total_parts(self) -> int:
        return sum(line.qty for line in self.flat)


class Z3Library:
    """Reads the files that assemblies refer to, once each; they are looked for next to the file that names them."""

    def __init__(self) -> None:
        self._files: dict[Path, Z3File] = {}
        self._folders: dict[Path, dict[str, Path]] = {}

    def add(self, z3: Z3File) -> None:
        self._files[z3.path.resolve()] = z3

    def locate(self, folder: Path, name: str) -> Path | None:
        listing = self._folders.get(folder)
        if listing is None:
            listing = {}
            try:
                for p in sorted(folder.iterdir()):
                    if p.is_file() and is_z3(p):
                        listing.setdefault(_fold(p.name), p)
            except OSError:
                pass
            self._folders[folder] = listing
        return listing.get(_fold(name))

    def read(self, path: Path) -> Z3File:
        key = path.resolve()
        if key not in self._files:
            self._files[key] = read_z3(path, strict=False)
        return self._files[key]


def _local_uses(z3: Z3File, obj: Z3Object) -> list[tuple[Z3Use, Z3Object | None]]:
    """The object's components with the target object when it lives in the same file."""
    own = _fold(z3.path.name)
    return [(u, z3.find(u.name) if (not u.file or _fold(u.file) == own) and u.name else None) for u in obj.components]


def _local_parts(z3: Z3File) -> dict[int, int]:
    """Parts under each 3D object counting only this file (a reference to another file counts as one part)."""
    memo: dict[int, int] = {}

    def count(obj: Z3Object, stack: tuple[int, ...]) -> int:
        if obj.root_id in memo:
            return memo[obj.root_id]
        if obj.root_id in stack or not obj.components:
            return 1
        total = 0
        for use, target in _local_uses(z3, obj):
            total += use.count * (count(target, stack + (obj.root_id,)) if target else 1)
        memo[obj.root_id] = total
        return total

    return {o.root_id: count(o, ()) for o in z3.objects if o.kind in ("part", "assembly")}


def top_candidates(z3: Z3File) -> list[Z3Object]:
    """3D objects that no assembly of the file uses, the one with the most parts under it first."""
    used: set[int] = set()
    for o in z3.objects:
        used.update(t.root_id for _u, t in _local_uses(z3, o) if t is not None and t is not o)
    parts = _local_parts(z3)
    free = [o for o in z3.objects if o.kind in ("part", "assembly") and o.root_id not in used]
    return sorted(free, key=lambda o: (-parts[o.root_id], -len(o.components), o.root_id))


def find_top(z3: Z3File) -> Z3Object | None:
    """The top assembly: used by nothing in the file, and of those the one with the most parts under it (ties: the
    one with more component rows, then the older one). None when the file holds no 3D object."""
    free = top_candidates(z3)
    if free:
        return free[0]
    solids = [o for o in z3.objects if o.kind in ("part", "assembly")]
    return solids[0] if solids else None  # every object is used by another: a loop; start anywhere


def bom(z3: Z3File, root: Z3Object | str | None = None, resolve: bool = True, library: Z3Library | None = None) -> Bom:
    """The tree under `root` (default: find_top) with counts multiplied through, the flat parts list, and the 3D
    objects of the file that the tree's file leaves unused. With resolve=True components that live in another file
    are followed into that file when it is in the same folder; files that are not there are listed as missing."""
    out = Bom()
    if not z3.ok:
        raise Z3Error(z3.message or "ไฟล์นี้อ่านไม่ได้", z3.status, z3.checks)
    if isinstance(root, str):
        found = z3.find(root)
        if found is None:
            raise Z3Error(f"ไม่พบวัตถุชื่อ “{root}” ในไฟล์ “{z3.path.name}”", "not_found")
        root = found
    top = root or find_top(z3)
    if top is None:
        out.warnings.append("ไฟล์นี้ไม่มีวัตถุ 3 มิติ")
        return out
    library = library or Z3Library()
    library.add(z3)
    home = z3.path.resolve()
    flat: dict[tuple[str, str, str], BomLine] = {}
    subs: dict[tuple[str, str], BomLine] = {}
    missing: dict[str, None] = {}

    def add(table: dict, key: tuple, name: str, file: str, qty: int, note: str = "") -> None:
        line = table.setdefault(key, BomLine(name, 0, file, note))
        line.qty += qty

    def leaf(name: str, kind: str, qty: int, total: int, file: str, note: str) -> BomNode:
        add(flat, (_fold(name), _fold(file), kind), name, file, total, note)
        return BomNode(name, kind, qty, total, file, note)

    def expand(src: Z3File, obj: Z3Object, qty: int, total: int, stack: tuple, level: int) -> BomNode:
        label = "" if src.path.resolve() == home else src.path.name
        key = (src.path.resolve(), obj.root_id)
        if key in stack:
            out.warnings.append(f"“{obj.name}” อ้างอิงวนกลับมาที่ตัวเอง")
            return leaf(obj.name, "cycle", qty, total, label, "อ้างอิงวนกลับ")
        if not obj.components:
            out.depth = max(out.depth, level)
            return leaf(obj.name, "part", qty, total, label, "")
        node = BomNode(obj.name, "assembly", qty, total, label)
        if level:
            add(subs, (_fold(obj.name), _fold(label)), obj.name, label, total)
        own = _fold(src.path.name)
        for use in obj.components:
            n, t = use.count, total * use.count
            out.depth = max(out.depth, level + 1)
            if not use.file or _fold(use.file) == own:
                target = src.find(use.name) if use.name else None
                if target is None:
                    node.children.append(leaf(use.name, "missing_object", n, t, label, "ไม่พบวัตถุชื่อนี้ในไฟล์"))
                else:
                    node.children.append(expand(src, target, n, t, stack + (key,), level + 1))
                continue
            shown = use.name or Path(use.file).stem
            if not resolve:
                node.children.append(leaf(shown, "external", n, t, use.file, "อยู่ในไฟล์อื่น (ไม่ได้เปิดดู)"))
                continue
            where = library.locate(src.path.resolve().parent, use.file)
            if where is None:
                missing.setdefault(use.file)
                node.children.append(leaf(shown, "missing_file", n, t, use.file, "ไม่พบไฟล์นี้ในโฟลเดอร์"))
                continue
            other = library.read(where)
            if not other.ok:
                out.warnings.append(other.message)
                node.children.append(leaf(shown, "bad_file", n, t, use.file, "ไฟล์เสียหายหรือยังไม่รองรับ"))
                continue
            target = other.find(use.name) if use.name else find_top(other)
            if target is None:
                node.children.append(leaf(shown, "missing_object", n, t, use.file, "ไม่พบวัตถุชื่อนี้ในไฟล์ที่อ้างถึง"))
            else:
                node.children.append(expand(other, target, n, t, stack + (key,), level + 1))
        return node

    out.root = expand(z3, top, 1, 1, (), 0)
    out.flat = sorted(flat.values(), key=lambda line: (_fold(line.file), _fold(line.name)))
    out.assemblies = sorted(subs.values(), key=lambda line: (_fold(line.file), _fold(line.name)))
    out.missing_files = list(missing)
    out.unused = [o for o in top_candidates(z3) if o.root_id != top.root_id]
    return out


def tree_lines(node: BomNode | None) -> list[str]:
    """The tree as indented text, one line per node: "6 × name  [ชุดประกอบ]"."""
    lines: list[str] = []

    def walk(n: BomNode, prefix: str, tail: str, first: bool) -> None:
        extra = []
        if n.kind == "assembly":
            extra.append("[ชุดประกอบ]")
        if n.file:
            extra.append(f"[ไฟล์: {n.file}]")
        if n.note:
            extra.append(f"({n.note})")
        if not first and n.total != n.qty:
            extra.append(f"รวม {n.total}")
        head = n.name if first else f"{n.qty} × {n.name}"
        lines.append(prefix + tail + "  ".join([head] + extra))
        below = prefix + ("" if first else ("   " if tail == "└─ " else "│  "))
        for i, c in enumerate(n.children):
            walk(c, below, "└─ " if i == len(n.children) - 1 else "├─ ", False)

    if node is not None:
        walk(node, "", "", True)
    return lines
