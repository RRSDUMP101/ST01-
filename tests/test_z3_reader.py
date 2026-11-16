"""core/z3_reader.py and tools/z3_list.py: ZW3D files read without ZW3D.

No customer file is used. `Z3Builder` below writes a container from the layout documented in z3_reader: the text
lines, the binary header twice with real MD5s, the root table twice, records back to back, the record index, 64 zero
bytes and, when asked, a second container appended at HQR=<offset>. Names are Thai (code page 874).

What the real format holds that is not understood, and is therefore written here as a harmless stand-in that the
reader never interprets: the first 16 bytes of the binary header; index fields 3-6 (element size, link, next,
previous) and the extra bytes after the fields; everything in the root record of a 3D object after its name; the
integers of a component record other than the fourth (the owner); the body of a 2D drawing and of the HQR backup
entries; the codes that pad the last control word of a packed record. The reader was checked on the real files by
hand (every file passes its checks, object names equal the STEP product names); these tests pin the behaviour.
"""

import csv
import hashlib
import importlib.util
import io
import json
import random
import struct
import time
import zlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from partlist_studio.core import z3_reader as z3

TOOL = Path(__file__).resolve().parents[1] / "tools" / "z3_list.py"
CP = "cp874"
LONG = "แผ่นเหล็กเสริมมุมด้านหลังฝั่งซ้าย หนา 3 มม. รุ่นทดสอบ"  # 32+ bytes: stored apart from its record
N31, N32 = "ก" * 31, "ข" * 32  # the longest name kept in place, the shortest stored apart


# ------------------------------------------------------------------------------------------------ builder


class Packer:
    """Writes a packed record: a version byte, then control words of 16 two-bit codes, each before its items."""

    def __init__(self, version: int):
        self.version, self.items, self.prev_int, self.prev_chr = version, [], 0, 0

    def integer(self, v: int) -> None:
        if v == self.prev_int:
            self.items.append((3, b""))
        elif -128 <= v < 128:
            self.items.append((0, v.to_bytes(1, "little", signed=True)))
        elif -32768 <= v < 32768:
            self.items.append((1, v.to_bytes(2, "little", signed=True)))
        else:
            self.items.append((2, v.to_bytes(4, "little", signed=True)))
        self.prev_int = v

    def string(self, raw: bytes) -> None:
        self.integer(len(raw))
        for b in raw:
            if b == self.prev_chr:
                self.items.append((3, b""))
            elif b < 2:
                self.items.append((b, b""))  # NUL and the byte 1 have codes of their own
            else:
                self.items.append((2, bytes([b])))
            self.prev_chr = b

    def data(self) -> bytes:
        out = bytearray([self.version])
        for k in range(0, len(self.items), 16):
            group = self.items[k : k + 16]
            out += struct.pack("<I", sum(code << (2 * i) for i, (code, _d) in enumerate(group)))
            out += b"".join(d for _code, d in group)
        return bytes(out)


def index_entry(offset, id_step, size, cls, kind, esz=None, link=None, nxt=None, prev=None) -> bytes:
    """One record of the index; None = the field is absent."""
    ctrl, body = 0, b""
    if offset is None:
        ctrl |= 3
    else:
        code = 0 if offset < 1 << 16 else (1 if offset < 1 << 32 else 2)
        ctrl |= code
        body += offset.to_bytes((2, 4, 8)[code], "little")
    for i, v in enumerate((id_step, size, esz, link, nxt, prev), start=1):
        if v is None:
            ctrl |= 3 << (2 * i)
            continue
        code = 0 if -128 <= v < 256 else (1 if -32768 <= v < 65536 else 2)
        if v < 0:
            code = 0 if v >= -128 else (1 if v >= -32768 else 2)
        ctrl |= code << (2 * i)
        body += (v % (1 << (8 << code))).to_bytes(1 << code, "little")
    code = 1 if cls < 256 else 2
    ctrl |= code << 14
    body += cls.to_bytes(code, "little")
    extra = bytes(0x40 + j for j in range(4) if (kind >> (2 * j)) & 3 == 2)
    return b"\x01" + struct.pack("<HH", ctrl, kind) + body + extra


def bmp24(width: int, height: int, pixel) -> bytes:
    """Bottom-up 24-bit BMP; pixel(x, y) -> (r, g, b) with y = 0 at the top."""
    stride = (width * 3 + 3) & ~3
    rows = b""
    for y in range(height - 1, -1, -1):
        row = b"".join(bytes(pixel(x, y)[::-1]) for x in range(width))
        rows += row + b"\0" * (stride - len(row))
    head = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(rows), 2835, 2835, 0, 0)
    return b"BM" + struct.pack("<IHHI", 54 + len(rows), 0, 0, 54) + head + rows


