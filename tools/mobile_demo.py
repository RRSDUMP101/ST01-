"""Run the mobile app server on sample data, without the desktop program (for trying the phone app, screenshots
and the browser tests).

    python tools/mobile_demo.py [--port 8443] [--http-port 8080] [--data DIR] [--token-file FILE]
    python tools/mobile_demo.py --shots docs/screenshots/mobile     (screenshots of the phone app, needs Node + Playwright)

Prints the addresses and the pairing code; --token-file writes the token of a phone already paired (for tests).
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from partlist_studio.core import dwg_io  # noqa: E402
from partlist_studio.core.catalog import Catalog  # noqa: E402
from partlist_studio.core.laser import FlatLibrary, FlatPattern  # noqa: E402
from partlist_studio.core.mobile import MobileService  # noqa: E402
from partlist_studio.core.mobile_server import MobileServer  # noqa: E402
from partlist_studio.core.models import Part  # noqa: E402
from partlist_studio.core.movements import Ledger  # noqa: E402
from partlist_studio.core.production import DONE, job_from_parts  # noqa: E402
from partlist_studio.core.stock import StockItem, StockList  # noqa: E402
from partlist_studio.core.store_map import Rack  # noqa: E402


class DemoState:
    """What MobileService needs of the program, without Qt."""

    def __init__(self):
        self.jobs = []
        self.stock = StockList()
        self.catalog = Catalog()
        self.flats = FlatLibrary()
        self.ledger = Ledger()
        self.models = []
        self.saved = 0

    def xref_lookup(self, code: str) -> list[str]:
        return []

    def save_jobs(self) -> None:
        self.saved += 1

    def save_library(self) -> None:
        self.saved += 1

    def post_doc(self, doc):
        if not doc.doc_no:
            doc.doc_no = self.ledger.next_no(doc.doc_type, doc.date)
        if doc not in self.ledger.docs:
            self.ledger.docs.append(doc)
        return self.ledger.post(doc, self.stock, StockList())


def _post(length: float, width: float, mirror: bool) -> list:
    """A post (เสาหลัง) flat: a long strip with a notch and holes; the right one mirrored."""
    outer = [(0, 0), (length, 0), (length, width), (length - 60, width), (length - 90, width - 30), (0, width - 30)]
    holes = [[(x - 9, width / 2 - 9), (x + 9, width / 2 - 9), (x + 9, width / 2 + 9), (x - 9, width / 2 + 9)]
             for x in (80, length / 2, length - 140)]
    loops = [outer, *holes]
    if mirror:
        loops = [[(length - x, y) for x, y in loop][::-1] for loop in loops]
    return loops


def build_demo(data_dir: Path) -> tuple[DemoState, MobileService]:
    state = DemoState()
    items = [
        ("RRS-T-022-L-84", "เสาหลัง(ซ้าย) 84", 6, "P-POST-04"), ("RRS-T-022-R-84", "เสาหลัง(ขวา) 84", 5, "P-POST-05"),
        ("RRS-T-023-L-84", "เสาหน้า(ซ้าย) 84", 2, "P-POST-01"), ("RRS-T-023-R-84", "เสาหน้า(ขวา) 84", 2, "P-POST-02"),
        ("RRS-T-024-L-84", "บังอาย(ซ้าย) 84", 3, "P-FRONT-02"), ("RRS-T-024-R-84", "บังอาย(ขวา) 84", 3, "P-FRONT-03"),
        ("RRS-A-033", "ตะขอเกี่ยวฝาท้าย", 40, "P-FIX-01"), ("RRS-A-127", "ปะกับ", 12, "P-FIX-02"),
        ("RRS-T-001", "เฟรมบน", 8, "P-FU-01"), ("RRS-T-002", "เฟรมล่าง", 1, "P-FL-01"),
        ("RRS-T-003", "แผ่นปิดข้าง", 10, "P-SIDE-01"), ("RRS-T-004", "ขาจับ", 20, "P-FIX-03"),
        ("RRS-T-005", "ฝาปิดท้าย", 2, "P-TAIL-01"),
    ]
    for code, name, qty, loc in items:
        state.stock.items.append(StockItem(code=code, name=name, unit="ชิ้น", on_hand=qty, min_qty=4 if "A-" in code else 0))
        state.catalog.set_location(code, loc)
    state.stock.items.append(StockItem(code="01-B00-030", name="เหล็กแผ่นดำ 3 มม. 4x8 ฟุต", unit="แผ่น", on_hand=25, min_qty=10,
                                       location="R-B-03"))
    state.stock.items.append(StockItem(code="04-B00-012", name="ท่อกลม 1.1/4 นิ้ว", unit="เส้น", on_hand=6, min_qty=12,
                                       location="R-P-01"))
    state.stock.has_quantities = True
    frame = dwg_io.read_drawing(ROOT / "samples" / "RRS-T-SET_frame_parts.dxf")
    frame_parts = [c.part for c in dwg_io.drawing_to_candidates(frame)]
    state.flats.add_parts(frame_parts, "RRS-T-SET", "A", "RRS-T-SET_frame_parts.dxf")
    for code, name, mirror in (("RRS-T-022-L-84", "เสาหลัง(ซ้าย) 84", False), ("RRS-T-022-R-84", "เสาหลัง(ขวา) 84", True)):
        state.flats.flats[code.replace("-", "")] = FlatPattern(code=code, name=name, material="SS400", thickness=3,
                                                               outline=_post(840, 140, mirror),
                                                               bend_lines=[[(0, 50), (840, 50)]])
    today = date.today()
    posts = [Part(item_no="1", part_no="RRS-T-022-L-84", name="เสาหลัง(ซ้าย) 84", qty=1, unit="ต้น"),
             Part(item_no="2", part_no="RRS-T-022-R-84", name="เสาหลัง(ขวา) 84", qty=1, unit="ต้น"),
             Part(item_no="3", part_no="RRS-T-024-L-84", name="บังอาย(ซ้าย) 84", qty=1, unit="ชิ้น"),
             Part(item_no="4", part_no="RRS-T-024-R-84", name="บังอาย(ขวา) 84", qty=1, unit="ชิ้น"),
             Part(item_no="5", part_no="RRS-A-033", name="ตะขอเกี่ยวฝาท้าย", qty=6, unit="ชิ้น"),
             Part(item_no="6", part_no="RRS-A-127", name="ปะกับ", qty=2, unit="ชิ้น"),
             Part(item_no="7", part_no="RRS-T-023-L-84", name="เสาหน้า(ซ้าย) 84", qty=1, unit="ต้น"),
             Part(item_no="8", part_no="RRS-T-023-R-84", name="เสาหน้า(ขวา) 84", qty=1, unit="ต้น")]
    job1 = job_from_parts("SO6910-015", posts, 3, state.stock, True, [], model="กระบะคอกสูง3ราว",
                          title="กระบะดั้มพ์คอกสูง 3 ราว", customer="บจก. ขนส่งตัวอย่าง", vehicle="Toyota Revo",
                          due=(today + timedelta(days=2)).isoformat(), body="กระบะดั้มพ์คอกสูง 3 ราว")
    for p in job1.parts:
        if p.to_make:
            job1.record(p, "ตัด", p.to_make)
            job1.record(p, "พับ", max(0, p.to_make - 1), by="สมชาย (พับ)")
    job2 = job_from_parts("SO6910-016", frame_parts, 2, None, False, model="ชุดเฟรมกระบะ",
                          title="ชุดเฟรมกระบะ (แบบ RRS-T-SET)", customer="หจก. รุ่งเรืองขนส่ง", vehicle="Isuzu D-Max",
                          due=(today + timedelta(days=6)).isoformat(), body="กระบะดั้มพ์พื้นเรียบ")
    job2.record(job2.parts[0], "ตัด", 20, by="เลเซอร์ 1")
    job2.record(job2.parts[0], "พับ", 12, by="สมชาย (พับ)")
    job2.record(job2.parts[1], "ตัด", 4, by="เลเซอร์ 1")
    job2.record(job2.parts[2], "ตัด", 6, by="เลเซอร์ 1")
    job2.scrap(job2.parts[2], "พับ", 1, "พับผิด", "สมชาย (พับ)")
    job2.record(job2.parts[3], DONE, 0)
    job3 = job_from_parts("SO6910-012", frame_parts[:2], 1, None, False, model="ชุดเฟรมกระบะ",
                          title="เฟรมซ่อม (เคลม)", customer="ลูกค้าเคลม", vehicle="Nissan Navara",
                          due=(today - timedelta(days=1)).isoformat())
    job3.record(job3.parts[0], "ตัด", 16)
    state.jobs = [job1, job2, job3]
    service = MobileService(state, data_dir)
    service.set_racks([
        Rack("P-POST", "ชั้นเสา", 1, "L", 1, levels=3, slots=4), Rack("P-FRONT", "ชั้นบังอาย/หน้าโปร", 1, "R", 1, levels=2, slots=4),
        Rack("P-FIX", "ชั้นหู/ตัวยึด", 1, "L", 2, levels=3, slots=3), Rack("P-FU", "ชั้นเฟรมบน", 2, "L", 1),
        Rack("P-FL", "ชั้นเฟรมล่าง", 2, "R", 1), Rack("P-SIDE", "ชั้นฝาข้าง", 2, "L", 2), Rack("P-TAIL", "ชั้นฝาท้าย", 2, "R", 2),
        Rack("R-B", "เหล็กแผ่น", 3, "L", 1, levels=1, slots=6), Rack("R-P", "ท่อ/เพลา", 3, "R", 1),
    ])
    return state, service


def _shrink(folder: Path) -> None:
    """Phone screenshots for the docs: 1.5× pixels, 256 colours (a tenth of the size)."""
    from PIL import Image

    for f in folder.glob("*.png"):
        im = Image.open(f).convert("RGB")
        w = 1024 if "ipad" in f.name else 585
        if im.width > w:
            im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--http-port", type=int, default=8080)
    ap.add_argument("--data", default="")
    ap.add_argument("--token-file", default="")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--shots", default="", help="run tools/mobile_e2e.js with a fake camera and save the screenshots here")
    args = ap.parse_args()
    if args.shots:
        args.port = args.http_port = 0
        args.host = "127.0.0.1"
        args.token_file = args.token_file or str(Path(tempfile.mkdtemp()) / "demo.json")
    data_dir = Path(args.data or tempfile.mkdtemp(prefix="rrs_mobile_demo_"))
    _state, service = build_demo(data_dir)
    server = MobileServer(service, data_dir / "certs", port=args.port, http_port=args.http_port, host=args.host)
    server.start()
    code = service.new_pair_code(minutes=600)
    info = {"app": server.app_url("127.0.0.1"), "setup": server.setup_url("127.0.0.1", code), "code": code,
            "port": server.port, "http_port": server.http_port, "addresses": server.addresses,
            "ca": str(data_dir / "certs" / "ca.pem"), "data": str(data_dir)}
    if args.token_file:
        device, token = service.pair(code, "ทดสอบ AR", "planner", "พับ")
        service.report_problem(device, "เครื่องพับ 2 ไฮดรอลิกรั่ว", "SO6910-016", 0, "พับ")
        info["token"] = token
        Path(args.token_file).write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False), flush=True)
    if args.shots:
        import shutil
        import subprocess

        from mobile_fake_camera import write

        video = write(data_dir / "shelf.mjpeg", "portrait")
        run = subprocess.run([shutil.which("node") or "node", str(ROOT / "tools" / "mobile_e2e.js"), "--info", args.token_file,
                              "--video", str(video), "--shots", args.shots], cwd=ROOT, check=False)
        server.stop()
        _shrink(Path(args.shots))
        return run.returncode
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
