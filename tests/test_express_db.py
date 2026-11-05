"""อ่านข้อมูล Express (อ่านอย่างเดียว): a Visual FoxPro table made here (Express's own files never enter the repo)."""

import re
import struct
from datetime import date
from pathlib import Path

from partlist_studio.core import express_db as xdb


def make_dbf(path: Path, fields, rows, backlink=263, deleted=(), eof=False):
    """A small VFP table: fields [(name, type, length, decimals)], rows of raw values."""
    rec_len = 1 + sum(f[2] for f in fields)
    header_len = 32 + 32 * len(fields) + 1 + backlink
    head = bytearray(32)
    head[0] = 0x30
    head[1:4] = bytes([126, 11, 5])  # 2026-11-05
    head[4:12] = struct.pack("<IHH", len(rows), header_len, rec_len)
    desc = bytearray()
    off = 1
    for name, ftype, length, dec in fields:
        d = bytearray(32)
        d[:len(name)] = name.encode("ascii")
        d[11] = ord(ftype)
        d[12:16] = struct.pack("<I", off)
        d[16], d[17] = length, dec
        desc += d
        off += length
    data = bytes(head) + bytes(desc) + b"\r" + b"\0" * backlink
    for i, row in enumerate(rows):
        rec = bytearray(b"*" if i in deleted else b" ")
        for (name, ftype, length, dec), v in zip(fields, row):
            if ftype == "C":
                rec += v.encode("cp874").ljust(length, b" ")
            elif ftype == "N":
                rec += (f"{v:.{dec}f}" if v is not None else "").rjust(length).encode()
            elif ftype == "D":
                rec += (v.strftime("%Y%m%d") if v else "").ljust(8).encode()
            elif ftype == "B":
                rec += struct.pack("<d", v)
            elif ftype == "I":
                rec += struct.pack("<i", v)
            elif ftype == "L":
                rec += b"T" if v else b"F"
        data += bytes(rec)
    path.write_bytes(data + (b"\x1a" if eof else b""))


FIELDS = [("DOCNUM", "C", 12, 0), ("DOCDAT", "D", 8, 0), ("REMARK", "C", 40, 0), ("QTY", "N", 10, 2),
          ("AMT", "B", 8, 2), ("SEQ", "I", 4, 0), ("POSTED", "L", 1, 0)]


def test_reads_a_visual_foxpro_table(tmp_path):
    p = tmp_path / "STDOC.DBF"
    make_dbf(p, FIELDS, [["PD0000526", date(2026, 11, 4), "เครื่องตัด/T.Revo\xa03ราว", 8, 16616.0, 1, True],
                         ["PD0000527", date(2026, 11, 5), "ลบแล้ว", 1, 0.0, 2, False],
                         ["JU0000003", None, "", None, -0.5, 3, False]], deleted={1})
    t = xdb.DbfTable.open(p)
    assert t.count == 3 and t.header_len == 32 + 32 * 7 + 1 + 263 and t.updated == date(2026, 11, 5)
    assert t.names == ["DOCNUM", "DOCDAT", "REMARK", "QTY", "AMT", "SEQ", "POSTED"]
    recs = list(t.records(with_recno=True))
    assert [r["DOCNUM"] for r in recs] == ["PD0000526", "JU0000003"]  # the deleted record skipped
    first = recs[0]
    assert first["DOCDAT"] == date(2026, 11, 4) and first["QTY"] == 8 and first["AMT"] == 16616.0
    assert first["SEQ"] == 1 and first["POSTED"] is True and first["_recno"] == 0
    assert xdb.clean(first["REMARK"]) == "เครื่องตัด/T.Revo 3ราว"
    assert recs[1]["DOCDAT"] is None and recs[1]["QTY"] is None
    assert [r["DOCNUM"] for r in t.tail(1)] == ["JU0000003"]


def test_company_folders_probe_and_find(tmp_path):
    root = tmp_path / "ExpressA"
    for folder, name in (("ffff", "บริษัทตัวอย่างกระบะ จำกัด"), ("RRSDP69", "บริษัทตัวอย่างกระบะ จำกัด")):
        (root / folder).mkdir(parents=True)
        make_dbf(root / folder / "isinfo.dbf", [("THINAM", "C", 60, 0)], [[name]], eof=True)
    (root / "notes").mkdir()
    make_dbf(root / "ffff" / "STDOC.DBF", FIELDS, [["PD0000526", date(2026, 11, 4), "x", 1, 1.0, 1, True]])
    found = xdb.companies(root)
    assert [(c.folder.name, c.year) for c in found] == [("ffff", ""), ("RRSDP69", "69")]
    assert found[0].name.startswith("บริษัทตัวอย่าง") and xdb.folder_ok(root / "ffff")
    rows = xdb.probe(root / "ffff")
    assert ["STDOC.DBF", 1, "2026-11-05", "DOCNUM", "C", 12, 0] in rows and any(r[0] == "ISINFO.DBF" for r in rows)
    assert xdb.find_value(root / "ffff", " pd0000526 ") == [("STDOC.DBF", "DOCNUM", 0)]
    assert xdb.table(root / "ffff", "stdoc").count == 1 and xdb.table(root / "ffff", "nothing") is None
    (root / "ffff" / "BAD.DBF").write_bytes(b"xx")
    assert any(r[0] == "BAD.DBF" and "อ่านไม่ได้" in r[3] for r in xdb.probe(root / "ffff"))


def test_never_writes_express_files():
    source = Path(xdb.__file__).read_text(encoding="utf-8")
    opens = re.findall(r"with open\(([^)]*)\)", source)  # every file the module opens
    assert opens and all(o.rstrip().endswith('"rb"') for o in opens)
    assert not re.search(r"write_bytes|write_text|\.write\(|\"wb\"|\"r\+b\"|\"ab\"|os\.remove|unlink|rename", source)