class Z3Builder:
    def __init__(self, fmt: int = 3000, build: str = "ZWSim,6.0,0123456789ab", author: str = "TESTER"):
        self.fmt, self.build_id, self.author = fmt, build, author
        self.roots: list[tuple[bytes, int]] = []
        self.records: dict[int, tuple[int, int, bytes]] = {}  # id -> (class, kind, data)
        self.next_id = 54
        self.uid = 200000
        self.wrong_offset_at: int | None = None  # give this record a wrong explicit offset (MD5s stay right)

    # ---- records
    def record(self, cls: int, data: bytes, kind: int, rid: int | None = None) -> int:
        if rid is None:
            rid = self.next_id
            self.next_id += 1 + (len(self.records) * 7) % 5  # ids rise in uneven steps, like in real files
        assert rid not in self.records
        self.records[rid] = (cls, kind, data)
        return rid

    def jump(self, to: int) -> None:
        """Continue numbering at `to`: real ids grow to millions, which needs 2- and 4-byte steps in the index."""
        assert to >= self.next_id
        self.next_id = to

    def string(self, text: str, rid: int | None = None) -> int:
        return self.record(z3.CLS_STRING, text.encode(CP) + b"\0", 0x3F, rid)

    def name_field(self, name: str, rid: int | None = None) -> bytes:
        raw = name.encode(CP)
        if len(raw) < 32:
            return raw
        sid = self.string(name, rid)
        return struct.pack("<HHIQIIQ", 0, 3, len(raw), 0x1F2E3D4C5B0, sid, len(raw) + 1, 0)

    def obj3d(self, name: str, listed: bool = True, string_id: int | None = None) -> int:
        pk = Packer(0x1D)
        pk.string(self.name_field(name, string_id))
        for v in (100001, 300003, 20002, -1, -1, 0, 1):
            pk.integer(v)
        rid = self.record(z3.CLS_OBJECT3D, pk.data(), 0x0A)
        if listed:
            self.roots.append((self.name_field(name).ljust(32, b"\0"), rid))
        return rid

    def drawing(self, name: str) -> int:
        rid = self.record(z3.CLS_DRAWING, name.encode(CP).ljust(64, b"\0"), 0x32)
        self.roots.append((self.name_field(name).ljust(32, b"\0"), rid))
        return rid

    def component(self, owner: int, target: str, file: str = "", instance: str | None = None, n: int = 1) -> None:
        for k in range(n):
            inst = f"{target or Path(file).stem}_{k + 1}" if instance is None else instance
            pk = Packer(0x0A)
            for text in (inst, file, target, inst, ""):
                pk.string(self.name_field(text))
            self.uid += 3
            for v in (self.uid, 300003, 20002, owner, self.next_id + 12, -1, -1, 0, 0, 4):
                pk.integer(v)
            self.record(z3.CLS_COMPONENT, pk.data(), 0x0A)

    def layer(self, name: str, encoding: str = CP) -> None:
        self.record(z3.CLS_LAYER, name.encode(encoding).ljust(32, b"\0") + b"\xff" * 4 + b"\0" * 92, 0x32)

    def preview(self, bmp: bytes) -> None:
        self.record(z3.CLS_PREVIEW, b"\xff" + struct.pack("<I", len(bmp)) + zlib.compress(bmp), 0x0A)

    def backup_entry(self, name: str) -> None:
        self.roots.append((name.encode(CP).ljust(32, b"\0"), self.record(10, b"\x01" * 8, 0x3F)))

    # ---- the file
    def text(self, hqr: int | None) -> bytes:
        lines = [
            "Z3",
            f"@,{self.author},Mon Nov 16 09:30:05 2026,1794821405 Z3({self.build_id})",
            "ZWSOFT,V1,WindowsNT,6.2,686,7,874,0,0",
            f"{self.fmt},0,,0,8,101010:0123456789a,@202020:ba9876543210" + (f",HQR={hqr}" if hqr is not None else ""),
        ]
        out = b"".join(line.encode(CP).ljust(127, b"*") + b"\n" for line in lines)
        return out + b"*" * 255 + b"\n"

    def build(self, hqr: bytes | None = None) -> bytes:
        slots = 10 * (len(self.roots) // 10 + 1)  # the table grows ten entries at a time
        table = struct.pack("<I28xI", 1, len(self.roots) + 1)
        table += b"".join(name + struct.pack("<I", rid) for name, rid in self.roots)
        table = table.ljust(36 * (1 + slots), b"\0")
        c = len(table)
        data, index = b"", index_entry(0x390, None, c, z3.CLS_TABLE, 0x32, link=512)
        offset, last = 0x390 + 2 * c, 0
        for n, rid in enumerate(sorted(self.records)):
            cls, kind, blob = self.records[rid]
            at = offset if n == 0 or n % 7 == 3 else None  # mostly "continues", sometimes said outright
            if n == self.wrong_offset_at:
                at = offset + 5
            esz = len(blob) if kind & 0x20 and n % 2 else None
            nxt, prev = (rid + 4, -8) if cls == z3.CLS_COMPONENT else (None, None)
            index += index_entry(at, rid - last, len(blob), cls, kind, esz=esz, nxt=nxt, prev=prev)
            data += blob
            offset += len(blob)
            last = rid
        a = 0x390 + 2 * c + len(data)
        head = b"\x5a\xa5\x3c\xc3" * 4 + struct.pack("<QQ", a, len(index)) + hashlib.md5(index).digest()
        head += struct.pack("<I", c) + hashlib.md5(table).digest() + b"\0" * 4
        body = head * 2 + table * 2 + data + index + b"\0" * 64
        return self.text(0x300 + len(body) if hqr is not None else None) + body + (hqr or b"")


def model() -> Z3Builder:
    """Two levels: top -> 2 x post (3 bolts + 1 rail each), 1 floor, 4 bolts, 1 rail, 3 uses of other files."""
    b = Z3Builder()
    top = b.obj3d("งานประกอบ ทดสอบ")
    post = b.obj3d("ชุดเสา")
    b.obj3d("แผ่นพื้น")
    b.jump(700)
    b.obj3d("น็อต M16")
    b.obj3d(LONG, string_id=1)  # string record 1: its id is written with the "byte 1" character code
    b.jump(70000)
    b.obj3d("ชิ้นส่วนสำรอง")
    b.obj3d(N31)
    b.obj3d(N32)
    b.drawing("แผ่นพื้น_2D")
    b.component(top, "ชุดเสา", n=2)
    b.component(top, "แผ่นพื้น")
    b.component(top, "น็อต M16", n=4)
    b.component(top, LONG)
    b.component(top, "", file="สลัก.Z3PRT", n=2)
    b.component(top, "โคมไฟท้าย", file="ชุดไฟ.Z3")
    b.jump(9000000)
    b.component(post, "น็อต M16", n=3)
    b.component(post, LONG)
    b.component(-1, "แผ่นพื้น", instance="")  # a part shown in the drawing: belongs to no assembly
    b.layer("Layer0000")
    b.layer("Layer0000")
    b.layer("ตัวหน้า")
    b.preview(bmp24(5, 3, lambda x, y: (255, 0, 0) if (x, y) == (0, 0) else (0, 10 * x, 80 * y)))
    return b


def lamp_file() -> bytes:
    b = Z3Builder(fmt=2900, build="ZWSim,5.0,11111:0a0b0c0d0e0f", author="WORKSHOP")
    lamp = b.obj3d("โคมไฟท้าย")
    b.obj3d("หลอดไฟ")
    b.obj3d("ฝาครอบ")
    b.component(lamp, "หลอดไฟ", n=2)
    b.component(lamp, "ฝาครอบ")
    return b.build()


def pin_file() -> bytes:
    b = Z3Builder()
    b.obj3d("สลัก")
    return b.build()


@pytest.fixture
def main_file(tmp_path):
    path = tmp_path / "งานประกอบ ทดสอบ.Z3"
    path.write_bytes(model().build())
    return path


def write(tmp_path, data: bytes, name: str = "ทดสอบ.Z3") -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


# ------------------------------------------------------------------------------------------------ reading


def test_header_checks_and_objects(main_file):
    f = z3.read_z3(main_file)
    assert f.ok and f.message == "" and not f.failed_checks
    assert {c.key for c in f.checks} >= {"header", "md5_table", "md5_index", "tiling", "index", "objects", "components"}
    assert all(c.label and not c.label.isascii() for c in f.checks)  # shown to the user: Thai
    h = f.header
    assert (h.author, h.format_version, h.zw3d_build) == ("TESTER", 3000, "ZWSim 6.0 0123456789ab")
    assert h.saved.isoformat() == "2026-11-16T09:30:05" and h.saved_unix == 1794821405 and h.code_page == "cp874"
    assert [(o.kind, o.name) for o in f.objects] == [
        ("assembly", "งานประกอบ ทดสอบ"),
        ("assembly", "ชุดเสา"),
        ("part", "แผ่นพื้น"),
        ("part", "น็อต M16"),
        ("part", LONG),
        ("part", "ชิ้นส่วนสำรอง"),
        ("part", N31),
        ("part", N32),
        ("drawing", "แผ่นพื้น_2D"),
    ]
    assert f.objects[0].root_id == 54 and f.objects[-1].root_id > 70000
    assert (f.count("part"), f.count("assembly"), f.count("drawing")) == (6, 2, 1)
    assert f.layers == [("Layer0000", 2), ("ตัวหน้า", 1)]
    assert f.loose_references == 1 and f.embedded is None and f.warnings == []


def test_components_are_grouped_with_counts(main_file):
    f = z3.read_z3(main_file)
    top, post = f.objects[0], f.objects[1]
    assert [(u.count, u.name, u.file) for u in top.components] == [
        (2, "", "สลัก.Z3PRT"),
        (2, "ชุดเสา", ""),
        (4, "น็อต M16", ""),
        (1, "แผ่นพื้น", ""),
        (1, LONG, ""),
        (1, "โคมไฟท้าย", "ชุดไฟ.Z3"),
    ]
    assert [(u.count, u.name) for u in post.components] == [(3, "น็อต M16"), (1, LONG)]
    assert top.components[1].instances == ["ชุดเสา_1", "ชุดเสา_2"]
    assert f.find("น็อต m16") is f.objects[3] and f.find("ไม่มี") is None  # Windows names: case does not matter


def test_preview_is_a_png_the_right_way_up(main_file):
    png = z3.read_z3(main_file).preview_png
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    im = Image.open(io.BytesIO(png)).convert("RGB")
    assert im.size == (5, 3)
    assert im.getpixel((0, 0)) == (255, 0, 0) and im.getpixel((4, 2)) == (0, 40, 160)


def test_file_without_preview_or_3d_objects(tmp_path):
    b = Z3Builder()
    b.drawing("แบบเปล่า_2D")
    f = z3.read_z3(write(tmp_path, b.build()))
    assert f.ok and f.preview_png is None and z3.find_top(f) is None
    assert z3.bom(f).root is None and z3.bom(f).warnings == ["ไฟล์นี้ไม่มีวัตถุ 3 มิติ"]


def test_appended_hqr_container_is_checked_but_not_listed(tmp_path):
    back = Z3Builder(fmt=2900, build="ZWSim,5.0,11111:0a0b0c0d0e0f")
    for n in range(12):
        back.backup_entry(f"HQR_BAK_{n}_1111_2222_{3333 + n}")
    f = z3.read_z3(write(tmp_path, model().build(hqr=back.build())))
    assert f.ok and len(f.objects) == 9
    assert f.embedded.entries == 12 and f.embedded.header.format_version == 2900
    assert f.embedded.offset + f.embedded.size == f.size
    assert sum(c.key.startswith("hqr.") for c in f.checks) >= 8


def test_layer_name_written_in_utf8_is_not_garbled(tmp_path):
    b = Z3Builder()
    b.obj3d("ฝา")
    b.layer("มือจับ", encoding="utf-8")  # real files hold both: cp874 and, from a .zwlyr file, UTF-8
    b.layer("มือจับ")
    b.layer("Layer0001")
    assert z3.read_z3(write(tmp_path, b.build())).layers == [("Layer0001", 1), ("มือจับ", 2)]


def test_unknown_format_version_reads_with_a_warning(tmp_path):
    b = model()
    b.fmt = 3100
    f = z3.read_z3(write(tmp_path, b.build()))
    assert f.ok and len(f.warnings) == 1 and "3100" in f.warnings[0]


def test_deleted_object_left_in_the_file_is_skipped(tmp_path):
    b = Z3Builder()
    top = b.obj3d("ชุดบน")
    b.obj3d("ฝา")
    ghost = b.obj3d("ฝาเก่า", listed=False)  # root record still there, gone from the table
    b.component(top, "ฝา", n=2)
    b.component(ghost, "ฝา")
    f = z3.read_z3(write(tmp_path, b.build()))
    assert f.ok and [o.name for o in f.objects] == ["ชุดบน", "ฝา"]
    assert [(u.count, u.name) for u in f.objects[0].components] == [(2, "ฝา")]
    assert len(f.warnings) == 1 and "ถูกลบ" in f.warnings[0]


def test_same_result_whatever_the_chunk_size(main_file, monkeypatch):
    whole = z3.read_z3(main_file).to_dict()
    for chunk in (1, 37, 64, 200, 4096):
        monkeypatch.setattr(z3, "_CHUNK", chunk)
        assert z3.read_z3(main_file).to_dict() == whole


# ------------------------------------------------------------------------------------------------ record index


def reference_walk(index: bytes) -> list[tuple[int, int, int, int]]:
    """The index decoded one record at a time, straight from the documented layout: (id, offset, size, class)."""
    widths = [(2, 4, 8, 0)] + [(1, 2, 4, 0)] * 6 + [(0, 1, 2, 4)]
    out, p, rid, off = [], 0, 0, 0
    while p + 5 <= len(index) and index[p] == 1:
        ctrl, kind = struct.unpack_from("<HH", index, p + 1)
        q, f = p + 5, [None] * 8
        for i in range(8):
            w = widths[i][(ctrl >> (2 * i)) & 3]
            if w:
                f[i] = int.from_bytes(index[q : q + w], "little")
                q += w
        q += sum((kind >> (2 * j)) & 3 == 2 for j in range(4))
        if q > len(index):
            break
        off = off if f[0] is None else f[0]
        rid += f[1] or 0
        out.append((rid, off, f[2] or 0, f[7] or 0))
        off += f[2] or 0
        p = q
    return out


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_index_walk_matches_a_record_by_record_decoder(seed, monkeypatch):
    rng = random.Random(seed)
    classes = [2, 3, 13, 67, 88, 89, 90, 8, 15, 302, 449]
    index, offset = b"", 1000
    for n in range(3000):
        size = rng.choice([0, 4, 13, 200, 70000, 3_000_000])
        jumped = n == 0 or rng.random() < 0.1
        if jumped:
            offset += rng.choice([0, 0, 17, 1 << 20, 1 << 33])
        link, nxt, prev = (rng.choice([None, 5, 300, 1 << 20]) for _ in range(3))
        index += index_entry(
            offset if jumped else None,
            rng.choice([1, 1, 2, 9, 300, 70000]) if n else None,
            size or None,
            rng.choice(classes),
            rng.choice([0x0A, 0x0B, 0x09, 0x31, 0x32, 0x3F, 0x2A]),
            esz=rng.choice([None, 56, 2448]),
            link=link,
            nxt=nxt,
            prev=None if prev is None else -prev,
        )
        offset += size
    want = reference_walk(index)
    assert len(want) == 3000
    kept = [r for r in want if r[3] in z3._KEEP or r[0] in (want[5][0], want[777][0])]
    for chunk in (1 << 22, 5000, 333):
        monkeypatch.setattr(z3, "_CHUNK", chunk)
        ix = z3._walk_index(index + b"\0" * 9, 0, len(index), np.array([want[5][0], want[777][0]], dtype=np.int64))
        assert (ix.records, ix.consumed, ix.unknown_codes) == (3000, len(index), 0)
        assert ix.data_end == want[-1][1] + want[-1][2]
        assert list(zip(ix.ids.tolist(), ix.off.tolist(), ix.sz.tolist(), ix.cls.tolist())) == kept
        assert ix.lookup(want[777][0]) >= 0 and ix.lookup(want[-1][0] + 1) == -1


def test_index_walk_stops_at_what_is_not_a_record():
    good = index_entry(912, None, 396, 2, 0x32) + index_entry(1704, 1, 10, 3, 0x3F)
    ix = z3._walk_index(good + b"\x02" + good, 0, 2 * len(good) + 1, np.zeros(0, dtype=np.int64))
    assert (ix.records, ix.consumed) == (2, len(good))
    cut = good[:-1]  # the last record runs past the end of the index
    assert z3._walk_index(cut, 0, len(cut), np.zeros(0, dtype=np.int64)).records == 1


def test_a_large_index_is_walked_fast():
    entry = index_entry(None, 3, 40, 314, 0x09, nxt=70000, prev=-8)
    n = 400_000  # 5.6 MB of index: more than one chunk
    index = index_entry(912, None, 396, 2, 0x32) + entry * n
    started = time.perf_counter()
    ix = z3._walk_index(index, 0, len(index), np.zeros(0, dtype=np.int64))
    assert (ix.records, ix.consumed, ix.data_end) == (n + 1, len(index), 912 + 396 + 40 * n)
    assert time.perf_counter() - started < 10  # a Python loop per record would not make this on a busy machine


# ------------------------------------------------------------------------------------------------ damage


def flip(data: bytes, at: int) -> bytes:
    return data[:at] + bytes([data[at] ^ 0x55]) + data[at + 1 :]


def sections(data: bytes) -> tuple[int, int, int]:
    a, b = struct.unpack_from("<QQ", data, 0x310)
    (c,) = struct.unpack_from("<I", data, 0x330)
    return a, b, c


DAMAGE = {
    "index byte": (lambda d: flip(d, sections(d)[0] + 9), "md5_index"),
    "table byte": (lambda d: flip(d, 0x390 + 40), "md5_table"),
    "second table": (lambda d: flip(d, 0x390 + sections(d)[2] + 40), "table_copy"),
    "second header": (lambda d: flip(d, 0x348 + 20), "header_copy"),
    "tail cut": (lambda d: d[:-100], "layout"),
    "half": (lambda d: d[: len(d) // 2], "layout"),
    "trailer": (lambda d: flip(d, len(d) - 10), "trailer"),
    "junk appended": (lambda d: d + b"junk", "end"),
    "header text": (lambda d: d[:128] + b"?" * 127 + b"\n" + d[256:], "header"),
}


@pytest.mark.parametrize("what", DAMAGE)
def test_damaged_file_is_refused_in_thai(tmp_path, what):
    change, key = DAMAGE[what]
    path = write(tmp_path, change(model().build()))
    with pytest.raises(z3.Z3Error) as err:
        z3.read_z3(path)
    assert err.value.status == "damaged" and "เสียหาย" in str(err.value) and path.name in str(err.value)
    assert key in [c.key for c in err.value.checks if not c.ok]
    f = z3.read_z3(path, strict=False)  # the same without an exception: nothing half-read comes back
    assert not f.ok and f.status == "damaged" and f.objects == [] and f.preview_png is None and f.layers == []
    assert f.message == str(err.value)


def test_damage_in_the_data_area_is_not_noticed(tmp_path):
    # the MD5s cover the table and the index only: a changed geometry byte passes. Documented, not wished for.
    b = model()
    b.record(8, b"\x11" * 40, 0x3F)  # stands for geometry: the last record, just before the index
    data = b.build()
    assert z3.read_z3(write(tmp_path, flip(data, sections(data)[0] - 10))).ok


def test_damaged_hqr_part_fails_the_whole_file(tmp_path):
    back = Z3Builder()
    back.backup_entry("HQR_MAP_1234_10_10_10")
    good = model().build(hqr=back.build())
    f = z3.read_z3(write(tmp_path, flip(good, len(good) - 80)), strict=False)
    assert f.status == "damaged" and [c.key for c in f.failed_checks] == ["hqr.md5_index"] and "HQR" in f.message
    cut = z3.read_z3(write(tmp_path, good[:-30], "ตัด.Z3"), strict=False)
    assert cut.status == "damaged" and "hqr.layout" in [c.key for c in cut.failed_checks]
    text = good[:0x180] + good[0x180:0x200].replace(b"HQR=", b"HQR=9") + good[0x200:]
    far = z3.read_z3(write(tmp_path, text, "ไกล.Z3"), strict=False)
    assert far.status == "damaged" and [c.key for c in far.failed_checks] == ["hqr_offset"]


NOT_Z3 = [b"", b"Z3", b"Z3" + b"*" * 200, b"PK\x03\x04" + b"\0" * 5000, b"ISO-10303-21;\n" * 400]


@pytest.mark.parametrize("data", NOT_Z3)
def test_not_a_z3_file(tmp_path, data):
    path = write(tmp_path, data, "ไม่ใช่.Z3")
    with pytest.raises(z3.Z3Error) as err:
        z3.read_z3(path)
    assert err.value.status == "not_z3" and "ไม่ใช่ไฟล์ ZW3D" in str(err.value)
    assert z3.read_z3(path, strict=False).status == "not_z3"


def test_missing_file_is_an_error_in_thai(tmp_path):
    with pytest.raises(z3.Z3Error) as err:
        z3.read_z3(tmp_path / "ไม่มี.Z3")
    assert "เปิดไฟล์" in str(err.value)


def test_records_that_do_not_tile_are_refused_even_with_right_md5s(tmp_path):
    b = model()
    b.wrong_offset_at = 6
    f = z3.read_z3(write(tmp_path, b.build()), strict=False)
    assert f.status == "damaged" and [c.key for c in f.failed_checks] == ["tiling"] and f.objects == []


def test_component_of_an_unknown_owner_makes_the_file_unsupported(tmp_path):
    b = Z3Builder()
    b.obj3d("ชุดบน")
    b.obj3d("ฝา")
    b.component(123456, "ฝา")
    with pytest.raises(z3.Z3Error) as err:
        z3.read_z3(write(tmp_path, b.build()))
    assert err.value.status == "unsupported" and "ยังไม่รองรับ" in str(err.value)
    assert [c.key for c in err.value.checks if not c.ok] == ["components"]


def test_component_that_cannot_be_decoded_makes_the_file_unsupported(tmp_path):
    b = Z3Builder()
    top = b.obj3d("ชุดบน")
    b.component(top, "ฝา")
    rid = max(b.records)
    b.records[rid] = (z3.CLS_COMPONENT, 0x0A, b.records[rid][2][:9])  # cut short
    f = z3.read_z3(write(tmp_path, b.build()), strict=False)
    assert f.status == "unsupported" and [c.key for c in f.failed_checks] == ["components"] and f.objects == []


def test_object_whose_root_record_or_name_is_wrong_makes_the_file_unsupported(tmp_path):
    b = Z3Builder()
    b.obj3d("ชุดบน")
    b.roots.append(("ผี".encode(CP).ljust(32, b"\0"), 999999))  # listed, but no such record
    f = z3.read_z3(write(tmp_path, b.build()), strict=False)
    assert f.status == "unsupported" and [c.key for c in f.failed_checks] == ["objects"]
    b = Z3Builder()
    b.obj3d("ชุดบน")
    b.roots[0] = ("ชื่ออื่น".encode(CP).ljust(32, b"\0"), b.roots[0][1])  # table and root record disagree
    f = z3.read_z3(write(tmp_path, b.build(), "ชื่อ.Z3"), strict=False)
    assert f.status == "unsupported" and [c.key for c in f.failed_checks] == ["objects"]
    b = Z3Builder()
    b.obj3d(LONG)
    sid = min(r for r, (cls, _k, _d) in b.records.items() if cls == z3.CLS_STRING)
    b.records[sid] = (z3.CLS_STRING, 0x3F, b.records[sid][2][:-3] + b"\0")  # the long name lost its end
    f = z3.read_z3(write(tmp_path, b.build(), "ยาว.Z3"), strict=False)
    assert f.status == "unsupported" and [c.key for c in f.failed_checks] == ["objects"]


# ------------------------------------------------------------------------------------------------ BOM


def flat(b: z3.Bom) -> list[tuple[str, int, str]]:
    return [(line.name, line.qty, line.file) for line in b.flat]


def test_top_assembly_and_counts_multiplied_through(main_file):
    f = z3.read_z3(main_file)
    assert z3.find_top(f).name == "งานประกอบ ทดสอบ"
    assert [o.name for o in z3.top_candidates(f)] == ["งานประกอบ ทดสอบ", "ชิ้นส่วนสำรอง", N31, N32]
    b = z3.bom(f, resolve=False)
    assert b.root.name == "งานประกอบ ทดสอบ" and b.root.kind == "assembly" and b.depth == 2
    assert flat(b) == [
        ("น็อต M16", 4 + 2 * 3, ""),
        ("แผ่นพื้น", 1, ""),
        (LONG, 1 + 2 * 1, ""),
        ("โคมไฟท้าย", 1, "ชุดไฟ.Z3"),
        ("สลัก", 2, "สลัก.Z3PRT"),
    ]
    assert b.total_parts == 17 and [(a.name, a.qty) for a in b.assemblies] == [("ชุดเสา", 2)]
    assert [o.name for o in b.unused] == ["ชิ้นส่วนสำรอง", N31, N32]
    post = next(c for c in b.root.children if c.name == "ชุดเสา")
    assert (post.qty, post.total) == (2, 2)
    assert [(c.name, c.qty, c.total) for c in post.children] == [("น็อต M16", 3, 6), (LONG, 1, 2)]
    assert all(c.kind == "external" for c in b.root.children if c.file)


def test_tree_text(main_file):
    lines = z3.tree_lines(z3.bom(z3.read_z3(main_file), resolve=False).root)
    assert lines[0] == "งานประกอบ ทดสอบ  [ชุดประกอบ]"
    assert "├─ 2 × ชุดเสา  [ชุดประกอบ]" in lines
    assert "│  ├─ 3 × น็อต M16  รวม 6" in lines
    assert "├─ 4 × น็อต M16" in lines
    assert lines[1] == "├─ 2 × สลัก  [ไฟล์: สลัก.Z3PRT]  (อยู่ในไฟล์อื่น ไม่ได้เปิดดู)"


def test_bom_from_a_named_root(main_file):
    f = z3.read_z3(main_file)
    b = z3.bom(f, root="ชุดเสา")
    assert flat(b) == [("น็อต M16", 3, ""), (LONG, 1, "")] and b.depth == 1
    assert "งานประกอบ ทดสอบ" in [o.name for o in b.unused]  # nothing uses it, and it is not the chosen root
    assert z3.bom(f, root="แผ่นพื้น").root.kind == "part"
    with pytest.raises(z3.Z3Error) as err:
        z3.bom(f, root="ไม่มีชื่อนี้")
    assert "ไม่พบวัตถุ" in str(err.value)


def test_references_to_other_files_are_followed_and_missing_ones_reported(main_file, tmp_path):
    f = z3.read_z3(main_file)
    b = z3.bom(f)
    assert b.missing_files == ["สลัก.Z3PRT", "ชุดไฟ.Z3"]
    assert {(n.name, n.kind, n.note) for n in b.root.children if n.file} == {
        ("สลัก", "missing_file", "ไม่พบไฟล์นี้ในโฟลเดอร์"),
        ("โคมไฟท้าย", "missing_file", "ไม่พบไฟล์นี้ในโฟลเดอร์"),
    }
    assert ("โคมไฟท้าย", 1, "ชุดไฟ.Z3") in flat(b)  # still counted: the workshop has to find that part

    (tmp_path / "สลัก.z3prt").write_bytes(pin_file())  # another case than the name in the assembly
    (tmp_path / "ชุดไฟ.Z3").write_bytes(lamp_file())
    b = z3.bom(f)
    assert b.missing_files == [] and b.depth == 2
    assert flat(b)[-3:] == [("ฝาครอบ", 1, "ชุดไฟ.Z3"), ("หลอดไฟ", 2, "ชุดไฟ.Z3"), ("สลัก", 2, "สลัก.z3prt")]
    assert ("โคมไฟท้าย", 1, "ชุดไฟ.Z3") in [(a.name, a.qty, a.file) for a in b.assemblies]
    lamp = next(c for c in b.root.children if c.name == "โคมไฟท้าย")
    assert lamp.kind == "assembly" and [(c.name, c.total) for c in lamp.children] == [("ฝาครอบ", 1), ("หลอดไฟ", 2)]


def test_referenced_file_is_also_found_one_folder_up(tmp_path):
    (tmp_path / "งาน").mkdir()
    (tmp_path / "สลัก.Z3PRT").write_bytes(pin_file())  # shared part kept above the folder of this body
    (tmp_path / "งาน" / "ชุดไฟ.Z3").write_bytes(lamp_file())
    f = z3.read_z3(write(tmp_path / "งาน", model().build()))
    b = z3.bom(f)
    assert b.missing_files == [] and ("สลัก", 2, "สลัก.Z3PRT") in flat(b) and ("หลอดไฟ", 2, "ชุดไฟ.Z3") in flat(b)


def test_referenced_file_that_is_damaged_or_lacks_the_object(main_file, tmp_path):
    (tmp_path / "สลัก.Z3PRT").write_bytes(pin_file()[:-40])
    other = Z3Builder()
    other.obj3d("โคมไฟหน้า")
    (tmp_path / "ชุดไฟ.Z3").write_bytes(other.build())
    b = z3.bom(z3.read_z3(main_file))
    kinds = {n.name: (n.kind, n.note) for n in b.root.children if n.file}
    assert kinds["สลัก"] == ("bad_file", "ไฟล์เสียหายหรือยังไม่รองรับ")
    assert kinds["โคมไฟท้าย"] == ("missing_object", "ไม่พบวัตถุชื่อนี้ในไฟล์ที่อ้างถึง")
    assert len(b.warnings) == 1 and "สลัก.Z3PRT" in b.warnings[0] and b.missing_files == []


def test_component_naming_its_own_file_and_a_missing_local_object(tmp_path):
    b = Z3Builder()
    top = b.obj3d("ชุดบน")
    b.obj3d("ฝา")
    b.component(top, "ฝา", file="ชุดบน.Z3", n=2)  # ZW3D sometimes writes the file's own name
    b.component(top, "ฝาที่ลบแล้ว")
    f = z3.read_z3(write(tmp_path, b.build(), "ชุดบน.Z3"))
    out = z3.bom(f)
    children = [(n.name, n.kind, n.total) for n in out.root.children]
    assert children == [("ฝา", "part", 2), ("ฝาที่ลบแล้ว", "missing_object", 1)]
    assert out.missing_files == [] and out.unused == []


def test_assemblies_that_use_each_other_do_not_loop(tmp_path):
    b = Z3Builder()
    first = b.obj3d("ก")
    second = b.obj3d("ข")
    b.component(first, "ข")
    b.component(second, "ก")
    f = z3.read_z3(write(tmp_path, b.build()))
    out = z3.bom(f)
    assert out.root.name == "ก" and out.root.children[0].children[0].kind == "cycle"
    assert out.warnings and "วนกลับ" in out.warnings[0]


def test_bom_refuses_a_file_that_was_not_read(tmp_path):
    f = z3.read_z3(write(tmp_path, model().build()[:-5]), strict=False)
    with pytest.raises(z3.Z3Error):
        z3.bom(f)


# ------------------------------------------------------------------------------------------------ command line


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("z3_list", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tool_lists_one_file(tool, main_file, tmp_path, capsys):
    out_dir = tmp_path / "out"
    code = tool.main(
        [str(main_file), "--tree", "--objects", "--bom", str(out_dir / "bom.csv"), "--previews", str(out_dir / "pic")]
        + ["--json", str(out_dir / "all.json"), "--out", str(out_dir / "z3"), "--no-resolve"]
    )
    text = capsys.readouterr().out
    assert code == 0
    assert "ผู้บันทึก: TESTER" in text and "ผลการตรวจไฟล์: ผ่านทั้ง" in text
    assert "วัตถุ: 9  (ชิ้นส่วน 6, ชุดประกอบ 2, แบบ 2 มิติ 1)" in text
    assert "ชุดประกอบบนสุด: งานประกอบ ทดสอบ   ลึก 2 ชั้น   ชิ้นส่วน 5 รายการ รวม 17 ชิ้น" in text
    assert "├─ 2 × ชุดเสา  [ชุดประกอบ]" in text and "วัตถุ 3 มิติที่ไม่มีชุดประกอบใดใช้: 3" in text

    raw = (out_dir / "bom.csv").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")  # Excel needs the BOM to show Thai
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    assert rows[0] == ["ลำดับ", "ชื่อชิ้นส่วน", "จำนวนรวม", "อยู่ในไฟล์", "หมายเหตุ"]
    assert rows[1] == ["1", "น็อต M16", "10", "", ""] and len(rows) == 6
    assert rows[5][1:4] == ["สลัก", "2", "สลัก.Z3PRT"]

    assert (out_dir / "pic" / (main_file.name + ".png")).read_bytes().startswith(b"\x89PNG")
    data = json.loads((out_dir / "all.json").read_text(encoding="utf-8"))
    assert data["status"] == "ok" and data["header"]["author"] == "TESTER" and len(data["objects"]) == 9
    assert data["bom"]["top"] == "งานประกอบ ทดสอบ" and data["bom"]["parts"][0] == {
        "name": "น็อต M16",
        "qty": 10,
        "file": "",
        "note": "",
    }
    folder = out_dir / "z3" / main_file.name
    assert sorted(p.name for p in folder.iterdir()) == ["bom.csv", "objects.csv", "preview.png", "tree.txt"]
    objects = list(csv.reader(io.StringIO((folder / "objects.csv").read_text(encoding="utf-8-sig"))))
    assert objects[0][:3] == ["รหัสวัตถุ", "ชนิด", "ชื่อ"]
    assert objects[1] == ["54", "ชุดประกอบ", "งานประกอบ ทดสอบ", "6", "11", "ชุดประกอบบนสุด"]
    assert [r[5] for r in objects[1:]].count("ไม่มีชุดประกอบใดใช้") == 3
    tree = (folder / "tree.txt").read_text(encoding="utf-8")
    assert "ชุดประกอบบนสุด: งานประกอบ ทดสอบ" in tree and "วัตถุ 3 มิติที่ไม่มีชุดประกอบใดในไฟล์นี้ใช้ (3):" in tree


def test_tool_lists_a_folder_and_reports_the_damaged_file(tool, main_file, tmp_path, capsys):
    (tmp_path / "ชุดไฟ.Z3").write_bytes(lamp_file())
    (tmp_path / "เสีย.Z3ASM").write_bytes(pin_file()[:-7])
    (tmp_path / "อ่านฉัน.txt").write_text("ไม่เกี่ยว", encoding="utf-8")
    code = tool.main([str(tmp_path), "--bom", str(tmp_path / "รวม.csv"), "--json", str(tmp_path / "รวม.json")])
    text = capsys.readouterr().out
    assert code == 1
    assert "สรุป: 3 ไฟล์  อ่านได้และผ่านการตรวจ 2  ไม่ผ่าน 1" in text
    assert "อ่านไม่ได้: ไฟล์ “เสีย.Z3ASM” เสียหายหรือบันทึกไม่ครบ" in text and "✗ ขนาดไฟล์ตรงกับที่ส่วนหัวระบุ" in text
    assert "ไฟล์ที่อ้างถึงแต่ไม่พบในโฟลเดอร์ (1): สลัก.Z3PRT" in text
    rows = list(csv.reader(io.StringIO((tmp_path / "รวม.csv").read_text(encoding="utf-8-sig"))))
    assert rows[0][0] == "ไฟล์แบบ" and {r[0] for r in rows[1:]} == {"งานประกอบ ทดสอบ.Z3", "ชุดไฟ.Z3"}
    assert ["งานประกอบ ทดสอบ.Z3", "5", "หลอดไฟ", "2", "ชุดไฟ.Z3", ""] in rows
    data = json.loads((tmp_path / "รวม.json").read_text(encoding="utf-8"))
    assert [d["status"] for d in data] == ["ok", "ok", "damaged"]


def test_tool_with_nothing_to_read(tool, tmp_path, capsys):
    assert tool.main([str(tmp_path / "ไม่มี.Z3")]) == 1
    assert tool.main([str(tmp_path)]) == 1
    assert "ไม่พบ" in capsys.readouterr().err
