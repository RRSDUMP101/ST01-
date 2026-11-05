"""บันทึกการใช้งาน (audit log): who did what, when, to which document, and what it was before - to answer "why do
the stock or the Express numbers not match?".

One file a month, audit/audit-YYYY-MM.jsonl: one JSON line per action, only ever appended (never rewritten), flushed
to the disk. Each line carries the hash of the line before (a chain): a line changed or taken out later breaks the
chain, and verify() says where. This shows tampering; it cannot stop someone with the files from deleting them all -
keep the copies of the data folder.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
from datetime import datetime
from pathlib import Path

GENESIS = "0" * 64


def _digest(record: dict) -> str:
    body = {k: v for k, v in record.items() if k != "hash"}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


class AuditLog:
    def __init__(self, folder: str | Path):
        self.folder = Path(folder)
        self._last: tuple[int, str] | None = None

    def files(self) -> list[Path]:
        return sorted(self.folder.glob("audit-*.jsonl")) if self.folder.is_dir() else []

    def _tail(self) -> tuple[int, str]:
        if self._last is None:
            seq, prev = 0, GENESIS
            for f in reversed(self.files()):
                lines = [ln for ln in f.read_text(encoding="utf-8").splitlines() if ln.strip()]
                if lines:
                    try:
                        rec = json.loads(lines[-1])
                        seq, prev = int(rec.get("seq", 0)), rec.get("hash", GENESIS)
                    except ValueError:
                        pass
                    break
            self._last = (seq, prev)
        return self._last

    def append(self, actor, action: str, obj_type: str = "", obj_id: str = "", before=None, after=None,
               reason: str = "", source: str = "pc", now: datetime | None = None) -> dict:
        seq, prev = self._tail()
        who = actor.to_json() if hasattr(actor, "to_json") else dict(actor or {})
        rec = {"seq": seq + 1, "ts": (now or datetime.now()).isoformat(timespec="seconds"), "actor": who,
               "host": socket.gethostname(), "action": action, "obj": {"type": obj_type, "id": obj_id},
               "source": source, "prev": prev}
        if before is not None:
            rec["before"] = before
        if after is not None:
            rec["after"] = after
        if reason:
            rec["reason"] = reason
        rec["hash"] = _digest(rec)
        self.folder.mkdir(parents=True, exist_ok=True)
        path = self.folder / f"audit-{rec['ts'][:7]}.jsonl"
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        self._last = (rec["seq"], rec["hash"])
        return rec

    def records(self, limit: int | None = None) -> list[dict]:
        out = []
        for f in self.files():
            for ln in f.read_text(encoding="utf-8").splitlines():
                if ln.strip():
                    try:
                        out.append(json.loads(ln))
                    except ValueError:
                        out.append({"seq": None, "action": "?", "broken": ln[:80]})
        return out[-limit:] if limit else out

    def verify(self) -> list[str]:
        """Problems in the chain ([] = every line is as written)."""
        problems, prev, seq = [], GENESIS, 0
        for rec in self.records():
            if rec.get("seq") is None:
                problems.append(f"บรรทัดเสียหลังลำดับ {seq}")
                continue
            if rec["seq"] != seq + 1:
                problems.append(f"ลำดับขาด: {seq} → {rec['seq']}")
            if rec.get("prev") != prev:
                problems.append(f"ลำดับ {rec['seq']}: ต่อจากบรรทัดก่อนไม่ได้ (มีบรรทัดถูกลบหรือแก้)")
            if _digest(rec) != rec.get("hash"):
                problems.append(f"ลำดับ {rec['seq']}: ถูกแก้ไขหลังบันทึก")
            prev, seq = rec.get("hash", ""), rec["seq"]
        return problems
