"""The mobile app (มือถือ & AR): store map, spoiled pieces, the service the phones use, certificates and the HTTPS
server (TLS checked with the CA of the program, as a phone that installed it)."""

import json
import plistlib
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from mobile_demo import DemoState, build_demo  # noqa: E402

from partlist_studio.core import certs  # noqa: E402
from partlist_studio.core.mobile import (  # noqa: E402
    CONFIRMED,
    OPEN,
    PENDING,
    REJECTED,
    MobileError,
    MobileService,
    simplify,
)
from partlist_studio.core.mobile_server import MobileServer  # noqa: E402
from partlist_studio.core.models import Part  # noqa: E402
from partlist_studio.core.production import Job, job_from_parts  # noqa: E402
from partlist_studio.core.qr import location_payload, parse_payload  # noqa: E402
from partlist_studio.core.store_map import Rack, direction, parse_location, racks_from_locations  # noqa: E402


# ---- store map -----------------------------------------------------------------------------------------
def test_locations_on_the_store_map():
    racks = [Rack("P-POST", "ชั้นเสา", 1, "L", 1, levels=3, slots=4),
             Rack("P-FIX", aisle=1, side="R", order=2, levels=2, slots=3, bottom_first=False, left_to_right=False)]
    s = parse_location("p-post-07", racks)
    assert (s.rack_code, s.number, s.level, s.column) == ("P-POST", 7, 2, 3)  # 4 slots per level: 7 = level 2, slot 3
    assert parse_location("P-POST-2-04", racks).level == 2  # the level written in the location
    top = parse_location("P-FIX-01", racks)  # numbers start at the top level, right to left
    assert (top.level, top.column) == (2, 3)
    loose = parse_location("K-SO6910-015")  # not on the map: the rack is the location without its number
    assert (loose.rack_code, loose.number, loose.rack) == ("K-SO6910", 15, None)
    assert parse_location("R-10-03").rack_code == "R-10"  # two digits are a rack, not a level

    seen, target = parse_location("P-POST-06", racks), parse_location("P-POST-01", racks)
    d = direction(seen, target)
    assert (d.same_rack, d.dx, d.dy) == (True, -1, -1)
    assert d.text == "ซ้าย 1 ช่อง · ลง 1 ชั้น"
    assert direction(target, target).here
    other = direction(parse_location("P-FIX-02", racks), target)
    assert not other.same_rack and "ไปชั้นวาง P-POST" in other.text and "ทางเดิน 1 ฝั่งซ้าย" in other.text

    found = racks_from_locations(["P-POST-01", "P-FL-03", "P-FL-07", "R-B-03"], racks)
    codes = {r.code: r for r in found}
    assert {"P-POST", "P-FIX", "P-FL", "R-B"} <= set(codes)
    assert codes["P-FL"].aisle == codes["P-POST"].aisle != codes["R-B"].aisle  # one aisle per zone


def test_location_label_qr():
    text = location_payload("P-POST-04", "ชั้นเสา")
    assert text == "RRS1|L|P-POST-04|ชั้นเสา"
    scan = parse_payload(text)
    assert (scan.kind, scan.location) == ("location", "P-POST-04")


# ---- spoiled pieces (เสีย) -----------------------------------------------------------------------------------
def test_scrap_sends_pieces_back_to_the_first_step():
    job = job_from_parts("SO-1", [Part(item_no="1", part_no="RRS-T-001", name="เฟรมบน", qty=6)], 1)
    p = job.parts[0]
    assert p.route == ["ตัด", "พับ", "เชื่อม"]
    job.record(p, "ตัด", 6)
    job.record(p, "พับ", 4)
    assert job.scrap(p, "เชื่อม", 1, "เชื่อมเสีย", "สมชาย") == 1  # had passed พับ
    assert (p.done_at("ตัด"), p.done_at("พับ"), p.scrapped) == (5, 3, {"เชื่อม": 1})
    assert p.waiting() == {"ตัด": 1, "พับ": 2, "เชื่อม": 3}  # one piece to cut again
    assert job.scrap(p, "พับ", 9, "พับผิด") == 2  # at most the pieces waiting there
    assert job.scrap(p, "ตัด", 1, "ตัดผิดขนาด") == 1  # at the first step: only kept as scrap
    assert p.scrapped_total == 4
    entry = job.log[-3]
    assert (entry.step, entry.qty, entry.note, entry.by) == ("เสีย (เชื่อม)", 1, "เชื่อมเสีย", "สมชาย")
    assert job.scrap(p, "ทำสี", 1, "x") == 0  # not on its route
    again = Job.from_dict(json.loads(json.dumps(job.to_dict())))
    assert again.parts[0].scrapped == p.scrapped and again.log[-3].by == "สมชาย"


