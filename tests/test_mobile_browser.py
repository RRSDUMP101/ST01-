"""The mobile app in a real browser (headless Chromium with a fake camera showing a shelf with QR labels): the
screens open and the AR reads the labels, points to the slot, flags the wrong side and picks.
Needs Node.js with Playwright (`npm i -g playwright`); skipped where they are missing (the CI runners)."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))


def _playwright() -> str:
    node = shutil.which("node")
    if not node:
        return ""
    ok = subprocess.run([node, "-e", "require('playwright')"], capture_output=True, timeout=60, check=False)
    return node if ok.returncode == 0 else ""


def test_mobile_app_and_ar_in_a_browser(tmp_path):
    node = _playwright()
    if not node:
        pytest.skip("Node.js + Playwright not installed")
    from mobile_demo import build_demo
    from mobile_fake_camera import write

    from partlist_studio.core.mobile_server import MobileServer

    _state, service = build_demo(tmp_path / "mobile")
    server = MobileServer(service, tmp_path / "mobile" / "certs", port=0, http_port=0, host="127.0.0.1")
    server.start()
    try:
        code = service.new_pair_code(minutes=30)
        device, token = service.pair(code, "ทดสอบ AR", "planner", "พับ")
        service.report_problem(device, "เครื่องพับ 2 ไฮดรอลิกรั่ว", "SO6910-016", 0, "พับ")
        info = tmp_path / "info.json"
        info.write_text(json.dumps({"app": server.app_url("127.0.0.1"), "token": token, "code": code}), encoding="utf-8")
        video = write(tmp_path / "shelf.mjpeg", "portrait")
        run = subprocess.run([node, str(ROOT / "tools" / "mobile_e2e.js"), "--info", str(info), "--video", str(video)],
                             capture_output=True, text=True, timeout=600, cwd=ROOT, check=False)
        assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-2000:]
        assert "all passed" in run.stdout
    finally:
        server.stop()
