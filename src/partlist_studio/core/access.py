"""สิทธิ์การใช้งาน: who may do what in the program, the same check for the PC and the phones.

The PC is shared, so people sign in to the program with their name and a PIN (core/users.py); the role decides
what they may do. Checks are made where the data changes (ui/state.py, core/express_out.py, core/mobile.py), not only
by greying out buttons. As long as no user is set up the program works as before (open mode, every right) - an
admin turns sign-in on by adding the first user.

The roles follow the company (skill RRS office operations): สโตร์ (แอน), วางแผนผลิต (แอม), จัดซื้อ (ข้าวฟ้าง),
บัญชี / Express (แป้ง, เป้, เบนซ์), ผู้ดูแล / IT (นุ๊ก, โม), ผลิต / เลเซอร์, ดูอย่างเดียว.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Perm(str, Enum):
    VIEW = "view"
    EXPORT_COST = "export_cost"  # files with ราคาทุน / มูลค่า
    DOC_DRAFT = "doc_draft"  # make / edit draft stock documents
    DOC_POST = "doc_post"  # save PD / OU / RR / FR (stock changes)
    DOC_POST_AJ = "doc_post_aj"  # save a count adjustment (AJ → JU)
    DOC_CANCEL = "doc_cancel"  # cancel a saved document not in Express yet
    DOC_CANCEL_KEYED = "doc_cancel_keyed"  # cancel one already keyed / numbered in Express
    DOC_DELETE_DRAFT = "doc_delete_draft"
    STOCK_SOURCES = "stock_sources"  # import / remove stock sources and items
    STOCK_PARAMS = "stock_params"  # Min/Max, location, remarks of items
    MASTER_CODES = "master_codes"  # code table, Express codes into models, new codes
    PLAN = "plan"  # Part List, models, jobs, laser
    PRODUCTION_RECORD = "production_record"
    PHONE_CONFIRM = "phone_confirm"  # confirm what phones sent (counts, picks, stock requests)
    EXPRESS_KEY = "express_key"  # run the keying bot, export the outbox
    EXPRESS_NUMBER = "express_number"  # enter / import Express numbers
    EXPRESS_CONFIG = "express_config"  # bot templates, window, the switch that allows a save key
    DEVICE_ADMIN = "device_admin"  # pair / revoke phones, roles of phones, certificates, ports
    ONLINE = "online"  # the link from outside, its token
    GSHEETS_CONFIG = "gsheets_config"
    GSHEETS_PUSH_COST = "gsheets_push_cost"
    SETTINGS_ADMIN = "settings_admin"
    USERS = "users"
    RESTORE = "restore"


P = Perm
_VIEW = {P.VIEW}
_PRODUCTION = _VIEW | {P.PRODUCTION_RECORD, P.DOC_DRAFT}
_STORE = _PRODUCTION | {P.DOC_POST, P.DOC_CANCEL, P.DOC_DELETE_DRAFT, P.STOCK_SOURCES, P.PHONE_CONFIRM,
                        P.EXPORT_COST}
_PLANNER = _PRODUCTION | {P.PLAN, P.DOC_DELETE_DRAFT}
_PURCHASING = _PRODUCTION | {P.STOCK_PARAMS, P.MASTER_CODES, P.EXPORT_COST}
_ACCOUNTING = _VIEW | {P.DOC_DRAFT, P.DOC_POST, P.DOC_POST_AJ, P.DOC_CANCEL, P.DOC_CANCEL_KEYED, P.EXPRESS_KEY,
                       P.EXPRESS_NUMBER, P.MASTER_CODES, P.STOCK_SOURCES, P.EXPORT_COST, P.GSHEETS_PUSH_COST}
ALL = frozenset(Perm)

ROLES: dict[str, tuple[str, frozenset[Perm]]] = {
    "viewer": ("ดูอย่างเดียว", frozenset(_VIEW)),
    "production": ("ผลิต / เลเซอร์", frozenset(_PRODUCTION)),
    "store": ("สโตร์ / คลัง", frozenset(_STORE)),
    "planner": ("วางแผนผลิต", frozenset(_PLANNER)),
    "purchasing": ("จัดซื้อ", frozenset(_PURCHASING)),
    "accounting": ("บัญชี / Express", frozenset(_ACCOUNTING)),
    "admin": ("ผู้ดูแล / IT", ALL),
}
WHO = {"store": "แอน", "planner": "แอม", "purchasing": "ข้าวฟ้าง", "accounting": "แป้ง, เป้, เบนซ์", "admin": "นุ๊ก, โม"}
PERM_NAMES = {
    P.VIEW: "ดูข้อมูล", P.EXPORT_COST: "ส่งออกไฟล์ที่มีราคาทุน", P.DOC_DRAFT: "ทำใบร่าง", P.DOC_POST: "บันทึกใบเบิก/รับ",
    P.DOC_POST_AJ: "บันทึกใบปรับยอด (ตรวจนับ)", P.DOC_CANCEL: "ยกเลิกเอกสาร",
    P.DOC_CANCEL_KEYED: "ยกเลิกเอกสารที่เข้า Express แล้ว", P.DOC_DELETE_DRAFT: "ลบใบร่าง",
    P.STOCK_SOURCES: "นำเข้า/ลบแหล่งสต็อก", P.STOCK_PARAMS: "แก้ Min/Max ตำแหน่ง", P.MASTER_CODES: "แก้ตารางรหัส",
    P.PLAN: "วางแผนผลิต/เลเซอร์", P.PRODUCTION_RECORD: "บันทึกผลผลิต", P.PHONE_CONFIRM: "ยืนยันงานจากมือถือ",
    P.EXPRESS_KEY: "คีย์เข้า Express", P.EXPRESS_NUMBER: "ใส่เลขที่ Express", P.EXPRESS_CONFIG: "ตั้งค่าการคีย์ Express",
    P.DEVICE_ADMIN: "จัดการมือถือ", P.ONLINE: "ลิงก์ออนไลน์", P.GSHEETS_CONFIG: "ตั้งค่า Google Sheets",
    P.GSHEETS_PUSH_COST: "ส่งราคาทุนขึ้น Google Sheet", P.SETTINGS_ADMIN: "ตั้งค่าโปรแกรม", P.USERS: "จัดการผู้ใช้",
    P.RESTORE: "กู้ข้อมูลจากสำเนา",
}
# phones request; nothing from a phone changes stock without a person on the PC (PHONE_CONFIRM)
PHONE_ROLE_PERMS = {"viewer": frozenset(_VIEW), "station": frozenset({P.VIEW, P.PRODUCTION_RECORD}),
                    "store": frozenset({P.VIEW, P.PRODUCTION_RECORD, P.DOC_DRAFT}),
                    "planner": frozenset({P.VIEW, P.PRODUCTION_RECORD, P.DOC_DRAFT, P.PLAN})}


@dataclass(frozen=True)
class Actor:
    id: str
    name: str
    roles: tuple[str, ...] = ()
    kind: str = "pc"  # pc | phone | system | open
    device_id: str = ""
    perms: frozenset = field(default=frozenset(), compare=False)

    @property
    def label(self) -> str:
        role = ", ".join(ROLES[r][0] for r in self.roles if r in ROLES)
        return f"{self.name} ({role})" if role else self.name

    def to_json(self) -> dict:
        return {"id": self.id, "name": self.name, "kind": self.kind, **({"device_id": self.device_id}
                                                                       if self.device_id else {})}


def perms_of(roles) -> frozenset:
    out: set = set()
    for r in roles:
        out |= ROLES.get(r, ("", frozenset()))[1]
    return frozenset(out)


def user_actor(user_id: str, name: str, roles) -> Actor:
    roles = tuple(r for r in roles if r in ROLES)
    return Actor(user_id, name, roles, "pc", perms=perms_of(roles))


OPEN = Actor("open", "ไม่ระบุผู้ใช้", ("admin",), "open", perms=ALL)  # no user set up yet: as before
VIEWER = Actor("viewer", "ดูอย่างเดียว", ("viewer",), "pc", perms=perms_of(["viewer"]))
SYSTEM = Actor("system", "ระบบ", (), "system", perms=frozenset({P.VIEW}))


def phone_actor(device) -> Actor:
    role = getattr(device, "role", "viewer")
    return Actor(f"phone:{device.id}", getattr(device, "name", "") or device.id, (role,), "phone", device.id,
                 PHONE_ROLE_PERMS.get(role, frozenset(_VIEW)))


class AccessDenied(PermissionError):
    def __init__(self, perm: Perm, actor: Actor | None = None):
        who = [ROLES[r][0] for r, (_n, ps) in ROLES.items() if perm in ps and r != "admin"] + [ROLES["admin"][0]]
        super().__init__(f"ไม่มีสิทธิ์ {PERM_NAMES.get(perm, perm.value)} – ต้องเป็น {' / '.join(who)}"
                         + (f" (ตอนนี้: {actor.label})" if actor else ""))
        self.perm = perm


def can(actor: Actor | None, perm: Perm) -> bool:
    return actor is not None and perm in actor.perms


def require(actor: Actor | None, perm: Perm) -> None:
    if not can(actor, perm):
        raise AccessDenied(perm, actor)
