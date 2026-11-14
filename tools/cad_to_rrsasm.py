"""IGES / STEP จาก CAD → ไฟล์คู่มือประกอบ 3 มิติ (.rrsasm) โดยไม่ต้องเปิดโปรแกรม – สำหรับไฟล์ใหญ่ที่ใช้เวลาอ่านนาน.

    python tools/cad_to_rrsasm.py <in.igs|in.step> <out.rrsasm> [--max-faces 60000]

แล้วเปิดไฟล์ .rrsasm ในแท็บ ประกอบ 3D → เปิด… · ต้องติดตั้ง OpenCascade ก่อน: pip install -r requirements-cad.txt

Progress goes to standard error, the summary (parts, groups, triangles, bounding box, unit, how the parts were
found, time, peak memory) to standard output. Exit code 0 = written, 1 = the file could not be imported.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from partlist_studio.core import cad_import  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="IGES / STEP → .rrsasm (คู่มือประกอบ 3 มิติ ของ RRS Part List Studio)")
    parser.add_argument("source", help="ไฟล์ CAD: .igs .iges .step .stp")
    parser.add_argument("target", help="ไฟล์ผลลัพธ์ .rrsasm")
    parser.add_argument("--max-faces", type=int, default=60000,
                        help="จำนวนสามเหลี่ยมมากสุดของทั้งโมเดล (ค่าเริ่มต้น 60000 – ภาพ 3 มิติของโปรแกรมวาดด้วยซอฟต์แวร์)")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # Thai on a Windows console of another code page
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    start = time.perf_counter()
    shown = [("", -1)]

    def progress(stage: str, fraction: float) -> None:
        now = (stage, int(fraction * 100))
        if now != shown[0]:  # a line per stage and per percent, not per call
            shown[0] = now
            print(f"[{time.perf_counter() - start:7.1f} s] {now[1]:3d}%  {stage}", file=sys.stderr, flush=True)

    try:
        model, report = cad_import.read_cad_report(args.source, args.max_faces, progress)
    except cad_import.CadImportError as e:
        print(f"นำเข้าไม่ได้: {e}", file=sys.stderr)
        return 1
    write = time.perf_counter()
    model.save(args.target)
    size = Path(args.target).stat().st_size
    lo, hi = report.bounds
    stages = ", ".join(f"{k} {v:g}" for k, v in report.seconds.items() if k != "รวม")
    lines = [
        ("ไฟล์", f"{Path(args.source).name} ({Path(args.source).stat().st_size / 1e6:,.1f} MB, {report.kind}, ตัวอ่าน {report.reader})"),
        ("หน่วยในไฟล์", f"{report.unit} → โมเดลเป็น มม."),
        ("ชิ้นส่วน", f"{report.parts:,} ชิ้น ใน {report.groups:,} กลุ่ม (= {len(model.steps):,} ขั้นประกอบ) · "
                     f"รายการไม่ซ้ำ {len(model.bom()):,} รายการ"),
        ("สามเหลี่ยม", f"{report.triangles:,} (งบ {args.max_faces:,}) · ตาข่ายระดับ {report.level + 1}/{len(cad_import.LEVELS)}"
                       + (f" · แสดงเป็นกล่อง {report.boxed:,} ชิ้น" if report.boxed else "")),
        ("ผิวในไฟล์", f"{report.faces_in_file:,} ผิว (ผิวอิสระที่ต้องเย็บ {report.loose_faces:,})"),
        ("ขอบเขต (มม.)", f"X {lo[0]:,.1f} … {hi[0]:,.1f} · Y {lo[1]:,.1f} … {hi[1]:,.1f} · Z {lo[2]:,.1f} … {hi[2]:,.1f}  "
                         f"= {hi[0] - lo[0]:,.0f} × {hi[1] - lo[1]:,.0f} × {hi[2] - lo[2]:,.0f}"),
        ("วิธีแยกชิ้น", report.method()),
        ("เวลา", f"{report.seconds.get('รวม', 0):,.1f} วินาที ({stages}) + บันทึก {time.perf_counter() - write:.1f}"),
        ("หน่วยความจำสูงสุด", f"{report.peak_mb:,.0f} MB" if report.peak_mb else "วัดไม่ได้บนระบบนี้"),
        ("บันทึกที่", f"{args.target} ({size / 1e6:,.1f} MB)"),
    ]
    for key, value in lines:
        print(f"{key:<18} {value}")
    if model.note:
        print(f"{'หมายเหตุ':<18} {model.note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
