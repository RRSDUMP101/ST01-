"""Lowest macOS every binary of a .app needs (LC_BUILD_VERSION / LC_VERSION_MIN_MACOSX).

    python tools/macho_min_os.py "dist/RRS Part List Studio.app" --max 11.0

Exits with 1 when a Mach-O file (Qt framework, Python extension, dwg2dxf …) needs a newer macOS than
--max, so a build that would not open on older Macs fails in CI instead of on the user's Mac.
--allow PART=VERSION lets the files whose path contains PART need up to VERSION: a part of the program that is
loaded only when it is used (the STEP / IGES reader) may need a newer macOS than the program itself.
Runs anywhere (no Xcode tools needed).
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

MH_MAGIC = 0xFEEDFACE
MH_MAGIC_64 = 0xFEEDFACF
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
LC_VERSION_MIN_MACOSX = 0x24
LC_BUILD_VERSION = 0x32
PLATFORM_MACOS = 1
CPU_NAMES = {7: "i386", 0x01000007: "x86_64", 12: "arm", 0x0100000C: "arm64"}


def _version(v: int) -> tuple[int, int, int]:
    return v >> 16, (v >> 8) & 0xFF, v & 0xFF


def _thin(data: bytes, base: int = 0) -> tuple[str, tuple[int, int, int] | None]:
    magic_le = struct.unpack_from("<I", data, base)[0]
    if magic_le in (MH_MAGIC, MH_MAGIC_64):
        e = "<"
    elif struct.unpack_from(">I", data, base)[0] in (MH_MAGIC, MH_MAGIC_64):
        e = ">"
    else:
        raise ValueError("not a Mach-O slice")
    magic, cputype, _sub, _ftype, ncmds, _size = struct.unpack_from(e + "6I", data, base)
    offset = base + (32 if magic == MH_MAGIC_64 else 28)
    found = None
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from(e + "2I", data, offset)
        if cmd == LC_BUILD_VERSION:
            platform, minos = struct.unpack_from(e + "2I", data, offset + 8)
            if platform == PLATFORM_MACOS:
                found = _version(minos)
        elif cmd == LC_VERSION_MIN_MACOSX:
            found = _version(struct.unpack_from(e + "I", data, offset + 8)[0])
        if cmdsize <= 0:
            break
        offset += cmdsize
    return CPU_NAMES.get(cputype, hex(cputype)), found


def min_os(data: bytes) -> list[tuple[str, tuple[int, int, int] | None]]:
    """[(arch, (major, minor, patch) or None)] for every slice; [] when the data is not Mach-O."""
    if len(data) < 32:
        return []
    magic_be = struct.unpack_from(">I", data, 0)[0]
    if magic_be in (FAT_MAGIC, FAT_MAGIC_64):
        nfat = struct.unpack_from(">I", data, 4)[0]
        if not 0 < nfat < 20:  # Java class files start with CAFEBABE too
            return []
        out = []
        for i in range(nfat):
            if magic_be == FAT_MAGIC:
                _cpu, _sub, offset, _size, _align = struct.unpack_from(">5I", data, 8 + i * 20)
            else:
                _cpu, _sub, offset, _size, _align, _r = struct.unpack_from(">2I2Q2I", data, 8 + i * 32)
            try:
                out.append(_thin(data, offset))
            except (ValueError, struct.error):
                continue
        return out
    try:
        return [_thin(data)]
    except (ValueError, struct.error):
        return []


def scan(root: str | Path) -> list[tuple[Path, str, tuple[int, int, int] | None]]:
    out = []
    root = Path(root)
    files = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink())
    for path in files:
        with open(path, "rb") as fh:
            head = fh.read(4)
            if len(head) < 4:
                continue
            be, le = struct.unpack(">I", head)[0], struct.unpack("<I", head)[0]
            if be not in (FAT_MAGIC, FAT_MAGIC_64, MH_MAGIC, MH_MAGIC_64) and le not in (MH_MAGIC, MH_MAGIC_64):
                continue
            data = head + fh.read()
        for arch, version in min_os(data):
            out.append((path, arch, version))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("path")
    ap.add_argument("--max", default="11.0", help="highest macOS the binaries may require (default 11.0)")
    ap.add_argument("--allow", action="append", default=[], metavar="PART=VERSION",
                    help="files whose path contains PART may require up to VERSION (may be given more than once)")
    args = ap.parse_args(argv)

    def version(text: str) -> tuple[int, ...]:
        return tuple(int(x) for x in (text.split(".") + ["0", "0"])[:3])

    limit = version(args.max)
    allowed = [(part, version(v)) for part, _eq, v in (a.partition("=") for a in args.allow)]
    found = scan(args.path)
    if not found:
        print("no Mach-O files found")
        return 1

    def limit_of(path: Path) -> tuple[int, ...]:
        return max([limit] + [v for part, v in allowed if part in path.as_posix()])

    too_new = [(p, a, v) for p, a, v in found if v and v > limit_of(p)]
    excused = [(p, v) for p, _a, v in found if v and limit < v <= limit_of(p)]
    newest = max((v for _p, _a, v in found if v), default=None)
    print(f"{len(found)} Mach-O slices · newest required macOS: {'.'.join(map(str, newest)) if newest else '?'}")
    for p, a, v in sorted(too_new, key=lambda t: t[2], reverse=True)[:40]:
        print(f"  needs macOS {'.'.join(map(str, v))} ({a}): {p}")
    if too_new:
        print(f"FAIL: {len(too_new)} slices need a macOS newer than {args.max}")
        return 1
    if excused:
        newest = max(v for _p, v in excused)
        print(f"allowed: {len(excused)} slices need up to macOS {'.'.join(map(str, newest))} "
              f"({', '.join(part for part, _v in allowed)})")
    print(f"OK: everything {'else ' if excused else ''}runs on macOS {args.max} or newer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