# ---- the service -------------------------------------------------------------------------------------------
@pytest.fixture
def demo(tmp_path):
    state, service = build_demo(tmp_path / "mobile")
    return state, service


def _pair(service, name="แอน 2", role="store", station=""):
    code = service.pair_code if service.pairing_open else service.new_pair_code()
    return service.pair(code, name, role, station)


def test_pairing_devices_and_roles(demo):
    _state, s = demo
    with pytest.raises(MobileError):
        s.pair("WRONG123", "x")  # pairing not open
    code = s.new_pair_code()
    with pytest.raises(MobileError) as err:
        s.pair("ABCDEFGH" if code != "ABCDEFGH" else "HGFEDCBA", "x")
    assert err.value.status == 403
    with pytest.raises(MobileError):
        s.pair(code, "  ")  # a name is needed
    device, token = s.pair(code.lower(), "แอน 2", "store")
    assert device.role == "store" and len(token) > 30 and token not in json.dumps(s.data.to_dict())
    assert s.authenticate(token, "10.0.0.5") is device and device.last_ip == "10.0.0.5"
    assert s.authenticate("nope") is None
    s.set_device(device.id, revoked=True)
    assert s.authenticate(token) is None
    s.set_device(device.id, revoked=False, role="viewer", station="พับ")
    viewer = s.authenticate(token)
    with pytest.raises(MobileError) as err:
        s.record(viewer, "SO6910-016", 0, "พับ", 1)
    assert err.value.status == 403
    s.pair_expires = datetime.now() - timedelta(seconds=1)
    with pytest.raises(MobileError):
        s.pair(code, "late")
    again = MobileService(DemoState(), s.data_dir)  # kept in mobile.json
    assert [d.name for d in again.data.devices] == ["แอน 2"] and again.data.devices[0].role == "viewer"
    assert [r.code for r in again.data.store_map.racks][:2] == ["P-POST", "P-FRONT"]


def test_dashboard_queue_record_and_scrap(demo):
    state, s = demo
    device, _t = _pair(s, "สมชาย", "station", "พับ")
    d = s.dashboard(device)
    assert d["open_jobs"] == 3 and d["overdue"] == 1 and d["wip_total"] > 0
    assert d["my_queue"] and all(q["step"] == "พับ" for q in d["my_queue"])
    q = s.queue("พับ")
    assert q[0]["job_no"] == "SO6910-012" and q[0]["overdue"]  # late job first
    first = next(x for x in q if x["job_no"] == "SO6910-016")
    part = state.jobs[1].parts[first["index"]]
    with pytest.raises(MobileError):
        s.record(device, first["job_no"], first["index"], "ทำสี", 1)  # not on its route
    with pytest.raises(MobileError):
        s.scrap(device, first["job_no"], first["index"], "พับ", 1, "")  # a reason is needed
    cut = part.done_at("ตัด")
    s.scrap(device, first["job_no"], first["index"], "พับ", 1, "พับผิด")
    assert part.scrapped == {"พับ": 1} and part.done_at("ตัด") == cut - 1  # to be cut again
    before = part.done_at("พับ")
    ans = s.record(device, first["job_no"], first["index"], "พับ", 10_000, "ทดสอบ")
    assert ans["taken"] == first["waiting_here"] - 1  # no more than is waiting
    assert part.done_at("พับ") == before + ans["taken"] and state.jobs[1].log[-1].by == "สมชาย"
    with pytest.raises(MobileError):
        s.record(device, first["job_no"], first["index"], "พับ", 1)  # nothing waits any more
    stations = {x["step"]: x for x in s.stations()}
    assert stations["ตัด"]["pieces"] >= 1
    job = s.job("SO6910-016")
    assert job["groups"] and job["parts_list"][first["index"]]["scrapped"] == 1
    assert any(a["by"] == "สมชาย" for a in s.activity())


