"""ดูว่าในไฟล์ ZW3D (.Z3 / .Z3PRT / .Z3ASM) มีอะไร โดยไม่ต้องเปิด ZW3D: วัตถุ ชุดประกอบ รายการชิ้นส่วน (BOM) ภาพตัวอย่าง.

    python tools/z3_list.py <ไฟล์หรือโฟลเดอร์> [--tree] [--objects] [--bom out.csv] [--previews dir] [--json out.json]
                            [--out dir] [--root "ชื่อชุดประกอบ"] [--no-resolve]

--tree      print the assembly tree under the top assembly, counts multiplied through
--objects   print every object of the file (root id, kind, name)
--bom       flat parts list as CSV (UTF-8 with BOM: opens in Excel); for a folder one CSV with a file column
--previews  write each file's 150 x 150 preview picture as <file name>.png into this folder
--json      everything as JSON
--out       one folder per file with objects.csv, bom.csv, tree.txt, preview.png
--root      start the tree / BOM at this object instead of the top assembly that is found automatically
--no-resolve  do not open the other files an assembly refers to

The top assembly is the 3D object that no assembly of the file uses and that has the most parts under it. Files an
assembly refers to are looked for in the folder of the file that names them, then one folder up; the ones not
found are listed.
Read-only. Exit code 0 = every file was read and passed its checks, 1 = at least one was not.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from partlist_studio.core import z3_reader as z3  # noqa: E402

BOM_HEAD = ["ลำดับ", "ชื่อชิ้นส่วน", "จำนวนรวม", "อยู่ในไฟล์", "หมายเหตุ"]


def _files(target: Path) -> list[Path]:
    if target.is_dir():
        return sorted(p for p in target.rglob("*") if p.is_file() and z3.is_z3(p))
    return [target]


def _write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:  # the BOM makes Excel read Thai correctly
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def _bom_rows(b: z3.Bom) -> list[list]:
    return [[i + 1, line.name, line.qty, line.file, line.note] for i, line in enumerate(b.flat)]


def _object_rows(f: z3.Z3File, b: z3.Bom | None) -> list[list]:
    unused = {o.root_id for o in b.unused} if b else set()
    top = b.root.name if b and b.root else None
    rows = []
    for o in f.objects:
        role = "ไม่มีชุดประกอบใดใช้" if o.root_id in unused else ""
        if o.name == top and o.kind != "drawing":
            role = "ชุดประกอบบนสุด"
        rows.append([o.root_id, o.kind_th, o.name, len(o.components), sum(u.count for u in o.components), role])
    return rows


def _tree_text(f: z3.Z3File, b: z3.Bom | None) -> str:
    lines = [f"ไฟล์: {f.path.name}"]
    if not f.ok:
        return "\n".join(lines + [f.message]) + "\n"
    if b is None or b.root is None:
        return "\n".join(lines + ["ไฟล์นี้ไม่มีวัตถุ 3 มิติ"]) + "\n"
    lines += [f"ชุดประกอบบนสุด: {b.root.name}", f"ความลึก: {b.depth} ชั้น", ""]
    lines += z3.tree_lines(b.root)
    if b.missing_files:
        lines += ["", "ไฟล์ที่อ้างถึงแต่ไม่พบในโฟลเดอร์:"] + [f"  - {name}" for name in b.missing_files]
    if b.unused:
        lines += ["", f"วัตถุ 3 มิติที่ไม่มีชุดประกอบใดในไฟล์นี้ใช้ ({len(b.unused)}):"]
        lines += [f"  - {o.name}  [{o.kind_th}]" for o in b.unused]
    return "\n".join(lines) + "\n"


def _describe(f: z3.Z3File, b: z3.Bom | None, args) -> None:
    print(f"ไฟล์: {f.path.name}  ({f.size / 1e6:.1f} MB)")
    if f.status == "not_z3":
        print(f"  ไม่อ่าน: {f.message}")
        return
    h = f.header
    saved = h.saved.strftime("%Y-%m-%d %H:%M:%S") if h.saved else h.saved_text
    print(f"  ผู้บันทึก: {h.author}   บันทึกเมื่อ: {saved}   ZW3D: {h.zw3d_build} (รูปแบบ {h.format_version})")
    bad = f.failed_checks
    if bad:
        print(f"  ผลการตรวจไฟล์: ไม่ผ่าน {len(bad)} จาก {len(f.checks)} ข้อ")
        for c in bad:
            print(f"    ✗ {c.label}" + (f" – {c.detail}" if c.detail else ""))
    else:
        print(f"  ผลการตรวจไฟล์: ผ่านทั้ง {len(f.checks)} ข้อ")
    if not f.ok:
        print(f"  อ่านไม่ได้: {f.message}")
        return
    print(
        f"  วัตถุ: {len(f.objects)}  (ชิ้นส่วน {f.count('part')}, ชุดประกอบ {f.count('assembly')}, "
        f"แบบ 2 มิติ {f.count('drawing')})   ระเบียนทั้งหมด {f.records:,}"
    )
    extras = []
    if f.preview_png:
        extras.append("มีภาพตัวอย่าง")
    if f.layers:
        extras.append("เลเยอร์: " + ", ".join(name for name, _n in f.layers[:8]) + (" …" if len(f.layers) > 8 else ""))
    if f.embedded:
        extras.append(f"มีส่วนสำรองของ ZW3D ต่อท้าย ({f.embedded.entries} รายการ)")
    if extras:
        print("  " + "   ".join(extras))
    for w in f.warnings:
        print(f"  หมายเหตุ: {w}")
    if b is None or b.root is None:
        print("  ไม่มีวัตถุ 3 มิติในไฟล์นี้")
        return
    kind = "ชุดประกอบบนสุด" if b.root.kind == "assembly" else "ชิ้นส่วนเดี่ยว"
    print(f"  {kind}: {b.root.name}   ลึก {b.depth} ชั้น   ชิ้นส่วน {len(b.flat)} รายการ รวม {b.total_parts} ชิ้น")
    if b.missing_files:
        print(f"  ไฟล์ที่อ้างถึงแต่ไม่พบในโฟลเดอร์ ({len(b.missing_files)}): " + ", ".join(b.missing_files))
    if b.unused:
        print(f"  วัตถุ 3 มิติที่ไม่มีชุดประกอบใดใช้: {len(b.unused)}")
    for w in dict.fromkeys(b.warnings):
        print(f"  หมายเหตุ: {w}")
    if args.objects:
        print("  รายการวัตถุ:")
        print(f"    {'รหัส':>9}  {'ชนิด':<10}  ชื่อ")
        for o in f.objects:
            print(f"    {o.root_id:>9}  {o.kind_th:<10}  {o.name}")
    if args.tree:
        print("  โครงสร้างชุดประกอบ:")
        for line in z3.tree_lines(b.root):
            print("    " + line)
        if b.unused:
            print("  วัตถุที่ไม่มีชุดประกอบใดใช้:")
            for o in b.unused:
                print(f"    - {o.name}  [{o.kind_th}]")


def _folder_name(path: Path, taken: set[str]) -> str:
    name = path.name
    n = 2
    while name.casefold() in taken:  # the same file name in two sub-folders
        name = f"{path.name} ({n})"
        n += 1
    taken.add(name.casefold())
    return name


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="แสดงรายการในไฟล์ ZW3D โดยไม่ต้องเปิดโปรแกรม ZW3D")
    ap.add_argument("target", help="ไฟล์ .Z3 / .Z3PRT / .Z3ASM หรือโฟลเดอร์")
    ap.add_argument("--tree", action="store_true", help="แสดงโครงสร้างชุดประกอบ")
    ap.add_argument("--objects", action="store_true", help="แสดงวัตถุทุกตัวในไฟล์")
    ap.add_argument("--bom", metavar="CSV", help="บันทึกรายการชิ้นส่วนรวม (เปิดด้วย Excel ได้)")
    ap.add_argument("--previews", metavar="DIR", help="บันทึกภาพตัวอย่างเป็น PNG")
    ap.add_argument("--json", metavar="JSON", help="บันทึกทุกอย่างเป็น JSON")
    ap.add_argument("--out", metavar="DIR", help="โฟลเดอร์ผลลัพธ์ แยกหนึ่งโฟลเดอร์ต่อไฟล์")
    ap.add_argument("--root", metavar="NAME", help="เริ่มจากวัตถุชื่อนี้แทนชุดประกอบบนสุด")
    ap.add_argument("--no-resolve", action="store_true", help="ไม่เปิดไฟล์อื่นที่ชุดประกอบอ้างถึง")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")  # a Windows console is not UTF-8 by default

    target = Path(args.target)
    if not target.exists():
        print(f"ไม่พบ “{target}”", file=sys.stderr)
        return 1
    files = _files(target)
    if not files:
        print(f"ไม่พบไฟล์ .Z3 / .Z3PRT / .Z3ASM ใน “{target}”", file=sys.stderr)
        return 1
    many = target.is_dir()
    library = z3.Z3Library()
    report, bom_rows, taken = [], [], set()
    failed = 0
    for path in files:
        started = time.time()
        f = library.read(path)
        b = None
        if f.ok:
            try:
                b = z3.bom(f, root=args.root, resolve=not args.no_resolve, library=library)
            except z3.Z3Error as exc:
                print(f"ไฟล์: {path.name}\n  {exc}", file=sys.stderr)
                failed += 1
                continue
        else:
            failed += 1
        _describe(f, b, args)
        print(f"  ใช้เวลา {time.time() - started:.1f} วินาที\n")
        entry = f.to_dict()
        if b is not None and b.root is not None:
            entry["bom"] = {
                "top": b.root.name,
                "depth": b.depth,
                "parts": [{"name": x.name, "qty": x.qty, "file": x.file, "note": x.note} for x in b.flat],
                "assemblies": [{"name": x.name, "qty": x.qty, "file": x.file} for x in b.assemblies],
                "unused": [{"root_id": o.root_id, "kind": o.kind, "name": o.name} for o in b.unused],
                "missing_files": b.missing_files,
                "tree": z3.tree_lines(b.root),
            }
            bom_rows += [([path.name] if many else []) + row for row in _bom_rows(b)]
        report.append(entry)
        if args.previews and f.preview_png:
            Path(args.previews).mkdir(parents=True, exist_ok=True)
            (Path(args.previews) / (path.name + ".png")).write_bytes(f.preview_png)
        if args.out:
            folder = Path(args.out) / _folder_name(path, taken)
            folder.mkdir(parents=True, exist_ok=True)
            head = ["รหัสวัตถุ", "ชนิด", "ชื่อ", "รายการชิ้นส่วนย่อย", "จำนวนชิ้นส่วนย่อย", "หมายเหตุ"]
            _write_csv(folder / "objects.csv", head, _object_rows(f, b))
            _write_csv(folder / "bom.csv", BOM_HEAD, _bom_rows(b) if b else [])
            (folder / "tree.txt").write_text(_tree_text(f, b), encoding="utf-8")
            if f.preview_png:
                (folder / "preview.png").write_bytes(f.preview_png)
    if args.bom:
        _write_csv(Path(args.bom), (["ไฟล์แบบ"] if many else []) + BOM_HEAD, bom_rows)
        print(f"บันทึกรายการชิ้นส่วน: {args.bom}")
    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        data = report if many else (report[0] if report else {})
        Path(args.json).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"บันทึก JSON: {args.json}")
    if many:
        print(f"สรุป: {len(files)} ไฟล์  อ่านได้และผ่านการตรวจ {len(files) - failed}  ไม่ผ่าน {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
