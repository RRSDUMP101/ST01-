"""tools/macho_min_os.py: the macOS a binary needs, read from its load commands."""

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import macho_min_os as m  # noqa: E402


def _macho(minos: tuple[int, int, int], cputype: int = 0x01000007, old_style: bool = False) -> bytes:
    v = (minos[0] << 16) | (minos[1] << 8) | minos[2]
    if old_style:
        cmd = struct.pack("<4I", m.LC_VERSION_MIN_MACOSX, 16, v, v)
    else:
        cmd = struct.pack("<6I", m.LC_BUILD_VERSION, 24, m.PLATFORM_MACOS, v, v, 0)
    other = struct.pack("<2I", 0x19, 8)  # some other load command first
    header = struct.pack("<8I", m.MH_MAGIC_64, cputype, 3, 6, 2, len(other) + len(cmd), 0, 0)
    return header + other + cmd + b"\0" * 64


def _fat(*slices: bytes) -> bytes:
    offset, arches, body = 4096, b"", b""
    for i, s in enumerate(slices):
        cpu = struct.unpack_from("<I", s, 4)[0]
        arches += struct.pack(">5I", cpu, 3, offset + len(body), len(s), 12)
        body += s
    head = struct.pack(">2I", m.FAT_MAGIC, len(slices)) + arches
    return head + b"\0" * (offset - len(head)) + body


def test_thin_and_fat_slices():
    assert m.min_os(_macho((14, 0, 0))) == [("x86_64", (14, 0, 0))]
    assert m.min_os(_macho((10, 13, 0), old_style=True)) == [("x86_64", (10, 13, 0))]
    fat = _fat(_macho((11, 0, 0)), _macho((12, 3, 0), cputype=0x0100000C))
    assert m.min_os(fat) == [("x86_64", (11, 0, 0)), ("arm64", (12, 3, 0))]
    assert m.min_os(b"\xca\xfe\xba\xbe\x00\x00\x00\x34" + b"\0" * 40) == []  # Java class file
    assert m.min_os(b"#!/bin/sh\n" + b"\0" * 40) == []


def test_scan_bundle_and_exit_code(tmp_path, capsys):
    app = tmp_path / "Demo.app" / "Contents"
    (app / "MacOS").mkdir(parents=True)
    (app / "Frameworks").mkdir()
    (app / "MacOS" / "Demo").write_bytes(_macho((10, 13, 0)))
    (app / "Frameworks" / "QtCore").write_bytes(_fat(_macho((11, 0, 0)), _macho((11, 0, 0), cputype=0x0100000C)))
    (app / "Info.plist").write_text("<plist/>")
    assert m.main([str(tmp_path / "Demo.app"), "--max", "11.0"]) == 0
    (app / "Frameworks" / "QtGui").write_bytes(_macho((14, 0, 0)))
    assert m.main([str(tmp_path / "Demo.app"), "--max", "11.0"]) == 1
    out = capsys.readouterr().out
    assert "needs macOS 14.0.0" in out and "QtGui" in out