def test_resolve_labels_item_and_outline(demo):
    _state, s = demo
    res = s.resolve(["RRS1|I|RRS-T-022-L-84|P-POST-04", "RRS1|J|SO6910-016|1|RRS-T-001|32", "RRS1|L|P-POST-05",
                     "RRS-T-022-R-84", "P-FIX-02", "https://example.com"])
    kinds = [(r["kind"], r["found"]) for r in res]
    assert kinds == [("item", True), ("job", True), ("location", True), ("item", True), ("location", True),
                     ("text", False)]
    assert res[0]["slot"]["level"] == 1 and res[0]["slot"]["column"] == 4 and res[0]["slot"]["on_map"]
    assert res[1]["part"]["code"] == "RRS-T-001" and res[1]["job"]["job_no"] == "SO6910-016"
    assert res[2]["slot"]["level"] == 2  # P-POST: 4 slots per level
    assert [i["code"] for i in res[2]["items"]] == ["RRS-T-022-R-84"]
    item = s.item("RRS-T-022-L-84")
    assert item["on_hand"] == 6 and item["reserved"] + item["free"] == 6 and item["has_outline"]
    assert item["group"] == "POST" and item["side"] == "ซ้าย"
    with pytest.raises(MobileError):
        s.item("NO-SUCH-CODE")
    outline = s.outline("RRS-T-022-L-84")
    assert outline["thickness"] == 3 and outline["width"] == 840 and len(outline["loops"]) == 4
    found = s.search("เสาหลัง")
    assert {r["code"] for r in found} >= {"RRS-T-022-L-84", "RRS-T-022-R-84"}
    assert all(r["short"] or r["status"] in ("ขาด", "ต่ำกว่า Min", "หมด") for r in s.search(only="short"))


def test_simplify_keeps_corners():
    loop = [(x, 0) for x in range(101)] + [(100, y) for y in range(1, 51)] + [(x, 50) for x in range(99, -1, -1)]
    out = simplify(loop, 0.2)
    assert len(out) < 10 and (100, 50) in out and (100, 0) in out


def test_count_and_pick_wait_for_the_pc_then_make_documents(demo):
    state, s = demo
    device, _t = _pair(s)
    stock = {i.code: i for i in state.stock.items}
    sub = s.submit_count(device, [{"code": "RRS-T-022-L-84", "counted": 8}, {"code": "RRS-A-033", "counted": 40},
                                  {"code": "RRS-T-022-L-84", "counted": 7, "method": "tap"}])
    assert sub["status"] == PENDING and len(sub["lines"]) == 2  # a code counted twice: the last count
    assert stock["RRS-T-022-L-84"].on_hand == 6  # nothing changes before the PC confirms
    doc = s.confirm(sub["id"], "แอน 1")
    assert doc.doc_type == "AJ" and [(ln.code, ln.qty) for ln in doc.lines] == [("RRS-T-022-L-84", 1)]
    assert stock["RRS-T-022-L-84"].on_hand == 7 and s.data.inbox[-1].status == CONFIRMED
    with pytest.raises(MobileError):
        s.confirm(sub["id"])  # once
    same = s.submit_count(device, [{"code": "RRS-A-033", "counted": 40}])
    assert s.confirm(same["id"]) is None  # all lines match: no document

    lst = s.picklist("SO6910-015")
    ready = [ln for ln in lst["lines"] if ln["ready"]]
    assert ready and ready[0]["location"] == "P-POST-01"  # the walk starts at aisle 1, the first rack
    line = next(ln for ln in ready if ln["code"] == "RRS-T-022-L-84")
    pick = s.submit_pick(device, "SO6910-015", [{"index": line["index"], "qty": 99, "verified": True}])
    assert pick["lines"][0]["qty"] == line["need"]  # no more than the job still needs
    job = state.jobs[0]
    doc = s.confirm(pick["id"])
    assert doc.doc_type == "PD" and doc.job == "SO6910-015" and "ชิ้นส่วน" in doc.remark
    assert job.parts[line["index"]].issued == line["need"]
    assert stock["RRS-T-022-L-84"].on_hand == 7 - line["need"]
    draft = s.submit_pick(device, "SO6910-015", [{"index": ready[0]["index"], "qty": 1}])
    doc = s.confirm(draft["id"], post=False)  # a draft for the เบิก / รับ page
    assert doc.status == "ร่าง" and doc in state.ledger.docs and job.parts[ready[0]["index"]].issued == 0
    other = s.submit_count(device, [{"code": "RRS-T-001", "counted": 1}])
    s.reject(other["id"])
    assert s.data.inbox[-1].status == REJECTED


