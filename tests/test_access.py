"""สิทธิ์การใช้งาน: roles, PIN users, the audit log, safe saves of the company data."""

import json
from datetime import datetime, timedelta

import pytest

from partlist_studio.core import access, fileio
from partlist_studio.core.access import Perm
from partlist_studio.core.audit import AuditLog
from partlist_studio.core.users import UserError, UserStore


def test_roles_follow_the_company():
    store = access.user_actor("u1", "แอน", ["store"])
    acct = access.user_actor("u2", "เป้", ["accounting"])
    assert access.can(store, Perm.DOC_POST) and not access.can(store, Perm.DOC_POST_AJ)  # counts: accounting saves
    assert not access.can(store, Perm.EXPRESS_KEY) and not access.can(store, Perm.EXPRESS_NUMBER)
    assert access.can(acct, Perm.EXPRESS_KEY) and access.can(acct, Perm.DOC_CANCEL_KEYED)
    assert not access.can(acct, Perm.EXPRESS_CONFIG) and not access.can(acct, Perm.USERS)
    assert access.can(access.user_actor("u3", "นุ๊ก", ["admin"]), Perm.EXPRESS_CONFIG)
    both = access.user_actor("u4", "x", ["store", "purchasing"])
    assert access.can(both, Perm.STOCK_PARAMS) and access.can(both, Perm.DOC_POST)  # roles add up
    assert not access.can(access.VIEWER, Perm.DOC_DRAFT) and access.can(access.OPEN, Perm.USERS)
    with pytest.raises(access.AccessDenied, match="บัญชี"):
        access.require(store, Perm.EXPRESS_NUMBER)


def test_users_pin_lockout_and_recovery(tmp_path):
    s = UserStore.load(tmp_path / "users.json")
    assert not s.active
    with pytest.raises(UserError, match="ผู้ดูแล"):
        s.add("แอน", ["store"], "4821")  # the first user is an admin
    admin, code = s.add("นุ๊ก", ["admin"], "4821")
    assert code and s.active
    with pytest.raises(UserError):
        s.add("แอน", ["store"], "1111")  # too easy
    ann, again = s.add("แอน", ["store"], "7351")
    assert again == ""
    raw = (tmp_path / "users.json").read_text(encoding="utf-8")
    assert "7351" not in raw and "4821" not in raw  # only salted hashes are kept
    assert s.check(ann.id, "7351").name == "แอน"
    now = datetime(2026, 11, 5, 9, 0)
    for _ in range(4):
        with pytest.raises(UserError, match="เหลือ"):
            s.check(ann.id, "0000", now)
    with pytest.raises(UserError, match="ล็อก 1 นาที"):
        s.check(ann.id, "0000", now)
    with pytest.raises(UserError, match="ล็อกอยู่"):
        s.check(ann.id, "7351", now + timedelta(seconds=30))  # even the right PIN waits
    assert s.check(ann.id, "7351", now + timedelta(minutes=2)).name == "แอน"
    with pytest.raises(UserError):
        s.set_roles(admin.id, ["store"])  # the last admin stays an admin
    with pytest.raises(UserError, match="รหัสกู้คืน"):
        s.recover("AAAA-BBBB-CCCC-DDDD", admin.id, "5927")
    s.recover(code.lower(), admin.id, "5927")
    again = UserStore.load(tmp_path / "users.json")
    assert again.check(admin.id, "5927").roles == ["admin"]
    (tmp_path / "bad.json").write_text("{broken", encoding="utf-8")
    with pytest.raises(ValueError):
        UserStore.load(tmp_path / "bad.json")  # a broken file is an error, never "no users = open"


def test_audit_log_chain_shows_tampering(tmp_path):
    log = AuditLog(tmp_path / "audit")
    who = access.user_actor("u1", "แอน", ["store"])
    log.append(who, "doc.post", "doc", "PD6911-0001", after={"lines": 2})
    log.append(who, "doc.express_no", "doc", "PD6911-0001", {"express_no": ""}, {"express_no": "PD0000526"})
    AuditLog(tmp_path / "audit").append(who, "doc.cancel", "doc", "PD6911-0001", reason="เบิกผิด")  # a new start goes on
    recs = log.records()
    assert [r["seq"] for r in recs] == [1, 2, 3] and recs[2]["reason"] == "เบิกผิด" and log.verify() == []
    f = log.files()[0]
    lines = f.read_text(encoding="utf-8").splitlines()
    edited = json.loads(lines[1])
    edited["after"]["express_no"] = "PD0000999"
    f.write_text("\n".join([lines[0], json.dumps(edited, ensure_ascii=False, sort_keys=True), lines[2]]) + "\n",
                 encoding="utf-8")
    assert any("แก้ไข" in p for p in log.verify())
    f.write_text("\n".join([lines[0], lines[2]]) + "\n", encoding="utf-8")  # a line taken out
    assert any("ลำดับขาด" in p or "ต่อจาก" in p for p in log.verify())


