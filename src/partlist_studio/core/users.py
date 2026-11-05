"""ผู้ใช้ของโปรแกรมบนคอมเครื่องเดียวกัน: a name, roles and a PIN (4-8 digits). The PIN is kept only as a salted
PBKDF2-SHA256 hash; 5 wrong PINs lock the name for 1 minute, doubling up to 15 minutes. A recovery code (shown once
when the first admin is made) resets an admin PIN when both admins forgot theirs.

Honest limits: this is a guard for a shared factory PC, not a vault - whoever can copy users.json can try PINs
offline. It records who did what and keeps people to their part of the work.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import fileio
from .access import ROLES

ITERATIONS = 200_000
MAX_TRIES = 5
FIRST_LOCK = timedelta(minutes=1)
LONGEST_LOCK = timedelta(minutes=15)


class UserError(ValueError):
    pass


def _hash(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), bytes.fromhex(salt), ITERATIONS).hex()


def check_pin_format(pin: str) -> None:
    if not (pin.isdigit() and 4 <= len(pin) <= 8):
        raise UserError("PIN ต้องเป็นตัวเลข 4–8 หลัก")
    if len(set(pin)) == 1 or pin in "0123456789" or pin in "9876543210":
        raise UserError("PIN ง่ายเกินไป (ตัวเลขซ้ำ/เรียงกัน)")


@dataclass
class User:
    id: str
    name: str
    roles: list[str] = field(default_factory=list)
    pin_salt: str = ""
    pin_hash: str = ""
    must_change: bool = False
    disabled: bool = False
    failed: int = 0
    locks: int = 0
    locked_until: str = ""
    created: str = ""
    last_login: str = ""


@dataclass
class UserStore:
    path: Path
    users: list[User] = field(default_factory=list)
    recovery_hash: str = ""
    recovery_salt: str = ""

    # ---- file ---------------------------------------------------------------------------------
    @classmethod
    def load(cls, path: str | Path) -> UserStore:
        path = Path(path)
        store = cls(path)
        if not path.is_file():
            return store
        data = json.loads(path.read_text(encoding="utf-8"))  # a broken file is an error, never "no users"
        store.users = [User(**{k: v for k, v in u.items() if k in User.__dataclass_fields__})
                       for u in data.get("users", [])]
        store.recovery_hash = data.get("recovery_hash", "")
        store.recovery_salt = data.get("recovery_salt", "")
        return store

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fileio.atomic_write_text(self.path, json.dumps(
            {"users": [asdict(u) for u in self.users], "recovery_hash": self.recovery_hash,
             "recovery_salt": self.recovery_salt}, ensure_ascii=False, indent=1))

    # ---- people -------------------------------------------------------------------------------
    @property
    def active(self) -> bool:
        """Sign-in is on once there is a user."""
        return bool(self.users)

    def get(self, user_id: str) -> User | None:
        return next((u for u in self.users if u.id == user_id), None)

    def admins(self) -> list[User]:
        return [u for u in self.users if "admin" in u.roles and not u.disabled]

    def add(self, name: str, roles, pin: str, now: datetime | None = None) -> tuple[User, str]:
        """A new user; the first one must be an admin and gets the recovery code (returned once, else '')."""
        name = " ".join((name or "").split())
        if not name:
            raise UserError("ใส่ชื่อผู้ใช้")
        if any(u.name.lower() == name.lower() for u in self.users):
            raise UserError(f"มีชื่อ {name} แล้ว")
        roles = [r for r in roles if r in ROLES]
        if not roles:
            raise UserError("เลือกบทบาทอย่างน้อย 1 อย่าง")
        if not self.users and "admin" not in roles:
            raise UserError("ผู้ใช้คนแรกต้องเป็น ผู้ดูแล / IT")
        check_pin_format(pin)
        user = User(secrets.token_hex(4), name, roles, created=(now or datetime.now()).isoformat(timespec="seconds"))
        self._set_pin(user, pin)
        code = ""
        if not self.users:
            code = "-".join(secrets.token_hex(2).upper() for _ in range(4))
            self.recovery_salt = secrets.token_hex(16)
            self.recovery_hash = _hash(code.replace("-", ""), self.recovery_salt)
        self.users.append(user)
        self.save()
        return user, code

    def _set_pin(self, user: User, pin: str) -> None:
        user.pin_salt = secrets.token_hex(16)
        user.pin_hash = _hash(pin, user.pin_salt)
        user.failed, user.locks, user.locked_until = 0, 0, ""

    def set_pin(self, user_id: str, pin: str, must_change: bool = False) -> None:
        user = self._user(user_id)
        check_pin_format(pin)
        self._set_pin(user, pin)
        user.must_change = must_change
        self.save()

    def set_roles(self, user_id: str, roles) -> None:
        user = self._user(user_id)
        roles = [r for r in roles if r in ROLES]
        if not roles:
            raise UserError("เลือกบทบาทอย่างน้อย 1 อย่าง")
        if "admin" in user.roles and "admin" not in roles and len(self.admins()) <= 1:
            raise UserError("ต้องมีผู้ดูแลอย่างน้อย 1 คน")
        user.roles = roles
        self.save()

    def set_disabled(self, user_id: str, disabled: bool) -> None:
        user = self._user(user_id)
        if disabled and "admin" in user.roles and len(self.admins()) <= 1:
            raise UserError("ปิดผู้ดูแลคนสุดท้ายไม่ได้")
        user.disabled = disabled
        self.save()

    def unlock(self, user_id: str) -> None:
        user = self._user(user_id)
        user.failed, user.locks, user.locked_until = 0, 0, ""
        self.save()

    def _user(self, user_id: str) -> User:
        user = self.get(user_id)
        if user is None:
            raise UserError("ไม่พบผู้ใช้")
        return user

    # ---- sign in ------------------------------------------------------------------------------
    def locked_for(self, user: User, now: datetime | None = None) -> timedelta:
        if not user.locked_until:
            return timedelta(0)
        left = datetime.fromisoformat(user.locked_until) - (now or datetime.now())
        return max(left, timedelta(0))

    def check(self, user_id: str, pin: str, now: datetime | None = None) -> User:
        """The user when the PIN is right; UserError otherwise (wrong, locked, disabled)."""
        now = now or datetime.now()
        user = self._user(user_id)
        if user.disabled:
            raise UserError("ผู้ใช้นี้ถูกปิดอยู่ – ติดต่อผู้ดูแล")
        left = self.locked_for(user, now)
        if left:
            raise UserError(f"ล็อกอยู่ – ลองใหม่ใน {int(left.total_seconds()) // 60 + 1} นาที")
        if user.pin_hash and hmac.compare_digest(_hash(pin, user.pin_salt), user.pin_hash):
            user.failed, user.locks, user.locked_until = 0, 0, ""
            user.last_login = now.isoformat(timespec="seconds")
            self.save()
            return user
        user.failed += 1
        msg = "PIN ไม่ถูกต้อง"
        if user.failed >= MAX_TRIES:
            wait = min(FIRST_LOCK * (2 ** user.locks), LONGEST_LOCK)
            user.locks += 1
            user.failed = 0
            user.locked_until = (now + wait).isoformat(timespec="seconds")
            msg += f" {MAX_TRIES} ครั้ง – ล็อก {int(wait.total_seconds() // 60)} นาที"
        else:
            msg += f" (เหลือ {MAX_TRIES - user.failed} ครั้ง)"
        self.save()
        raise UserError(msg)

    def recover(self, code: str, admin_id: str, new_pin: str) -> None:
        """Reset an admin's PIN with the recovery code."""
        code = (code or "").replace("-", "").replace(" ", "").upper()
        if not self.recovery_hash or not hmac.compare_digest(_hash(code, self.recovery_salt), self.recovery_hash):
            raise UserError("รหัสกู้คืนไม่ถูกต้อง")
        user = self._user(admin_id)
        if "admin" not in user.roles:
            raise UserError("รหัสกู้คืนใช้ได้กับผู้ดูแลเท่านั้น")
        self.set_pin(admin_id, new_pin)