def test_problems_and_who_may_solve_them(demo):
    _state, s = demo
    station, _t = _pair(s, "สมชาย", "station")
    planner, _t = _pair(s, "แอม", "planner")
    sub = s.report_problem(station, "เครื่องพับเสีย", "SO6910-016", 0, "พับ")
    assert sub["status"] == OPEN and sub["code"] == "RRS-T-001"
    assert s.dashboard()["problems"][0]["id"] == sub["id"]
    with pytest.raises(MobileError):
        s.solve_problem(sub["id"], station.name, station)
    s.solve_problem(sub["id"], planner.name, planner)
    assert not s.dashboard()["problems"]


def test_requests_done_once_and_long_poll(demo):
    _state, s = demo
    calls = []
    assert s.once("a", lambda: calls.append(1) or {"n": 1}) == {"n": 1}
    assert s.once("a", lambda: calls.append(2) or {"n": 2}) == {"n": 1}
    assert calls == [1]
    v = s.version
    assert s.wait_version(v, timeout=0.05)["version"] == v  # nothing new: answers after the timeout
    threading.Timer(0.1, s.bump, args=("pc",)).start()
    t0 = time.monotonic()
    ans = s.wait_version(v, timeout=5)
    assert ans["version"] > v and "pc" in ans["kinds"] and time.monotonic() - t0 < 2


# ---- certificates -----------------------------------------------------------------------------------------------
def test_local_ca_and_server_certificate(tmp_path):
    from cryptography import x509

    chain, _key = certs.ensure_server_cert(tmp_path, ["192.168.1.20"], "Office-PC")
    pem = chain.read_bytes()
    server = x509.load_pem_x509_certificate(pem)
    ca = x509.load_pem_x509_certificate((tmp_path / "ca.pem").read_bytes())
    assert server.issuer == ca.subject and pem.count(b"BEGIN CERTIFICATE") == 2
    san = server.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert {str(i) for i in san.get_values_for_type(x509.IPAddress)} == {"192.168.1.20", "127.0.0.1"}
    assert {"localhost", "office-pc", "office-pc.local"} <= set(san.get_values_for_type(x509.DNSName))
    eku = server.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert x509.oid.ExtendedKeyUsageOID.SERVER_AUTH in eku
    life = certs._not_after(server) - certs._now()
    assert timedelta(days=390) < life < timedelta(days=398)  # phones refuse longer
    mtime = chain.stat().st_mtime_ns
    assert certs.ensure_server_cert(tmp_path, ["192.168.1.20"], "Office-PC")[0].stat().st_mtime_ns == mtime  # kept
    certs.ensure_server_cert(tmp_path, ["192.168.1.20", "10.0.0.7"], "Office-PC")  # a new IP: made again
    server2 = x509.load_pem_x509_certificate(chain.read_bytes())
    assert "10.0.0.7" in {str(i) for i in server2.extensions.get_extension_for_class(x509.SubjectAlternativeName)
                          .value.get_values_for_type(x509.IPAddress)}
    assert x509.load_pem_x509_certificate((tmp_path / "ca.pem").read_bytes()).fingerprint(
        certs.hashes.SHA256()) == ca.fingerprint(certs.hashes.SHA256())  # the same CA: phones keep trusting
    profile = plistlib.loads(certs.mobileconfig(tmp_path))
    assert profile["PayloadContent"][0]["PayloadType"] == "com.apple.security.root"
    assert profile["PayloadContent"][0]["PayloadContent"] == certs.ca_der(tmp_path)
    assert certs.info(tmp_path)["server_ips"] == ["10.0.0.7", "127.0.0.1", "192.168.1.20"]


# ---- the HTTPS server, as a phone ---------------------------------------------------------------------------------
@pytest.fixture
def server(tmp_path):
    _state, service = build_demo(tmp_path / "mobile")
    srv = MobileServer(service, tmp_path / "mobile" / "certs", port=0, http_port=0, host="127.0.0.1")
    srv.start()
    yield srv
    srv.stop()