def test_safe_saves_and_backups(tmp_path):
    p = tmp_path / "library.json"
    fileio.atomic_write_text(p, '{"a": 1}')
    assert json.loads(p.read_text()) == {"a": 1} and not (tmp_path / "library.json.tmp").exists()
    day = datetime(2026, 11, 5).date()
    for i in range(16):
        fileio.backup_daily(p, keep=14, today=day + timedelta(days=i))
    assert len(list((tmp_path / "backups").glob("library-*.json"))) == 14
    assert fileio.backups(p)[0].name == "library-20261120.json"
    bad = fileio.set_aside(p)
    assert bad.name.startswith("library.corrupt-") and not p.exists()


def test_app_state_survives_a_broken_library(tmp_path, monkeypatch):
    from PySide6 import QtWidgets

    QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    from partlist_studio.core.movements import DocLine
    from partlist_studio.ui.state import AppState

    data = tmp_path / "data"
    state = AppState(data_dir=data)
    assert state.actor is access.OPEN and not state.signin_on  # no users: works as before
    doc = state.ledger.new_doc("OU", [DocLine("A1", "a", 1)])
    state.post_doc(doc)
    state.save_library()
    state.save_library()
    assert (data / "library.json.bak").is_file()
    (data / "library.json").write_text('{"ledger": {"docs": [', encoding="utf-8")  # cut off by a power cut
    again = AppState(data_dir=data)
    assert "อ่านข้อมูล" in again.library_problem and "สำเนา" in again.library_problem
    assert [d.doc_no for d in again.ledger.docs] == [doc.doc_no]  # read from the copy
    assert list(data.glob("library.corrupt-*.json"))
    for f in [data / "library.json", data / "library.json.bak", *(data / "backups").glob("*.json")]:
        f.write_text("not json", encoding="utf-8")
    lost = AppState(data_dir=data)
    assert lost._library_load_failed and not lost.ledger.docs
    lost.save_library()  # refuses: nothing empty is written in place of the company data
    assert not (data / "library.json").exists() and len(list(data.glob("library.corrupt-*.json"))) == 2


def test_permissions_in_app_state(tmp_path):
    from PySide6 import QtWidgets

    QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    from partlist_studio.core.movements import DocLine
    from partlist_studio.ui.state import AppState

    state = AppState(data_dir=tmp_path / "d")
    admin, _code = state.users.add("นุ๊ก", ["admin"], "4821")
    ann, _ = state.users.add("แอน", ["store"], "7351")
    state.set_actor(access.user_actor(ann.id, ann.name, ann.roles))
    doc = state.ledger.new_doc("PD", [DocLine("A1", "a", 1)])
    state.post_doc(doc)
    assert doc.posted_by == "แอน"
    aj = state.ledger.new_doc("AJ", [DocLine("A1", "a", -1)])
    with pytest.raises(access.AccessDenied):
        state.post_doc(aj)  # the store counts, accounting saves the adjustment
    with pytest.raises(access.AccessDenied):
        state.set_express_no(doc, "PD0000526")
    state.set_actor(access.user_actor("u9", "เป้", ["accounting"]))
    assert state.set_express_no(doc, "pd0000526") and doc.express_no == "PD0000526" and doc.express_no_by == "เป้"
    state.set_actor(access.user_actor(ann.id, ann.name, ann.roles))
    with pytest.raises(access.AccessDenied):
        state.cancel_doc(doc, "ผิด")  # in Express already: accounting cancels, in Express too
    state.set_actor(access.user_actor("u9", "เป้", ["accounting"]))
    state.cancel_doc(doc, "เบิกผิดงาน")
    assert doc.void_in_express and doc.cancel_reason == "เบิกผิดงาน" and doc.cancelled_by == "เป้"
    with pytest.raises(ValueError):
        state.set_express_no(doc, "PD0000527")  # cancelled
    actions = [r["action"] for r in state.audit.records()]
    assert {"doc.post", "doc.express_no", "doc.cancel"} <= set(actions) and state.audit.verify() == []
