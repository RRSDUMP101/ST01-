"""Phones and tablets on the factory Wi-Fi (มือถือ / แท็บเล็ต หน้างาน): what the mobile app reads and changes.

The program on the office PC is the hub. The phones open its web app (core/mobile_server.py), and every read and
every change goes through MobileService on the data of the program - the same jobs, stock, catalog and documents
as the screens of the PC. Nothing is copied to the phones.

What a phone can change:
    production  pieces through a step (บันทึกเสร็จ) and pieces spoiled (เสีย) - at once, as on the PC
    problems    แจ้งปัญหา (Andon) - shown on the PC at once; marked solved there or by a planner's phone
    counts      นับสต็อก: counted quantity per code - waits in the inbox; confirmed on the PC → AJ document
    picks       หยิบของตามใบจัดชุด: picked quantity per line of a job - inbox; confirmed → PD (parts to assembly)
Who may do what is the role chosen when the phone is paired (ดูอย่างเดียว changes nothing).

The state passed in needs jobs, stock, catalog, flats, ledger, models and xref_lookup(code), and save_jobs(),
post_doc(doc), save_library() - the AppState of the program has them. The service is not thread-safe: the
server calls it on one thread (the Qt main thread in the program); only wait_version() may be called from any
thread.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import secrets
import socket
import threading
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from .catalog import (
    GROUP_NAMES,
    GROUP_ORDER,
    ITEM_TYPES,
    MADE_TYPES,
    brand_of,
    code_finder,
    group_name,
    item_type,
    job_readiness,
    job_ready_pct,
    part_stock,
    side_of,
)
from .models import Part
from .movements import DocLine, StockDoc, lines_from_parts
from .production import CLOSED, DONE, FROM_STOCK, SCRAP, STEPS, Job, mark_document
from .qr import parse_payload
from .stock import _key
from .store_map import StoreMap, direction, parse_location

ROLES = {
    "station": "หน้างานผลิต",
    "store": "สโตร์ / คลัง",
    "planner": "วางแผน / หัวหน้างาน",
    "viewer": "ดูอย่างเดียว",
}
PENDING = "รอตรวจ"
CONFIRMED = "ยืนยันแล้ว"
REJECTED = "ไม่ใช้"
OPEN = "รอแก้"
SOLVED = "แก้แล้ว"
KIND_NAMES = {"count": "นับสต็อก", "pick": "หยิบของ", "problem": "แจ้งปัญหา"}
SCRAP_REASONS = ["พับผิด", "ตัดผิดขนาด", "เชื่อมเสีย", "รอยบุบ/ขีดข่วน", "วัสดุมีตำหนิ", "แบบผิด"]
PROBLEM_TOPICS = ["เครื่องเสีย", "วัสดุไม่พอ", "แบบไม่ชัด/ผิด", "ขาดชิ้นส่วน", "รอคิวเครื่อง", "คุณภาพ"]
DEFAULT_OPTIONS = {"port": 8443, "http_port": 8080, "autostart": False, "pair_minutes": 15}
KEEP_CLOSED = 400  # closed inbox entries kept


class MobileError(Exception):
    """A request the phone cannot do (shown on the phone as it is)."""

    def __init__(self, text: str, status: int = 400):
        super().__init__(text)
        self.status = status


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _n(v) -> float:
    v = round(float(v or 0), 3)
    return int(v) if v.is_integer() else v


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def thai_date(iso: str) -> str:
    try:
        d = date.fromisoformat((iso or "")[:10])
    except ValueError:
        return iso or ""
    return f"{d.day:02d}/{d.month:02d}/{d.year + 543}"


@dataclass
class Device:
    id: str
    name: str
    role: str = "station"
    token_hash: str = ""
    station: str = ""  # the step this person works at (หน้างานผลิต)
    created: str = field(default_factory=_now)
    last_seen: str = ""
    last_ip: str = ""
    agent: str = ""
    revoked: bool = False

    @property
    def can_change(self) -> bool:
        return self.role != "viewer" and not self.revoked

    def to_json(self) -> dict:
        return {"id": self.id, "name": self.name, "role": self.role, "role_name": ROLES.get(self.role, self.role),
                "station": self.station, "created": self.created, "last_seen": self.last_seen}


@dataclass
class Submission:
    """Something a phone sent that the PC confirms (count, pick) or solves (problem)."""

    id: str
    kind: str  # count / pick / problem
    by: str  # name of the phone
    device: str = ""
    created: str = field(default_factory=_now)
    status: str = PENDING
    job_no: str = ""
    lines: list = field(default_factory=list)
    text: str = ""
    step: str = ""
    code: str = ""
    name: str = ""
    doc_no: str = ""  # document made when confirmed
    closed: str = ""
    closed_by: str = ""

    @property
    def is_open(self) -> bool:
        return self.status in (PENDING, OPEN)

    @property
    def kind_name(self) -> str:
        return KIND_NAMES.get(self.kind, self.kind)

    def summary(self) -> str:
        if self.kind == "problem":
            what = " ".join(x for x in (self.job_no, self.code, f"ขั้น{self.step}" if self.step else "") if x)
            return f"{what}: {self.text}" if what else self.text
        if self.kind == "count":
            diff = sum(1 for ln in self.lines if ln.get("diff"))
            return f"{len(self.lines)} รายการ · ไม่ตรง {diff}"
        picked = sum(float(ln.get("qty") or 0) for ln in self.lines)
        return f"{self.job_no} · {len(self.lines)} รายการ · {picked:g} ชิ้น"

    def to_json(self) -> dict:
        data = asdict(self)
        data["kind_name"] = self.kind_name
        data["summary"] = self.summary()
        data["is_open"] = self.is_open
        return data

    @classmethod
    def from_dict(cls, data: dict) -> Submission:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class MobileData:
    devices: list[Device] = field(default_factory=list)
    inbox: list[Submission] = field(default_factory=list)
    store_map: StoreMap = field(default_factory=StoreMap)
    options: dict = field(default_factory=lambda: dict(DEFAULT_OPTIONS))

    def option(self, key: str):
        return self.options.get(key, DEFAULT_OPTIONS.get(key))

    def to_dict(self) -> dict:
        return {"devices": [asdict(d) for d in self.devices], "inbox": [asdict(s) for s in self.inbox],
                "store_map": self.store_map.to_dict(), "options": self.options}

    @classmethod
    def from_dict(cls, data: dict | None) -> MobileData:
        data = data or {}
        options = dict(DEFAULT_OPTIONS)
        options.update({k: v for k, v in (data.get("options") or {}).items() if k in DEFAULT_OPTIONS})
        return cls([Device(**{k: v for k, v in d.items() if k in Device.__dataclass_fields__})
                    for d in data.get("devices", []) if d.get("id")],
                   [Submission.from_dict(s) for s in data.get("inbox", []) if s.get("id")],
                   StoreMap.from_dict(data.get("store_map")), options)

    @classmethod
    def load(cls, path: Path) -> MobileData:
        try:
            return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return cls()

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)


def lan_addresses() -> list[str]:
    """IPv4 addresses of this PC on the local network (192.168…, 10…, 172.16-31…) - the one with the default
    route first."""
    found: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent: only picks the interface of the route
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass

    def private(ip: str) -> bool:
        a = [int(x) for x in ip.split(".")]
        return a[0] == 10 or (a[0] == 172 and 16 <= a[1] <= 31) or (a[0] == 192 and a[1] == 168)

    out = [ip for ip in dict.fromkeys(found) if not ip.startswith(("127.", "0.", "169.254."))]
    return sorted(out, key=lambda ip: (not private(ip), out.index(ip)))


def simplify(loop: list, tol: float) -> list:
    """Douglas-Peucker on a closed loop of (x, y)."""
    pts = [(float(x), float(y)) for x, y in loop]
    if len(pts) < 5:
        return pts

    def dp(a: int, b: int, out: list) -> None:
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy) or 1e-9
        best, far = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / length
            if d > best:
                best, far = d, i
        if best > tol and far > 0:
            dp(a, far, out)
            dp(far, b, out)
        else:
            out.append(pts[b])

    half = len(pts) // 2
    out = [pts[0]]
    dp(0, half, out)
    dp(half, len(pts) - 1, out)
    return out if len(out) >= 3 else pts


class MobileService:
    def __init__(self, state, data_dir: str | Path, on_event=None):
        self.state = state
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "mobile.json"
        self.data = MobileData.load(self.path)
        self.on_event = on_event  # callable(kind, payload) for the PC: 'problem', 'count', 'pick', 'device', 'record'
        self.pair_code = ""
        self.pair_expires: datetime | None = None
        self._cond = threading.Condition()
        self._version = 1
        self._kinds: list[tuple[int, str]] = []
        self._requests: OrderedDict[str, dict] = OrderedDict()  # X-Request-Id -> answer (a phone sends again)
        self._cache: dict = {}
        self._seen_saved = datetime.now()

    # ---- saving, versions --------------------------------------------------------------------------
    def save(self) -> None:
        closed = [s for s in self.data.inbox if not s.is_open]
        if len(closed) > KEEP_CLOSED:
            drop = {id(s) for s in closed[:-KEEP_CLOSED]}
            self.data.inbox = [s for s in self.data.inbox if id(s) not in drop]
        self.data.save(self.path)

    def bump(self, kind: str = "data") -> int:
        """Something changed (on a phone or on the PC): phones waiting on /api/events fetch again."""
        self._cache.clear()
        with self._cond:
            self._version += 1
            self._kinds.append((self._version, kind))
            del self._kinds[:-50]
            self._cond.notify_all()
            return self._version

    @property
    def version(self) -> int:
        with self._cond:
            return self._version

    def wait_version(self, since: int, timeout: float = 25.0) -> dict:
        """Long poll: returns when the version is past `since` or after `timeout` s. Any thread."""
        with self._cond:
            self._cond.wait_for(lambda: self._version > since, timeout=timeout)
            kinds = sorted({k for v, k in self._kinds if v > since})
            return {"version": self._version, "kinds": kinds}

    def _event(self, kind: str, payload=None) -> None:
        self.bump(kind)
        if self.on_event is not None:
            self.on_event(kind, payload)

    def once(self, request_id: str, fn):
        """Run a change once per request id: a phone that lost the answer sends the same id again."""
        if request_id and request_id in self._requests:
            return self._requests[request_id]
        answer = fn()
        if request_id:
            self._requests[request_id] = answer
            while len(self._requests) > 500:
                self._requests.popitem(last=False)
        return answer

    # ---- pairing and devices ---------------------------------------------------------------------------
    def new_pair_code(self, minutes: float | None = None) -> str:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        self.pair_code = "".join(secrets.choice(alphabet) for _ in range(8))
        self.pair_expires = datetime.now() + timedelta(minutes=minutes or self.data.option("pair_minutes"))
        return self.pair_code

    def close_pairing(self) -> None:
        self.pair_code = ""
        self.pair_expires = None

    @property
    def pairing_open(self) -> bool:
        return bool(self.pair_code) and self.pair_expires is not None and datetime.now() < self.pair_expires

    def pair(self, code: str, name: str, role: str = "station", station: str = "", ip: str = "",
             agent: str = "") -> tuple[Device, str]:
        code = (code or "").strip().upper().replace("-", "").replace(" ", "")
        if not self.pairing_open or not secrets.compare_digest(code, self.pair_code):
            raise MobileError("รหัสจับคู่ไม่ถูกต้องหรือหมดเวลา – สร้างรหัสใหม่ที่หน้า มือถือ & AR บนคอม", 403)
        name = " ".join((name or "").split())[:40]
        if not name:
            raise MobileError("ใส่ชื่อผู้ใช้ก่อน")
        role = role if role in ROLES else "station"
        station = station if station in STEPS else ""
        token = secrets.token_urlsafe(32)
        device = Device(id=secrets.token_hex(6), name=name, role=role, token_hash=_hash(token), station=station,
                        last_seen=_now(), last_ip=ip, agent=(agent or "")[:160])
        self.data.devices.append(device)
        self.save()
        self._event("device", device)
        return device, token

    def authenticate(self, token: str, ip: str = "") -> Device | None:
        if not token:
            return None
        h = _hash(token)
        device = next((d for d in self.data.devices if secrets.compare_digest(d.token_hash, h)), None)
        if device is None or device.revoked:
            return None
        device.last_seen = _now()
        if ip:
            device.last_ip = ip
        if datetime.now() - self._seen_saved > timedelta(minutes=10):
            self._seen_saved = datetime.now()
            self.save()
        return device

    def set_device(self, device_id: str, **changes) -> Device | None:
        device = next((d for d in self.data.devices if d.id == device_id), None)
        if device is None:
            return None
        for key, value in changes.items():
            if key == "role" and value in ROLES:
                device.role = value
            elif key == "station" and (value in STEPS or value == ""):
                device.station = value
            elif key == "name" and str(value).strip():
                device.name = " ".join(str(value).split())[:40]
            elif key == "revoked":
                device.revoked = bool(value)
        self.save()
        self._event("device", device)
        return device

    def remove_device(self, device_id: str) -> None:
        self.data.devices = [d for d in self.data.devices if d.id != device_id]
        self.save()
        self._event("device", None)

    def update_profile(self, device: Device, name: str = "", station: str | None = None) -> dict:
        changes = {}
        if name:
            changes["name"] = name
        if station is not None:
            changes["station"] = station
        self.set_device(device.id, **changes)
        return device.to_json()

    @staticmethod
    def _need(device: Device) -> None:
        if not device.can_change:
            raise MobileError("บทบาท ดูอย่างเดียว บันทึกไม่ได้ – ให้หัวหน้าเปลี่ยนบทบาทที่คอม", 403)

    # ---- lookups ------------------------------------------------------------------------------------
    def _find(self):
        if "find" not in self._cache:
            self._cache["find"] = code_finder(self.state.stock)
        return self._cache["find"]

    def _parts(self) -> dict:
        """_key(code) -> PartStock of the made parts and the parts of open jobs (the six numbers)."""
        if "parts" not in self._cache:
            rows = part_stock(self.state.stock, self.state.jobs, self.state.catalog)
            self._cache["parts"] = {_key(r.code): r for r in rows}
        return self._cache["parts"]

    def _job(self, job_no: str) -> Job:
        job = next((j for j in self.state.jobs if j.job_no == job_no), None)
        if job is None:
            raise MobileError(f"ไม่พบงาน {job_no}", 404)
        return job

    def _job_part(self, job_no: str, index) -> tuple[Job, object]:
        job = self._job(job_no)
        try:
            i = int(index)
        except (TypeError, ValueError):
            i = -1
        if not 0 <= i < len(job.parts):
            raise MobileError("ไม่พบรายการนี้ในงาน", 404)
        return job, job.parts[i]

    def _flat(self, code: str):
        lookup = getattr(self.state, "xref_lookup", None)
        flats = self.state.flats
        flat = flats.get(code, lookup)
        if flat is None:
            key = _key(code)
            for job in self.state.jobs:
                for p in job.parts:
                    if p.drawing_code and _key(p.code) == key:
                        flat = flats.get(p.drawing_code, lookup)
                        if flat is not None:
                            return flat
        return flat

    def image_path(self, code: str) -> str:
        key = _key(code)
        for job in self.state.jobs:
            for p in job.parts:
                if p.image and key in (_key(p.code), _key(p.drawing_code)) and Path(p.image).is_file():
                    return p.image
        for model in getattr(self.state, "models", []):
            for row in model.rows:
                if row.image and key in {_key(c) for c in row.codes} and Path(row.image).is_file():
                    return row.image
        return ""

    def _location(self, code: str, item=None) -> str:
        return self.state.catalog.location_of(code, item)

    def _slot(self, location: str) -> dict:
        return parse_location(location, self.data.store_map.racks).to_dict()

    # ---- JSON of things -------------------------------------------------------------------------------
    def item_json(self, code: str, location: str = "") -> dict:
        """What the phone shows of a code: the six numbers (made parts) or the balance, where it is kept, its size."""
        find = self._find()
        item = find(code)
        row = self._parts().get(_key(item.code if item else code))
        real = item.code if item else (row.code if row else code)
        name = (item.name if item else "") or (row.name if row else "")
        unit = (item.unit_name if item else "") or (row.unit if row else "") or "ชิ้น"
        kind = item_type(real, name, item.unit_name if item else "")
        flat = self._flat(real)
        loc = location or self._location(real, item)
        out = {
            "found": bool(item or row), "key": _key(real), "code": real, "name": name, "unit": unit,
            "type": kind, "type_name": ITEM_TYPES.get(kind, ""), "location": loc,
            "slot": self._slot(loc) if loc else None,
            "group": self.state.catalog.group_of(real, name) if kind in MADE_TYPES or row else "",
            "brand": brand_of(real), "side": side_of(real, name),
            "on_hand": _n(item.on_hand if item else (row.on_hand if row else 0)),
            "min": _n(item.min_qty if item else 0), "max": _n(item.max_qty if item else 0),
            "material": (flat.material if flat else "") or (item.material if item else ""),
            "thickness": _n(flat.thickness if flat else 0), "spec": item.spec if item else "",
            "size": "", "has_outline": bool(flat and flat.outline), "has_image": bool(self.image_path(real)),
        }
        out["group_name"] = group_name(out["group"]) if out["group"] else ""
        if flat is not None and flat.outline:
            w, h = flat.size
            out["size"] = f"{w:.0f} × {h:.0f} มม."
        if row is not None:
            out.update({"reserved": _n(row.reserved), "free": _n(row.free), "wip": {k: _n(v) for k, v in row.wip.items()},
                        "wip_text": row.wip_text, "incoming": _n(row.incoming), "need": _n(row.need),
                        "short": _n(row.short), "status": row.status, "jobs": row.jobs})
        else:
            free = item.on_hand if item else 0
            low = bool(item and item.min_qty and item.on_hand < item.min_qty)
            out.update({"reserved": 0, "free": _n(free), "wip": {}, "wip_text": "", "incoming": 0, "need": 0,
                        "short": 0, "status": "ต่ำกว่า Min" if low else ("พอ" if free > 0 else "หมด" if item else "-"),
                        "jobs": []})
        return out

    def part_json(self, job: Job, i: int) -> dict:
        p = job.parts[i]
        waiting = p.waiting()
        find = self._find()
        item = find(p.code)
        loc = self._location(p.code, item)
        flat = self._flat(p.drawing_code or p.code) or self._flat(p.code)
        nxt = next(iter(waiting), "")
        return {
            "job_no": job.job_no, "index": i, "key": _key(p.code), "code": p.code, "name": p.name, "unit": p.unit,
            "drawing_code": p.drawing_code, "required": _n(p.required), "from_stock": _n(p.from_stock),
            "to_make": _n(p.to_make), "finished": _n(p.finished), "received": _n(p.received), "issued": _n(p.issued),
            "route": [{"step": s, "done": _n(p.done_at(s)), "waiting": _n(waiting.get(s, 0)),
                       "scrapped": _n(p.scrapped.get(s, 0))} for s in p.route],
            "status": p.status, "status_text": p.status_text, "progress": round(p.progress, 3), "next_step": nxt,
            "next_qty": _n(waiting.get(nxt, 0)), "scrapped": _n(p.scrapped_total), "location": loc,
            "slot": self._slot(loc) if loc else None, "material": p.material or (flat.material if flat else ""),
            "thickness": _n(p.thickness or (flat.thickness if flat else 0)), "spec": p.spec, "remark": p.remark,
            "has_outline": bool(flat and flat.outline), "has_image": bool(self.image_path(p.code)),
            "outline_code": flat.code if flat else "",
        }

    def job_json(self, job: Job, readiness: bool = False) -> dict:
        today = date.today()
        try:
            days = (date.fromisoformat(job.due[:10]) - today).days if job.due else None
        except ValueError:
            days = None
        waiting: dict[str, float] = {}
        for p in job.parts:
            for s, q in p.waiting().items():
                waiting[s] = waiting.get(s, 0) + q
        groups = job_readiness(job, self.state.catalog, self.state.stock)
        out = {"job_no": job.job_no, "title": job.title or job.model, "model": job.model, "customer": job.customer,
               "vehicle": job.vehicle, "body": job.body, "sets": _n(job.sets), "due": job.due,
               "due_text": thai_date(job.due), "days_left": days, "status": job.status,
               "closed": job.status in CLOSED, "overdue": job.overdue, "progress": round(job.progress, 3),
               "ready_pct": round(job_ready_pct(groups), 3), "parts": len(job.parts),
               "parts_done": sum(1 for p in job.parts if p.status in (DONE, FROM_STOCK)),
               "waiting": {s: _n(q) for s, q in sorted(waiting.items(), key=lambda kv: _step_order(kv[0]))}}
        if readiness:
            out["groups"] = [{"group": g.group, "name": g.name, "pct": round(g.pct, 3), "complete": g.complete,
                              "required": _n(g.required), "ready": _n(g.ready), "missing": g.missing_text()}
                             for g in groups]
        return out

    # ---- reading -----------------------------------------------------------------------------------
    def hello(self, device: Device) -> dict:
        from .. import APP_NAME, __version__

        return {"app": APP_NAME, "version": __version__, "server": socket.gethostname(), "time": _now(),
                "device": device.to_json(), "roles": ROLES, "steps": STEPS,
                "groups": [{"key": g, "name": GROUP_NAMES[g]} for g in GROUP_ORDER],
                "scrap_reasons": SCRAP_REASONS, "problem_topics": PROBLEM_TOPICS, "events": self.version}

    def dashboard(self, device: Device | None = None) -> dict:
        jobs = [j for j in self.state.jobs if j.status not in CLOSED]
        today = date.today().isoformat()
        soon = (date.today() + timedelta(days=3)).isoformat()
        wip: dict[str, float] = {}
        for j in jobs:
            for p in j.parts:
                for s, q in p.waiting().items():
                    wip[s] = wip.get(s, 0) + q
        done_today = scrap_today = 0.0
        for j in self.state.jobs:
            for e in j.log:
                if e.when[:10] != today:
                    continue
                if e.step in STEPS:
                    done_today += e.qty
                elif e.step.startswith(SCRAP):
                    scrap_today += e.qty
        parts = self._parts().values()
        short = [r for r in parts if r.short > 0]
        low = [r for r in parts if not r.short and r.min_qty and r.free < r.min_qty]
        order = sorted(jobs, key=lambda j: (not j.overdue, j.due or "9999", j.job_no))
        mine = []
        if device is not None and device.station:
            mine = self.queue(device.station)[:5]
        return {
            "open_jobs": len(jobs), "overdue": sum(1 for j in jobs if j.overdue),
            "due_soon": sum(1 for j in jobs if j.due and not j.overdue and today <= j.due[:10] <= soon),
            "wip": {s: _n(q) for s, q in sorted(wip.items(), key=lambda kv: _step_order(kv[0]))},
            "wip_total": _n(sum(wip.values())), "done_today": _n(done_today), "scrap_today": _n(scrap_today),
            "short": len(short), "below_min": len(low),
            "short_items": [{"code": r.code, "name": r.name, "short": _n(r.short), "location": r.location}
                            for r in sorted(short, key=lambda r: -r.short)[:5]],
            "problems": [s.to_json() for s in self.data.inbox if s.kind == "problem" and s.is_open][-10:][::-1],
            "inbox": sum(1 for s in self.data.inbox if s.kind != "problem" and s.is_open),
            "jobs": [self.job_json(j) for j in order[:6]], "my_queue": mine, "events": self.version,
        }

    def jobs(self, include_closed: bool = False) -> list[dict]:
        jobs = [j for j in self.state.jobs if include_closed or j.status not in CLOSED]
        jobs.sort(key=lambda j: (j.status in CLOSED, not j.overdue, j.due or "9999", j.job_no))
        return [self.job_json(j) for j in jobs]

    def job(self, job_no: str) -> dict:
        job = self._job(job_no)
        out = self.job_json(job, readiness=True)
        out["parts_list"] = [self.part_json(job, i) for i in range(len(job.parts))]
        out["log"] = [asdict(e) for e in job.log[-30:][::-1]]
        return out

    def stations(self) -> list[dict]:
        out = []
        for step in STEPS:
            pieces, lines, jobs = 0.0, 0, set()
            for j in self.state.jobs:
                if j.status in CLOSED:
                    continue
                for p in j.parts:
                    q = p.waiting().get(step, 0)
                    if q > 0:
                        pieces += q
                        lines += 1
                        jobs.add(j.job_no)
            out.append({"step": step, "pieces": _n(pieces), "lines": lines, "jobs": len(jobs)})
        return out

    def queue(self, step: str) -> list[dict]:
        """Parts waiting at a step over the open jobs: late jobs first, then by the due date."""
        if step not in STEPS:
            raise MobileError(f"ไม่มีขั้น {step}")
        rows = []
        for j in self.state.jobs:
            if j.status in CLOSED:
                continue
            for i, p in enumerate(j.parts):
                q = p.waiting().get(step, 0)
                if q > 0:
                    rows.append((j, i, q))
        rows.sort(key=lambda t: (not t[0].overdue, t[0].due or "9999", t[0].job_no, t[1]))
        out = []
        for j, i, q in rows:
            entry = self.part_json(j, i)
            entry.update({"step": step, "waiting_here": _n(q), "job_title": j.title or j.model, "due": j.due,
                          "due_text": thai_date(j.due), "overdue": j.overdue, "customer": j.customer})
            out.append(entry)
        return out

    def activity(self, limit: int = 30) -> list[dict]:
        rows = []
        for j in self.state.jobs:
            for e in j.log[-limit:]:
                rows.append({"when": e.when, "kind": "scrap" if e.step.startswith(SCRAP) else "record",
                             "job_no": j.job_no, "code": e.code, "name": e.name, "step": e.step, "qty": _n(e.qty),
                             "note": e.note, "by": e.by or "คอม"})
        for s in self.data.inbox[-limit:]:
            rows.append({"when": s.created, "kind": s.kind, "job_no": s.job_no, "code": s.code, "name": s.name,
                         "step": s.step, "qty": 0, "note": s.summary(), "by": s.by, "status": s.status})
        rows.sort(key=lambda r: r["when"], reverse=True)
        return rows[:limit]

    def search(self, query: str = "", group: str = "", only: str = "", limit: int = 60) -> list[dict]:
        """Made parts (six numbers) and the other stock items, by code / name / location."""
        q = (query or "").strip().lower()
        rows: dict[str, dict] = {}
        for key, r in self._parts().items():
            rows[key] = {"key": key, "code": r.code, "name": r.name, "unit": r.unit, "location": r.location,
                         "group": r.group, "group_name": group_name(r.group), "on_hand": _n(r.on_hand),
                         "free": _n(r.free), "short": _n(r.short), "status": r.status, "made": True,
                         "wip_text": r.wip_text, "min": _n(r.min_qty)}
        for item in self.state.stock.items:
            key = _key(item.code)
            if not key or key in rows:
                continue
            low = bool(item.min_qty and item.on_hand < item.min_qty)
            rows[key] = {"key": key, "code": item.code, "name": item.name, "unit": item.unit_name,
                         "location": self._location(item.code, item), "group": "", "group_name": "",
                         "on_hand": _n(item.on_hand), "free": _n(item.on_hand), "short": 0,
                         "status": "ต่ำกว่า Min" if low else ("พอ" if item.on_hand > 0 else "หมด"), "made": False,
                         "wip_text": "", "min": _n(item.min_qty)}
        out = []
        for r in rows.values():
            if group and r["group"] != group:
                continue
            if only == "short" and not (r["short"] > 0 or r["status"] in ("ขาด", "ต่ำกว่า Min", "หมด")):
                continue
            if only == "made" and not r["made"]:
                continue
            if q and q not in f"{r['code']} {r['name']} {r['location']}".lower():
                continue
            out.append(r)
        order = {g: i for i, g in enumerate(GROUP_ORDER)}
        out.sort(key=lambda r: (not r["made"], order.get(r["group"], 99), r["code"]))
        return out[:max(1, min(int(limit or 60), 300))]

    def item(self, code: str) -> dict:
        out = self.item_json(code)
        if not out["found"]:
            raise MobileError(f"ไม่พบรหัส {code}", 404)
        key = out["key"]
        moves = [m for m in self.state.ledger.movements if _key(m.code) == key][-8:][::-1]
        out["movements"] = [{"when": m.when, "doc": f"{m.doc_type} {m.doc_no}", "qty": _n(m.qty),
                             "balance": _n(m.balance), "job": m.job} for m in moves]
        out["job_lines"] = [{"job_no": j.job_no, "index": i, "status_text": p.status_text, "need": _n(p.required - p.issued)}
                            for j in self.state.jobs if j.status not in CLOSED
                            for i, p in enumerate(j.parts) if _key(p.code) == key][:12]
        return out

    def outline(self, code: str) -> dict:
        flat = self._flat(code)
        if flat is None or not flat.outline:
            raise MobileError("ยังไม่มีรูปคลี่ของรหัสนี้ (นำเข้าแบบ DWG ก่อน)", 404)
        w, h = flat.size
        tol = max(0.2, max(w, h) / 500)
        loops = [simplify(loop, tol) for loop in flat.outline]
        total = sum(len(lp) for lp in loops)
        if total > 4000:  # very detailed drawings: coarser
            loops = [simplify(loop, tol * total / 2000) for loop in flat.outline]
        return {"code": flat.code, "name": flat.name, "thickness": _n(flat.thickness), "material": flat.material,
                "width": round(w, 1), "length": round(h, 1),
                "loops": [[[round(x, 2), round(y, 2)] for x, y in loop] for loop in loops],
                "bends": [[[round(x, 2), round(y, 2)] for x, y in line] for line in flat.bend_lines],
                "drawing": " ".join(x for x in (flat.drawing_no, f"Rev.{flat.revision}" if flat.revision else "") if x)}

    def resolve(self, texts: list[str]) -> list[dict]:
        """What each QR the camera sees is: a job ticket, a shelf label, a location label or a code."""
        out = []
        for text in list(dict.fromkeys(str(t) for t in texts or []))[:40]:
            out.append(self._resolve_one(text))
        return out

    def _resolve_one(self, text: str) -> dict:
        scan = parse_payload(text)
        base = {"text": text, "kind": scan.kind}
        if scan.kind == "job":
            job = next((j for j in self.state.jobs if j.job_no == scan.job_no), None)
            if job is None:
                return {**base, "found": False, "message": f"ไม่พบงาน {scan.job_no}", "code": scan.code}
            i = scan.line - 1
            if not (0 <= i < len(job.parts)) or (scan.code and _key(job.parts[i].code) != _key(scan.code)):
                i = next((k for k, p in enumerate(job.parts) if _key(p.code) == _key(scan.code)), -1)
            if i < 0:
                return {**base, "found": False, "message": f"ไม่พบ {scan.code} ในงาน {scan.job_no}", "code": scan.code}
            part = self.part_json(job, i)
            return {**base, "found": True, "key": part["key"], "code": part["code"], "name": part["name"],
                    "location": part["location"], "slot": part["slot"], "part": part,
                    "job": {"job_no": job.job_no, "title": job.title or job.model, "due_text": thai_date(job.due),
                            "overdue": job.overdue}}
        if scan.kind == "location":
            return self._location_json(base, scan.location)
        code = scan.code
        item = self.item_json(code, scan.location if scan.kind == "item" else "")
        if item["found"]:
            if scan.kind == "item" and scan.location:
                item["location"] = scan.location
                item["slot"] = self._slot(scan.location)
            return {**base, "kind": "item", "found": True, "key": item["key"], "code": item["code"],
                    "name": item["name"], "location": item["location"], "slot": item["slot"], "item": item}
        locations = {self._location(r.code, r.item) for r in self._parts().values()} | \
            {v for v in self.state.catalog.locations.values()}
        if scan.kind == "text" and _key(code) in {_key(x) for x in locations if x}:
            return self._location_json(base, code)
        return {**base, "found": False, "code": code, "message": f"ไม่พบ {code} ในสต็อก"}

    def _location_json(self, base: dict, location: str) -> dict:
        slot = self._slot(location)
        key = _key(location)
        items = []
        for r in self._parts().values():
            if r.location and _key(r.location) == key:
                items.append({"key": _key(r.code), "code": r.code, "name": r.name, "on_hand": _n(r.on_hand)})
        return {**base, "kind": "location", "found": True, "key": "", "code": "", "name": slot.get("rack_name", ""),
                "location": slot["location"], "slot": slot, "items": items[:12]}

    def store_map(self) -> dict:
        racks = self.data.store_map.racks
        return {"racks": [r.to_dict() | {"where": r.where} for r in racks],
                "aisles": sorted({r.aisle for r in racks})}

    def navigate(self, seen_location: str, target_location: str) -> dict:
        racks = self.data.store_map.racks
        return direction(parse_location(seen_location, racks), parse_location(target_location, racks)).to_dict()

    # ---- production ----------------------------------------------------------------------------------
    def record(self, device: Device, job_no: str, index, step: str, qty, note: str = "") -> dict:
        self._need(device)
        job, p = self._job_part(job_no, index)
        if job.status in CLOSED:
            raise MobileError(f"งาน {job_no} ปิดแล้ว")
        if step not in p.route:
            raise MobileError(f"ชิ้นนี้ไม่มีขั้น{step} (ขั้นตอน: {' → '.join(p.route) or 'ไม่มี'})")
        qty = _qty(qty)
        taken = job.record(p, step, qty, note.strip()[:200], device.name)
        if not taken:
            raise MobileError(f"ขั้น{step} ไม่มีชิ้นรอ – ตรวจขั้นก่อนหน้า")
        self.state.save_jobs()
        self._event("record", (job.job_no, step, taken))
        return {"taken": _n(taken), "part": self.part_json(job, int(index)), "job_status": job.status}

    def scrap(self, device: Device, job_no: str, index, step: str, qty, reason: str = "") -> dict:
        self._need(device)
        job, p = self._job_part(job_no, index)
        if step not in p.route:
            raise MobileError(f"ชิ้นนี้ไม่มีขั้น{step}")
        reason = reason.strip()[:200]
        if not reason:
            raise MobileError("เลือกหรือพิมพ์สาเหตุที่เสีย")
        taken = job.scrap(p, step, _qty(qty), reason, device.name)
        if not taken:
            raise MobileError(f"ขั้น{step} ไม่มีชิ้นรอให้บันทึกเสีย")
        self.state.save_jobs()
        self._event("scrap", (job.job_no, step, taken))
        return {"taken": _n(taken), "part": self.part_json(job, int(index))}

    def report_problem(self, device: Device, text: str, job_no: str = "", index=None, step: str = "") -> dict:
        if device.revoked:
            raise MobileError("อุปกรณ์นี้ถูกยกเลิกสิทธิ์", 403)
        text = " ".join((text or "").split())[:300]
        if not text:
            raise MobileError("พิมพ์หรือเลือกปัญหาก่อนส่ง")
        code = name = ""
        if job_no:
            job = self._job(job_no)
            if index is not None and str(index) != "":
                _job, p = self._job_part(job_no, index)
                code, name = p.code, p.name
            job_no = job.job_no
        sub = Submission(id=secrets.token_hex(6), kind="problem", by=device.name, device=device.id, status=OPEN,
                         job_no=job_no, text=text, step=step if step in STEPS else "", code=code, name=name)
        self.data.inbox.append(sub)
        self.save()
        self._event("problem", sub)
        return sub.to_json()

    def solve_problem(self, sub_id: str, by: str, device: Device | None = None) -> dict:
        if device is not None and device.role != "planner":
            raise MobileError("หัวหน้างาน/วางแผน เท่านั้นที่ปิดปัญหาได้", 403)
        sub = self._submission(sub_id)
        if sub.kind != "problem":
            raise MobileError("ไม่ใช่การแจ้งปัญหา")
        sub.status, sub.closed, sub.closed_by = SOLVED, _now(), by
        self.save()
        self._event("problem_solved", sub)
        return sub.to_json()

    # ---- counts ----------------------------------------------------------------------------------------
    def submit_count(self, device: Device, lines: list[dict], note: str = "") -> dict:
        self._need(device)
        find = self._find()
        out, seen = [], set()
        for raw in lines or []:
            code = str(raw.get("code") or "").strip()
            if not code:
                continue
            counted = _qty(raw.get("counted"), allow_zero=True)
            item = find(code)
            key = _key(item.code if item else code)
            if key in seen:  # counted twice in one session: the last count
                out = [ln for ln in out if ln["key"] != key]
            seen.add(key)
            system = item.on_hand if item else 0
            out.append({"key": key, "code": item.code if item else code, "name": item.name if item else "",
                        "unit": item.unit_name if item else "", "location": str(raw.get("location") or "")
                        or self._location(code, item), "counted": _n(counted), "system": _n(system),
                        "diff": _n(counted - system), "found": item is not None,
                        "method": str(raw.get("method") or "")[:20], "note": str(raw.get("note") or "")[:120]})
        if not out:
            raise MobileError("ยังไม่มีรายการที่นับ")
        sub = Submission(id=secrets.token_hex(6), kind="count", by=device.name, device=device.id, lines=out,
                         text=" ".join((note or "").split())[:200])
        self.data.inbox.append(sub)
        self.save()
        self._event("count", sub)
        return sub.to_json()

    # ---- picking -------------------------------------------------------------------------------------------
    def _pick_lines(self, job: Job) -> list[dict]:
        racks = self.data.store_map.racks
        find = self._find()
        lines = []
        for i, p in enumerate(job.parts):
            need = p.required - p.issued
            if need <= 0:
                continue
            ready = p.required if p.to_make <= 0 else min(p.required, p.from_stock + p.finished)
            now = max(0.0, min(need, ready - p.issued))
            item = find(p.code)
            loc = self._location(p.code, item)
            slot = parse_location(loc, racks)
            where = "ใช้จากสต็อก" if p.to_make <= 0 else p.status_text
            if p.to_make > 0 and p.finished >= p.to_make:
                where = "เสร็จ" if p.received >= p.to_make else "เสร็จ รอรับเข้า"
            flat = self._flat(p.drawing_code or p.code) or self._flat(p.code)
            rack = slot.rack
            lines.append({"index": i, "key": _key(item.code if item else p.code), "code": item.code if item else p.code,
                          "name": p.name, "unit": p.unit, "need": _n(need), "pick_now": _n(now), "ready": now > 0,
                          "where": where, "location": loc, "slot": slot.to_dict() if loc else None,
                          "group_name": group_name(self.state.catalog.group_of(item.code if item else p.code, p.name)),
                          "side": side_of(p.code, p.name), "thickness": _n(p.thickness or (flat.thickness if flat else 0)),
                          "material": p.material or (flat.material if flat else ""),
                          "has_outline": bool(flat and flat.outline), "has_image": bool(self.image_path(p.code)),
                          "outline_code": flat.code if flat else "",
                          "_order": (not now > 0, not loc, rack.aisle if rack else 99, rack.order if rack else 99,
                                     rack.side if rack else "", slot.rack_code, slot.level, slot.column, loc, i)})
        lines.sort(key=lambda ln: ln.pop("_order"))
        return lines

    def picklists(self) -> list[dict]:
        out = []
        for j in self.state.jobs:
            if j.status in CLOSED:
                continue
            lines = self._pick_lines(j)
            if not lines:
                continue
            info = self.job_json(j)
            info.update({"lines": len(lines), "ready_lines": sum(1 for ln in lines if ln["ready"]),
                         "pieces": _n(sum(ln["pick_now"] for ln in lines)),
                         "pending": any(s.kind == "pick" and s.job_no == j.job_no and s.is_open for s in self.data.inbox)})
            out.append(info)
        out.sort(key=lambda r: (-r["ready_lines"] / max(1, r["lines"]), r["due"] or "9999"))
        return out

    def picklist(self, job_no: str) -> dict:
        job = self._job(job_no)
        out = self.job_json(job)
        out["lines"] = self._pick_lines(job)
        return out

    def submit_pick(self, device: Device, job_no: str, lines: list[dict], note: str = "") -> dict:
        self._need(device)
        job = self._job(job_no)
        out = []
        for raw in lines or []:
            try:
                i = int(raw.get("index"))
            except (TypeError, ValueError):
                continue
            if not 0 <= i < len(job.parts):
                continue
            p = job.parts[i]
            qty = min(_qty(raw.get("qty"), allow_zero=True), max(0.0, p.required - p.issued))
            if qty <= 0:
                continue
            item = self._find()(p.code)
            out.append({"index": i, "key": _key(item.code if item else p.code), "code": item.code if item else p.code,
                        "name": p.name, "unit": p.unit, "qty": _n(qty), "location": self._location(p.code, item),
                        "verified": bool(raw.get("verified")), "note": str(raw.get("note") or "")[:120]})
        if not out:
            raise MobileError("ยังไม่มีรายการที่หยิบ")
        sub = Submission(id=secrets.token_hex(6), kind="pick", by=device.name, device=device.id, job_no=job.job_no,
                         lines=out, text=" ".join((note or "").split())[:200])
        self.data.inbox.append(sub)
        self.save()
        self._event("pick", sub)
        return sub.to_json()

    # ---- the inbox on the PC ---------------------------------------------------------------------------
    def _submission(self, sub_id: str) -> Submission:
        sub = next((s for s in self.data.inbox if s.id == sub_id), None)
        if sub is None:
            raise MobileError("ไม่พบรายการ", 404)
        return sub

    def pending(self) -> list[Submission]:
        return [s for s in self.data.inbox if s.is_open]

    def document_for(self, sub: Submission) -> StockDoc:
        """The AJ (count) or PD (pick) a submission makes - not saved."""
        stock = self.state.stock
        if sub.kind == "count":
            lines = [DocLine(ln["code"], ln.get("name", ""), ln["diff"], ln.get("unit", ""), "01", 0,
                             f"นับได้ {ln['counted']:g} (ระบบ {ln['system']:g}) · {sub.by}")
                     for ln in sub.lines if ln.get("diff")]
            for line in lines:
                item = self._find()(line.code)
                if item is not None:
                    line.unit_cost = item.unit_cost
            return StockDoc("AJ", remark=f"ตรวจนับด้วยมือถือ ({sub.by})" + (f" · {sub.text}" if sub.text else ""),
                            lines=lines)
        if sub.kind == "pick":
            parts = [Part(part_no=ln["code"], name=ln.get("name", ""), qty=float(ln["qty"]), unit=ln.get("unit", ""))
                     for ln in sub.lines]
            return StockDoc("PD", job=sub.job_no, remark=f"จ่ายชิ้นส่วนประกอบกระบะ – หยิบด้วยมือถือ ({sub.by})",
                            lines=lines_from_parts(parts, stock))
        raise MobileError("รายการนี้ไม่มีเอกสาร")

    def confirm(self, sub_id: str, by: str = "คอม", post: bool = True) -> StockDoc | None:
        """Count → AJ, pick → PD; posted at once (post=False: a draft for the เบิก / รับ page). A count where every
        line matches makes no document."""
        sub = self._submission(sub_id)
        if not sub.is_open or sub.kind == "problem":
            raise MobileError("รายการนี้ปิดแล้ว" if not sub.is_open else "ใช้ แก้แล้ว กับการแจ้งปัญหา")
        doc = self.document_for(sub)
        if doc.lines:
            if post:
                self.state.post_doc(doc)
                job = next((j for j in self.state.jobs if j.job_no == doc.job), None) if doc.job else None
                if job is not None:
                    mark_document(job, doc)
                    self.state.save_jobs()
                else:
                    self.state.save_library()
            else:
                ledger = self.state.ledger
                doc.doc_no = ledger.next_no(doc.doc_type, doc.date)
                ledger.docs.append(doc)
                self.state.save_library()
            sub.doc_no = doc.doc_no
        sub.status, sub.closed, sub.closed_by = CONFIRMED, _now(), by
        self.save()
        self._event("confirmed", sub)
        return doc if doc.lines else None

    def reject(self, sub_id: str, by: str = "คอม") -> None:
        sub = self._submission(sub_id)
        sub.status, sub.closed, sub.closed_by = REJECTED, _now(), by
        self.save()
        self._event("rejected", sub)

    def my_submissions(self, device: Device, limit: int = 20) -> list[dict]:
        return [s.to_json() for s in self.data.inbox if s.device == device.id][-limit:][::-1]

    # ---- store map ---------------------------------------------------------------------------------------
    def all_locations(self) -> list[str]:
        locs = {v for v in self.state.catalog.locations.values() if v}
        locs |= {(i.location or i.shelf) for i in self.state.stock.items if (i.location or i.shelf)}
        return sorted(locs)

    def set_racks(self, racks) -> None:
        self.data.store_map.racks = list(racks)
        self.save()
        self._event("map")


def _qty(value, allow_zero: bool = False) -> float:
    try:
        q = float(value)
    except (TypeError, ValueError):
        raise MobileError("จำนวนไม่ถูกต้อง") from None
    if math.isnan(q) or q < 0 or (q == 0 and not allow_zero) or q > 1e6:
        raise MobileError("จำนวนไม่ถูกต้อง")
    return q


def _step_order(step: str) -> int:
    return STEPS.index(step) if step in STEPS else 99