def _call(srv, method, path, body=None, token="", headers=None):
    ctx = ssl.create_default_context(cafile=str(srv.cert_dir / "ca.pem"))  # a phone that installed the CA
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"https://127.0.0.1:{srv.port}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as res:
            raw = res.read()
            return res.status, dict(res.headers), raw
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_server_pairing_api_and_static_files(server):
    s = server.service
    st, hd, raw = _call(server, "GET", "/api/ping")
    assert st == 200 and hd["Access-Control-Allow-Origin"] == "*"
    st, _hd, raw = _call(server, "GET", "/api/dashboard")
    assert st == 401 and "จับคู่" in json.loads(raw)["error"]
    code = s.new_pair_code()
    st, _hd, raw = _call(server, "POST", "/api/pair", {"code": code, "name": "แท็บเล็ตพับ", "role": "station", "station": "พับ"})
    assert st == 200
    ans = json.loads(raw)
    token = ans["token"]
    assert ans["hello"]["device"]["station"] == "พับ" and "พับ" in ans["hello"]["steps"]
    st, _hd, raw = _call(server, "GET", "/api/queue?step=%E0%B8%9E%E0%B8%B1%E0%B8%9A", token=token)  # พับ
    queue = json.loads(raw)
    assert st == 200 and queue
    q = queue[0]
    body = {"job_no": q["job_no"], "index": q["index"], "step": "พับ", "qty": 1}
    st, _hd, raw = _call(server, "POST", "/api/record", body, token, {"X-Request-Id": "r-1"})
    assert st == 200 and json.loads(raw)["taken"] == 1
    st, _hd, raw2 = _call(server, "POST", "/api/record", body, token, {"X-Request-Id": "r-1"})  # sent again
    assert raw2 == raw
    job = next(j for j in s.state.jobs if j.job_no == q["job_no"])
    assert sum(1 for e in job.log if e.by == "แท็บเล็ตพับ") == 1  # recorded once
    st, _hd, raw = _call(server, "POST", "/api/record", {**body, "qty": -5}, token)
    assert st == 400 and "จำนวน" in json.loads(raw)["error"]
    st, hd, raw = _call(server, "GET", "/api/events?since=0", token=token)
    assert st == 200 and json.loads(raw)["version"] > 0
    st, hd, raw = _call(server, "GET", "/")
    assert st == 200 and "default-src 'self'" in hd["Content-Security-Policy"] and b'id="app"' in raw
    assert _call(server, "GET", "/app.css", headers={"Accept-Encoding": "gzip"})[1].get("Content-Encoding") == "gzip"
    st, hd, raw = _call(server, "GET", "/vendor/zxing_reader.wasm")
    assert st == 200 and hd["Content-Type"] == "application/wasm" and raw[:4] == b"\0asm"
    st, hd, raw = _call(server, "GET", "/sw.js")
    assert st == 200 and b"__BUILD__" not in raw and server.build_id().encode() in raw
    etag = _call(server, "GET", "/app.css")[1]["ETag"]
    assert _call(server, "GET", "/app.css", headers={"If-None-Match": etag})[0] == 304
    assert _call(server, "GET", "/../../pyproject.toml")[0] == 404
    assert _call(server, "GET", "/%2e%2e/%2e%2e/pyproject.toml")[0] == 404
    assert _call(server, "GET", "/#/prod/job/SO1")[0] == 200  # app routes start from index.html
    st, _hd, raw = _call(server, "GET", "/api/image?code=RRS-T-022-L-84", token=token)
    assert st == 404  # no picture in the demo


def test_setup_page_certificate_and_pair_limit(server):
    code = server.service.new_pair_code()
    with urllib.request.urlopen(server.setup_url("127.0.0.1", code), timeout=10) as res:
        page = res.read().decode()
    assert f"#pair={code}" in page and certs.info(server.cert_dir)["ca_fingerprint"] in page
    with urllib.request.urlopen(f"http://127.0.0.1:{server.http_port}/ca.crt", timeout=10) as res:
        assert res.headers["Content-Type"] == "application/x-x509-ca-cert" and res.read() == certs.ca_der(server.cert_dir)
    with urllib.request.urlopen(f"http://127.0.0.1:{server.http_port}/rrs.mobileconfig", timeout=10) as res:
        assert res.headers["Content-Type"] == "application/x-apple-aspen-config"
    statuses = [_call(server, "POST", "/api/pair", {"code": "WRONG000", "name": "x"})[0] for _ in range(13)]
    assert statuses[:12] == [403] * 12 and statuses[-1] == 429  # guessing the code is stopped
    # a browser that does not trust the certificate cannot talk to the app
    ctx = ssl.create_default_context()
    with pytest.raises((ssl.SSLError, urllib.error.URLError)):
        urllib.request.urlopen(f"https://127.0.0.1:{server.port}/api/ping", context=ctx, timeout=5)
