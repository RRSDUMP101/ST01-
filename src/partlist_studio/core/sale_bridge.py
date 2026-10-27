"""Durable, outbound-only Sale Office bridge. No access to legacy library.json.

SQLite is authoritative only for jobs imported by this bridge. Every accepted
command, job and outbound event is committed together; replay cannot duplicate a job.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .production import Job, JOB_OPEN, JOB_CANCELLED, job_from_parts

MAX_COMMAND_BYTES = 256_000
MAX_PARTS = 1000
RELEASE_LEASE_SECONDS = 900


class BridgeConflict(ValueError):
    """A newer command or desktop save exists; reload before editing."""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _id(value: Any, name: str, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"Invalid {name}")
    return value


def validate_command(command: dict) -> dict:
    if not isinstance(command, dict) or len(_json(command).encode()) > MAX_COMMAND_BYTES:
        raise ValueError("Invalid command size")
    if command.get("schemaVersion") != 1 or command.get("type") != "upsert_draft":
        raise ValueError("Unsupported command version/type")
    if command.get("workspace") not in ("domestic", "export"):
        raise ValueError("Invalid workspace")
    for name in ("commandId", "orderId", "productionJobId"):
        _id(command.get(name), name)
    version = command.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError("Invalid command version")
    digest = command.get("payloadHash", "")
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("Invalid payloadHash")
    p = command.get("payload")
    if not isinstance(p, dict):
        raise ValueError("Missing payload")
    _id(p.get("orderNumber"), "orderNumber")
    for name in ("customerId", "dealId", "customerName", "vehicle", "due", "owner"):
        if p.get(name) is not None and (not isinstance(p[name], str) or len(p[name]) > 30000):
            raise ValueError(f"Invalid {name}")
    if not isinstance(p.get("items"), list) or not 1 <= len(p["items"]) <= MAX_PARTS:
        raise ValueError("Invalid items")
    ids = set()
    for item in p["items"]:
        if not isinstance(item, dict):
            raise ValueError("Invalid item")
        line = _id(item.get("lineId"), "lineId")
        if line in ids:
            raise ValueError("Duplicate lineId")
        ids.add(line)
        try:
            qty = float(item["qty"])
        except (TypeError, ValueError, KeyError):
            raise ValueError("Invalid quantity") from None
        if not isinstance(item["qty"], str) or not math.isfinite(qty) or qty <= 0:
            raise ValueError("Invalid quantity")
        for name in ("description", "unit", "productId"):
            if not isinstance(item.get(name), str) or len(item[name]) > (30001 if name == "description" else 30000):
                raise ValueError(f"Invalid item {name}")
    rel = p.get("release")
    if not isinstance(rel, dict) or not isinstance(rel.get("allowed"), bool):
        raise ValueError("Missing release gate")
    if not isinstance(rel.get("blockers"), list) or not all(isinstance(x, str) for x in rel["blockers"]):
        raise ValueError("Invalid release blockers")
    if not isinstance(p.get("cancelled"), bool):
        raise ValueError("Missing cancellation state")
    return command


def job_work_blockers(job: Job, now: float | None = None) -> list[str]:
    """Only bridge-managed jobs are gated. Legacy jobs retain existing behavior."""
    b = job.bridge
    if not b:
        return []
    now = time.time() if now is None else now
    blockers = []
    if b.get("payload", {}).get("cancelled") or job.status == JOB_CANCELLED:
        blockers.append("SO ถูกยกเลิก — รอตรวจผลกระทบ")
    if not job.parts or job.sets <= 0:
        blockers.append("รอผูก BOM และยืนยันจำนวนชุด")
    if not b.get("releaseAllowed"):
        blockers.extend(b.get("payload", {}).get("release", {}).get("blockers") or ["รอ Sale Office อนุญาตเริ่มผลิต"])
    if not b.get("revisionApproved") or b.get("bomRevision") != b.get("releaseBomRevision") or b.get("drawingRevision") != b.get("releaseDrawingRevision"):
        blockers.append("รออนุมัติแบบ/BOM ฉบับที่ผูกกับงานนี้")
    if job.parts and bom_fingerprint(job) != b.get("releaseBomFingerprint"):
        blockers.append("BOM ปัจจุบันไม่ตรงฉบับที่ได้รับอนุมัติ")
    if b.get("impactRequired"):
        blockers.append("SO เปลี่ยน — รอตรวจผลกระทบและผูก BOM ใหม่")
    if now - float(b.get("releaseAt", 0)) > RELEASE_LEASE_SECONDS:
        blockers.append("ข้อมูลอนุญาตเริ่มผลิตเกิน 15 นาที — เชื่อม Sale Office เพื่อตรวจใหม่")
    return list(dict.fromkeys(blockers))


def bind_partlist(job: Job, partlist, sets: float, bom_revision: str, drawing_revision: str,
                  reviewer: str, evidence: str) -> Job:
    """Prepare an explicit BOM proposal; only the cloud approval releases work."""
    if not job.bridge:
        raise ValueError("เลือกงานจาก Sale Office")
    if job.log or any(p.done or p.received or p.issued or p.from_stock for p in job.parts):
        raise BridgeConflict("งานเริ่มแล้ว — ตรวจผลกระทบการเปลี่ยนแบบก่อน")
    if not math.isfinite(sets) or sets <= 0 or sets > 1e6:
        raise ValueError("ยืนยันจำนวนชุดที่ต้องผลิต")
    if not partlist.parts or len(partlist.parts) > MAX_PARTS:
        raise ValueError("ไม่มี Part List หรือมีรายการมากเกินไป")
    for name, val in (("BOM revision", bom_revision), ("Drawing revision", drawing_revision),
                      ("reviewer", reviewer), ("evidence", evidence)):
        _id(val, name)
    units = {}
    for p in partlist.parts:
        code = p.stock_code or p.part_no
        if code in units and units[code] != (p.unit or "ชิ้น"):
            raise ValueError("รหัสชิ้นส่วนเดียวกันใช้หน่วยต่างกัน — ตรวจ mapping ก่อน")
        units[code] = p.unit or "ชิ้น"
        if not (p.stock_code or p.part_no) or not math.isfinite(p.qty) or p.qty <= 0:
            raise ValueError("ชิ้นส่วนต้องมีรหัสและจำนวนที่ตรวจแล้ว")
    # No automatic stock reservation from an unverified stock snapshot.
    proposal = job_from_parts(job.job_no, partlist.parts, sets, use_stock=False,
                              customer=job.customer, vehicle=job.vehicle, due=job.due,
                              model=partlist.info.drawing_no or partlist.info.job_type,
                              title=job.title, remark=job.remark)
    proposal.bridge = copy.deepcopy(job.bridge)
    proposal.bridge["impactRequired"] = False
    proposal.bridge.update(bomRevision=bom_revision.strip(), drawingRevision=drawing_revision.strip(),
                           revisionReviewer=reviewer.strip(), revisionEvidence=evidence.strip(),
                           revisionApproved=False, releaseAllowed=False)
    return proposal


def bom_fingerprint(job: Job) -> str:
    # Excludes mutable progress counters and filesystem paths. Stable native order is significant.
    values = {"sets": job.sets, "parts": [{k: getattr(p, k) for k in
              ("item_no", "code", "drawing_code", "drawing_no", "name", "qty_per_set", "required",
               "route", "unit", "spec", "material", "thickness")} for p in job.parts]}
    return hashlib.sha256(_json(values).encode()).hexdigest()


def status_for_job(job: Job, version: int) -> dict:
    b = job.bridge
    waiting = sorted({step for p in job.parts for step, qty in p.waiting().items() if qty > 0})
    grouped = {}
    for i, p in enumerate(job.parts):
        key = p.code or p.drawing_code or str(i + 1)
        part = grouped.setdefault(key, {"partId": key, "required": 0, "reserved": 0,
                                       "shortage": None, "unit": p.unit, "completed": 0, "stationDone": {}})
        if part["unit"] != p.unit:
            raise ValueError("Inconsistent units for identical part ID")
        part["required"] += p.required
        part["reserved"] += p.from_stock
        part["completed"] += p.finished
        for station, qty in p.done.items():
            part["stationDone"][station] = part["stationDone"].get(station, 0) + qty
    parts = list(grouped.values())
    return {"externalJobId": b["key"], "sourceVersion": version,
            "bomRevision": b.get("bomRevision") or None, "drawingRevision": b.get("drawingRevision") or None,
            "bomFingerprint": bom_fingerprint(job) if job.parts else None,
            "revisionApproved": bool(b.get("revisionApproved")),
            "revisionEvidence": b.get("revisionEvidence") or None,
            "materialStatus": "unknown", "parts": parts,
            "station": ", ".join(waiting) or None,
            # Parts have different units and no verified QC/scrap/rework model.
            "good": None, "scrap": None, "rework": None,
            "blockers": job_work_blockers(job), "eta": None,
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


class BridgeStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            if db.execute("PRAGMA user_version").fetchone()[0] > 1:
                raise ValueError("Bridge database was created by a newer application")
            db.executescript("""
            CREATE TABLE IF NOT EXISTS bridge_jobs (
              key TEXT PRIMARY KEY, workspace TEXT NOT NULL, order_id TEXT NOT NULL,
              production_id TEXT NOT NULL, command_id TEXT NOT NULL, command_version INTEGER NOT NULL,
              payload_hash TEXT NOT NULL, command_json TEXT NOT NULL, job_json TEXT NOT NULL,
              local_version INTEGER NOT NULL, UNIQUE(workspace,order_id));
            CREATE TABLE IF NOT EXISTS bridge_commands (
              id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, received_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS bridge_outbox (
              id TEXT PRIMARY KEY, job_key TEXT NOT NULL, payload TEXT NOT NULL,
              state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
              next_attempt REAL NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS bridge_outbox_due ON bridge_outbox(state,next_attempt);
            CREATE TABLE IF NOT EXISTS bridge_issues (
              id INTEGER PRIMARY KEY, created_at REAL NOT NULL, code TEXT NOT NULL,
              detail TEXT NOT NULL, UNIQUE(code,detail));
            CREATE TABLE IF NOT EXISTS bridge_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            PRAGMA user_version=1;
            """)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=15000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def _event(self, db, job: Job, command: dict, version: int) -> None:
        event = {"eventId": str(uuid.uuid4()), "commandId": command["commandId"],
                 "commandVersion": command["version"], "payloadHash": command["payloadHash"],
                 "workspace": command["workspace"], "orderId": command["orderId"],
                 "productionJobId": command["productionJobId"], "status": status_for_job(job, version)}
        db.execute("INSERT INTO bridge_outbox(id,job_key,payload,created_at) VALUES (?,?,?,?)",
                   (event["eventId"], job.bridge["key"], _json(event), time.time()))

    def apply_command(self, command: dict, expected_workspace: str | None = None) -> str:
        c = validate_command(command)
        if expected_workspace and c["workspace"] != expected_workspace:
            raise ValueError("Workspace mismatch")
        key = "pls:" + hashlib.sha256((c["workspace"] + "\0" + c["orderId"]).encode()).hexdigest()[:32]
        fingerprint = hashlib.sha256(_json(c).encode()).hexdigest()
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            duplicate = db.execute("SELECT fingerprint FROM bridge_commands WHERE id=?", (c["commandId"],)).fetchone()
            if duplicate:
                if duplicate[0] != fingerprint:
                    raise BridgeConflict("Command ID reused with different payload")
                # A successful HTTPS poll renews the short release lease, but cannot change a gate.
                row = db.execute("SELECT job_json FROM bridge_jobs WHERE key=?", (key,)).fetchone()
                if row:
                    current = Job.from_dict(json.loads(row[0]))
                    if current.bridge.get("commandId") == c["commandId"]:
                        current.bridge["releaseAt"] = time.time()
                        db.execute("UPDATE bridge_jobs SET job_json=? WHERE key=?", (_json(current.to_dict()), key))
                return key
            old = db.execute("SELECT * FROM bridge_jobs WHERE key=?", (key,)).fetchone()
            if old and (c["productionJobId"] != old["production_id"] or c["version"] <= old["command_version"]):
                raise BridgeConflict("Stale command or changed production identity")
            p = c["payload"]
            if old:
                job = Job.from_dict(json.loads(old["job_json"]))
                old_payload = json.loads(old["command_json"])["payload"]
                changed = any(old_payload.get(k) != p.get(k) for k in ("items", "vehicle", "customerId"))
                if changed and (job.parts or job.log):
                    db.execute("INSERT OR IGNORE INTO bridge_issues(created_at,code,detail) VALUES(?,?,?)",
                               (time.time(), "order_changed", key + ": ตรวจผลกระทบ SO ที่เปลี่ยนก่อนผูก BOM ใหม่"))
                    job.bridge["impactRequired"] = True
            else:
                # All source lines retained; never guess which sales line represents beds.
                job = Job(job_no="PLS-" + key.removeprefix("pls:")[:16], sets=0)
                job.bridge = {"key": key, "bomRevision": "", "drawingRevision": "",
                              "revisionEvidence": "", "revisionReviewer": "", "revisionApproved": False}
            rel = p["release"]
            matched = bool(job.parts and job.bridge.get("bomRevision") and job.bridge.get("drawingRevision")
                           and job.bridge.get("bomRevision") == rel.get("bomRevision")
                           and job.bridge.get("drawingRevision") == rel.get("drawingRevision")
                           and bom_fingerprint(job) == rel.get("bomFingerprint"))
            job.customer = p.get("customerName") or ""
            job.vehicle = p.get("vehicle") or ""
            job.due = (p.get("due") or "")[:10]
            job.title = p["orderNumber"]
            job.remark = "\n".join(f'{x["description"]} · {x["qty"]} {x["unit"]}' for x in p["items"])
            job.bridge.update(workspace=c["workspace"], orderId=c["orderId"], productionJobId=c["productionJobId"],
                              commandId=c["commandId"], commandVersion=c["version"], payloadHash=c["payloadHash"],
                              payload=p, releaseAllowed=rel["allowed"] and matched and not job.bridge.get("impactRequired"),
                              releaseBomRevision=rel.get("bomRevision"), releaseDrawingRevision=rel.get("drawingRevision"),
                              releaseBomFingerprint=rel.get("bomFingerprint"),
                              revisionApproved=matched and rel["allowed"], releaseAt=time.time())
            if p["cancelled"]:
                job.status = JOB_CANCELLED
            version = (old["local_version"] if old else 0) + 1
            job.bridge["localVersion"] = version
            db.execute("INSERT INTO bridge_commands VALUES(?,?,?)", (c["commandId"], fingerprint, time.time()))
            db.execute("INSERT OR REPLACE INTO bridge_jobs VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (key, c["workspace"], c["orderId"], c["productionJobId"], c["commandId"], c["version"],
                        c["payloadHash"], _json(c), _json(job.to_dict()), version))
            db.execute("UPDATE bridge_outbox SET state='superseded' WHERE job_key=? AND state='pending'", (key,))
            self._event(db, job, c, version)
        return key

    def jobs(self) -> list[Job]:
        with self._db() as db:
            return [Job.from_dict(json.loads(r[0])) for r in db.execute("SELECT job_json FROM bridge_jobs ORDER BY rowid")]

    def save_job(self, job: Job) -> None:
        b = job.bridge
        if not b:
            raise ValueError("Not a bridge job")
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM bridge_jobs WHERE key=?", (b["key"],)).fetchone()
            if not row or row["local_version"] != b.get("localVersion"):
                raise BridgeConflict("ข้อมูลมีการเปลี่ยนแปลง — โหลดงานล่าสุดก่อนบันทึก")
            old = Job.from_dict(json.loads(row["job_json"]))
            # Lease renewal is not a desktop edit and never causes a compare-and-swap conflict.
            b["releaseAt"] = old.bridge.get("releaseAt", 0)
            if old.to_dict() == job.to_dict():
                return
            # Sales owns identity/terms; desktop only owns BOM/progress. Never overwrite a cloud gate.
            for k in ("workspace", "orderId", "productionJobId", "commandId", "commandVersion", "payloadHash", "payload"):
                if b.get(k) != old.bridge.get(k):
                    raise BridgeConflict("Source fields are owned by Sale Office")
            if any(getattr(job, k) != getattr(old, k) for k in ("customer", "vehicle", "due", "job_no", "title")):
                raise BridgeConflict("Source fields are owned by Sale Office")
            for k in ("releaseBomRevision", "releaseDrawingRevision", "releaseBomFingerprint"):
                if b.get(k) != old.bridge.get(k):
                    raise BridgeConflict("Only Sale Office may change release authority")
            changed_work = job.log != old.log or [(p.done, p.received, p.issued) for p in job.parts] != [(p.done, p.received, p.issued) for p in old.parts]
            if changed_work and (job.log or any(p.done or p.received or p.issued for p in job.parts)) and job_work_blockers(old):
                raise BridgeConflict("ยังไม่ผ่านเงื่อนไขปล่อยผลิต")
            if [p.from_stock for p in job.parts] != [p.from_stock for p in old.parts] and any(p.from_stock for p in job.parts):
                raise BridgeConflict("Stock reservation awaits transactional stock integration")
            if bom_fingerprint(job) != bom_fingerprint(old) and (old.log or any(p.done or p.received or p.issued for p in old.parts)):
                raise BridgeConflict("งานเริ่มแล้ว — ต้องตรวจผลกระทบก่อนเปลี่ยน BOM")
            for part in job.parts:
                quantities = [part.required, part.from_stock, part.received, part.issued, *part.done.values()]
                if any(isinstance(q, bool) or not isinstance(q, (int, float)) or not math.isfinite(q) or q < 0 for q in quantities):
                    raise ValueError("Invalid part quantities")
                if any(q > part.required for q in [part.from_stock, part.received, part.issued, part.finished, *part.done.values()]):
                    raise ValueError("Part progress exceeds required quantity")
            if bom_fingerprint(job) != bom_fingerprint(old) or b.get("bomRevision") != old.bridge.get("bomRevision") or b.get("drawingRevision") != old.bridge.get("drawingRevision"):
                b["releaseAllowed"] = False
                b["revisionApproved"] = False
            elif (not old.bridge.get("releaseAllowed") and b.get("releaseAllowed")) or (not old.bridge.get("revisionApproved") and b.get("revisionApproved")):
                raise BridgeConflict("Only Sale Office may release production")
            version = row["local_version"] + 1
            b["localVersion"] = version
            db.execute("UPDATE bridge_jobs SET job_json=?,local_version=? WHERE key=?",
                       (_json(job.to_dict()), version, b["key"]))
            self._event(db, job, json.loads(row["command_json"]), version)

    def pending(self, limit: int = 50, now: float | None = None, workspace: str | None = None) -> list[dict]:
        with self._db() as db:
            return [dict(r) for r in db.execute("""SELECT o.* FROM bridge_outbox o JOIN bridge_jobs j ON j.key=o.job_key
                WHERE o.state='pending' AND o.next_attempt<=? AND (? IS NULL OR j.workspace=?)
                ORDER BY o.created_at LIMIT ?""", (time.time() if now is None else now, workspace, workspace, limit))]

    def acknowledge(self, event_id: str) -> None:
        with self._db() as db:
            db.execute("UPDATE bridge_outbox SET state='sent',last_error='' WHERE id=?", (event_id,))

    def reject(self, event_id: str, code: str, retry: bool = True) -> None:
        with self._db() as db:
            row = db.execute("SELECT attempts FROM bridge_outbox WHERE id=?", (event_id,)).fetchone()
            if not row:
                return
            attempts = row[0] + 1
            state = "pending" if retry and attempts < 10 else "dead"
            db.execute("UPDATE bridge_outbox SET state=?,attempts=?,next_attempt=?,last_error=? WHERE id=?",
                       (state, attempts, time.time() + min(3600, 5 * 2 ** min(attempts, 10)), code[:100], event_id))

    def issue(self, code: str, detail: str) -> None:
        with self._db() as db:
            db.execute("INSERT OR IGNORE INTO bridge_issues(created_at,code,detail) VALUES(?,?,?)",
                       (time.time(), code[:100], detail[:1000]))

    def meta(self, key: str, value: str) -> None:
        with self._db() as db:
            db.execute("INSERT OR REPLACE INTO bridge_meta VALUES(?,?)", (key, value))

    def sync_summary(self) -> dict:
        with self._db() as db:
            counts = dict(db.execute("SELECT state,COUNT(*) FROM bridge_outbox GROUP BY state"))
            meta = dict(db.execute("SELECT key,value FROM bridge_meta"))
            conflicts = db.execute("SELECT COUNT(*) FROM bridge_issues").fetchone()[0]
            return {"pending": counts.get("pending", 0), "dead": counts.get("dead", 0), "conflict": conflicts,
                    "lastSuccess": meta.get("lastSuccess", ""), "lastError": meta.get("lastError", ""),
                    "configured": meta.get("configured") == "true"}

    def issues(self) -> list[dict]:
        with self._db() as db:
            entries = [{"createdAt": r["created_at"], "code": r["code"], "detail": r["detail"]}
                       for r in db.execute("SELECT * FROM bridge_issues ORDER BY id DESC LIMIT 50")]
            entries += [{"createdAt": r["created_at"], "code": r["last_error"],
                         "detail": r["job_key"] + " · " + r["state"] + " · attempts=" + str(r["attempts"])}
                        for r in db.execute("SELECT * FROM bridge_outbox WHERE state IN ('pending','dead') AND last_error<>'' ORDER BY created_at DESC LIMIT 50")]
            return entries

    def retry_failed(self) -> int:
        """Operator-initiated retry of current transient failures; never replay stale authority."""
        with self._db() as db:
            cursor = db.execute("""UPDATE bridge_outbox SET state='pending',attempts=0,next_attempt=0
                WHERE state='dead' AND last_error IN ('network_unavailable','http_408','http_429','http_500','http_502','http_503','http_504','missing_acknowledgment')
                AND EXISTS (SELECT 1 FROM bridge_jobs j WHERE j.key=bridge_outbox.job_key
                    AND j.command_id=json_extract(bridge_outbox.payload,'$.commandId'))""")
            return cursor.rowcount
