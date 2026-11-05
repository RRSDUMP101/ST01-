"""เข้าสู่ระบบ / ผู้ใช้และสิทธิ์: sign-in on the shared PC (name + PIN), the users and their roles, the audit log."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QAbstractItemView, QCheckBox, QDialog, QFormLayout, QGridLayout, QHBoxLayout,
                               QInputDialog, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMessageBox,
                               QPlainTextEdit, QSpinBox, QTabWidget, QTableWidget, QTableWidgetItem, QVBoxLayout,
                               QWidget)

from ..core import access
from ..core.access import ROLES, WHO, Perm
from ..core.users import UserError
from .widgets import button, fit_to_screen


def _pin_edit() -> QLineEdit:
    e = QLineEdit()
    e.setEchoMode(QLineEdit.Password)
    e.setMaxLength(8)
    e.setPlaceholderText("PIN 4–8 หลัก")
    return e


class LoginDialog(QDialog):
    """Pick your name, type your PIN. 'ดูอย่างเดียว' needs no PIN."""

    def __init__(self, state, parent=None):
        super().__init__(parent)
        self.state = state
        self.setWindowTitle("เข้าสู่ระบบ – RRS Part List Studio")
        fit_to_screen(self, 460, 520)
        lay = QVBoxLayout(self)
        title = QLabel("<b style='font-size:15pt'>ใครกำลังใช้คอมเครื่องนี้?</b><br>"
                       "เลือกชื่อแล้วใส่ PIN · ทุกอย่างที่ทำจะบันทึกชื่อไว้")
        title.setWordWrap(True)
        lay.addWidget(title)
        if state.users_problem:
            warn = QLabel(state.users_problem)
            warn.setWordWrap(True)
            warn.setStyleSheet("color:#B42318")
            lay.addWidget(warn)
        self.names = QListWidget()
        for u in state.users.users:
            if u.disabled:
                continue
            roles = ", ".join(ROLES[r][0] for r in u.roles if r in ROLES)
            it = QListWidgetItem(f"{u.name}   ·   {roles}")
            it.setData(Qt.UserRole, u.id)
            self.names.addItem(it)
        self.names.itemDoubleClicked.connect(lambda *_: self.pin.setFocus())
        lay.addWidget(self.names, 1)
        self.pin = _pin_edit()
        self.pin.returnPressed.connect(self.sign_in)
        lay.addWidget(self.pin)
        self.message = QLabel("")
        self.message.setWordWrap(True)
        self.message.setStyleSheet("color:#B42318")
        lay.addWidget(self.message)
        row = QHBoxLayout()
        forgot = button("ลืม PIN ผู้ดูแล…", tooltip="ใช้รหัสกู้คืนที่ได้ตอนสร้างผู้ดูแลคนแรก")
        forgot.clicked.connect(self.recover)
        row.addWidget(forgot)
        row.addStretch(1)
        view = button("ดูอย่างเดียว", tooltip="ดูข้อมูลได้ทุกหน้า แต่แก้ไข/บันทึกไม่ได้")
        view.clicked.connect(self.view_only)
        row.addWidget(view)
        ok = button("เข้าสู่ระบบ", "primary")
        ok.clicked.connect(self.sign_in)
        row.addWidget(ok)
        lay.addLayout(row)
        if self.names.count():
            last = state.settings.get("auth/last_user", "")
            rows = [i for i in range(self.names.count()) if self.names.item(i).data(Qt.UserRole) == last]
            self.names.setCurrentRow(rows[0] if rows else 0)
        self.pin.setFocus()

    def _user_id(self) -> str:
        it = self.names.currentItem()
        return it.data(Qt.UserRole) if it is not None else ""

    def sign_in(self) -> None:
        uid = self._user_id()
        if not uid:
            self.message.setText("เลือกชื่อก่อน")
            return
        try:
            user = self.state.users.check(uid, self.pin.text())
        except UserError as e:
            self.state.log("user.sign_in_failed", "user", uid, reason=str(e), actor=access.SYSTEM)
            self.message.setText(str(e))
            self.pin.clear()
            return
        if user.must_change and not self._change_pin(user.id, "ตั้ง PIN ใหม่ (ผู้ดูแลรีเซ็ตให้)"):
            return
        self.state.settings.set("auth/last_user", user.id)
        self.state.set_actor(access.user_actor(user.id, user.name, user.roles))
        self.accept()

    def _change_pin(self, uid: str, title: str) -> bool:
        while True:
            a, ok = QInputDialog.getText(self, title, "PIN ใหม่ (4–8 หลัก):", QLineEdit.Password)
            if not ok:
                return False
            b, ok = QInputDialog.getText(self, title, "ใส่ PIN ใหม่อีกครั้ง:", QLineEdit.Password)
            if not ok:
                return False
            if a != b:
                QMessageBox.warning(self, title, "PIN สองครั้งไม่ตรงกัน")
                continue
            try:
                self.state.users.set_pin(uid, a)
                return True
            except UserError as e:
                QMessageBox.warning(self, title, str(e))

    def view_only(self) -> None:
        self.state.set_actor(access.VIEWER)
        self.accept()

    def recover(self) -> None:
        admins = self.state.users.admins()
        if not admins:
            return
        names = [u.name for u in admins]
        name, ok = QInputDialog.getItem(self, "กู้ PIN ผู้ดูแล", "ผู้ดูแล", names, 0, False)
        if not ok:
            return
        code, ok = QInputDialog.getText(self, "กู้ PIN ผู้ดูแล", "รหัสกู้คืน (XXXX-XXXX-XXXX-XXXX):")
        if not ok:
            return
        admin = admins[names.index(name)]
        pin, ok = QInputDialog.getText(self, "กู้ PIN ผู้ดูแล", "PIN ใหม่ (4–8 หลัก):", QLineEdit.Password)
        if not ok:
            return
        try:
            self.state.users.recover(code, admin.id, pin)
        except UserError as e:
            self.state.log("user.recover_failed", "user", admin.id, actor=access.SYSTEM)
            QMessageBox.warning(self, "กู้ PIN ผู้ดูแล", str(e))
            return
        self.state.log("user.recover", "user", admin.id, actor=access.SYSTEM)
        QMessageBox.information(self, "กู้ PIN ผู้ดูแล", f"ตั้ง PIN ใหม่ของ {admin.name} แล้ว – เข้าสู่ระบบได้เลย")


class UsersDialog(QDialog):
    """ผู้ใช้และสิทธิ์ (ผู้ดูแล): users, roles, PIN, idle lock, the Express bot save switch, the audit log."""

    def __init__(self, state, parent=None):
        super().__init__(parent)
        self.state = state
        self.setWindowTitle("ผู้ใช้และสิทธิ์")
        fit_to_screen(self, 980, 640)
        lay = QVBoxLayout(self)
        tabs = QTabWidget()
        lay.addWidget(tabs, 1)

        # ---- users ----
        users = QWidget()
        ul = QVBoxLayout(users)
        intro = QLabel("แต่ละคนเข้าสู่ระบบด้วยชื่อ + PIN · บทบาทกำหนดว่าทำอะไรได้ · ยังไม่มีผู้ใช้ = ใช้ได้ทุกอย่างแบบเดิม "
                       "(ไม่บันทึกชื่อ) – เพิ่มผู้ดูแลคนแรกเพื่อเปิดการเข้าสู่ระบบ")
        intro.setWordWrap(True)
        ul.addWidget(intro)
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["ชื่อ", "บทบาท", "สถานะ", "เข้าสู่ระบบล่าสุด", "id"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.horizontalHeader().setStretchLastSection(True)
        for i, w in enumerate([160, 330, 120, 150]):
            self.table.setColumnWidth(i, w)
        ul.addWidget(self.table, 1)
        row = QHBoxLayout()
        for text, slot in (("+ เพิ่มผู้ใช้…", self.add_user), ("บทบาท…", self.edit_roles), ("ตั้ง PIN ใหม่…", self.reset_pin),
                           ("ปิด / เปิดใช้", self.toggle_disabled), ("ปลดล็อก", self.unlock)):
            b = button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        row.addStretch(1)
        ul.addLayout(row)
        roles = QLabel("<br>".join(f"<b>{name}</b>" + (f" ({WHO[key]})" if key in WHO else "") + ": "
                                   + ", ".join(access.PERM_NAMES[p] for p in Perm if p in perms and p != Perm.VIEW)
                                   for key, (name, perms) in ROLES.items()))
        roles.setWordWrap(True)
        roles.setObjectName("Hint")
        ul.addWidget(roles)
        tabs.addTab(users, "ผู้ใช้")

        # ---- settings ----
        opts = QWidget()
        form = QFormLayout(opts)
        self.idle = QSpinBox()
        self.idle.setRange(0, 240)
        self.idle.setSuffix(" นาที (0 = ไม่ล็อก)")
        self.idle.setValue(int(state.settings.get("auth/idle_minutes", "10") or 10))
        form.addRow("ล็อกเมื่อไม่มีคนใช้", self.idle)
        self.allow_save = QCheckBox("ให้บอทคีย์ Express กดบันทึกเองได้ (ไม่แนะนำ – ไม่มีคนตรวจก่อนบันทึก)")
        self.allow_save.setChecked(state.settings.get("express/bot_allow_save", "0") == "1")
        form.addRow("Express", self.allow_save)
        tabs.addTab(opts, "ตั้งค่า")

        # ---- audit ----
        audit = QWidget()
        al = QVBoxLayout(audit)
        self.audit_text = QPlainTextEdit()
        self.audit_text.setReadOnly(True)
        al.addWidget(self.audit_text, 1)
        row = QHBoxLayout()
        verify = button("ตรวจความครบถ้วนของบันทึก")
        verify.clicked.connect(self.verify)
        row.addWidget(verify)
        self.verify_label = QLabel("")
        row.addWidget(self.verify_label, 1)
        al.addLayout(row)
        tabs.addTab(audit, "บันทึกการใช้งาน")

        row = QHBoxLayout()
        row.addStretch(1)
        close = button("ปิด", "primary")
        close.clicked.connect(self.accept)
        row.addWidget(close)
        lay.addLayout(row)
        self.refresh()

    def accept(self) -> None:
        idle = str(self.idle.value())
        if idle != self.state.settings.get("auth/idle_minutes", "10"):
            self.state.settings.set("auth/idle_minutes", idle)
            self.state.log("setting.change", "setting", "auth/idle_minutes", after={"value": idle})
        allow = "1" if self.allow_save.isChecked() else "0"
        if allow != self.state.settings.get("express/bot_allow_save", "0"):
            self.state.settings.set("express/bot_allow_save", allow)
            self.state.log("setting.change", "setting", "express/bot_allow_save", after={"value": allow})
        super().accept()

    def refresh(self) -> None:
        us = self.state.users.users
        self.table.setRowCount(len(us))
        for r, u in enumerate(us):
            locked = self.state.users.locked_for(u)
            status = "ปิดใช้" if u.disabled else (f"ล็อก {int(locked.total_seconds()) // 60 + 1} นาที" if locked else "ใช้งาน")
            for c, v in enumerate([u.name, ", ".join(ROLES[x][0] for x in u.roles if x in ROLES), status,
                                   u.last_login.replace("T", " "), u.id]):
                self.table.setItem(r, c, QTableWidgetItem(v))
        lines = []
        for rec in self.state.audit.records(300)[::-1]:
            who = (rec.get("actor") or {}).get("name", "")
            obj = rec.get("obj") or {}
            extra = " ".join(x for x in (str(rec.get("before", "")) and f"{rec.get('before')} →",
                                         str(rec.get("after", "")) if "after" in rec else "",
                                         f"เหตุผล: {rec['reason']}" if rec.get("reason") else "") if x)
            lines.append(f"{rec.get('ts', '').replace('T', ' ')}  {who:<14} {rec.get('action', '')}  "
                         f"{obj.get('id', '')}  {extra}".rstrip())
        self.audit_text.setPlainText("\n".join(lines) or "ยังไม่มีบันทึก")

    def _uid(self) -> str:
        r = self.table.currentRow()
        return self.table.item(r, 4).text() if r >= 0 and self.table.item(r, 4) else ""

    def _pick_roles(self, title: str, current: list[str]) -> list[str] | None:
        d = QDialog(self)
        d.setWindowTitle(title)
        g = QGridLayout(d)
        boxes = {}
        for i, (key, (name, _p)) in enumerate(ROLES.items()):
            cb = QCheckBox(name + (f"  ({WHO[key]})" if key in WHO else ""))
            cb.setChecked(key in current)
            g.addWidget(cb, i, 0)
            boxes[key] = cb
        ok = button("ตกลง", "primary")
        ok.clicked.connect(d.accept)
        g.addWidget(ok, len(ROLES), 0)
        if d.exec() != QDialog.Accepted:
            return None
        return [k for k, cb in boxes.items() if cb.isChecked()]

    def add_user(self) -> None:
        first = not self.state.users.active
        name, ok = QInputDialog.getText(self, "เพิ่มผู้ใช้", "ชื่อ (เช่น แอน):")
        if not ok or not name.strip():
            return
        roles = ["admin"] if first else self._pick_roles(f"บทบาทของ {name}", ["store"])
        if not roles:
            return
        pin, ok = QInputDialog.getText(self, "เพิ่มผู้ใช้", f"PIN ของ {name} (4–8 หลัก):", QLineEdit.Password)
        if not ok:
            return
        again, ok = QInputDialog.getText(self, "เพิ่มผู้ใช้", "ใส่ PIN อีกครั้ง:", QLineEdit.Password)
        if not ok:
            return
        if pin != again:
            QMessageBox.warning(self, "เพิ่มผู้ใช้", "PIN สองครั้งไม่ตรงกัน")
            return
        try:
            user, code = self.state.users.add(name, roles, pin)
        except UserError as e:
            QMessageBox.warning(self, "เพิ่มผู้ใช้", str(e))
            return
        self.state.log("user.add", "user", user.id, after={"name": user.name, "roles": user.roles})
        if code:
            QMessageBox.information(self, "รหัสกู้คืน – เก็บไว้ที่ปลอดภัย",
                                    f"เปิดการเข้าสู่ระบบแล้ว · {user.name} เป็นผู้ดูแลคนแรก\n\nรหัสกู้คืน (แสดงครั้งเดียว):\n\n"
                                    f"{code}\n\nใช้ตั้ง PIN ผู้ดูแลใหม่เมื่อลืม – จดเก็บไว้นอกคอม · แนะนำให้เพิ่มผู้ดูแลคนที่ 2")
            self.state.set_actor(access.user_actor(user.id, user.name, user.roles))
        self.refresh()

    def edit_roles(self) -> None:
        uid = self._uid()
        user = self.state.users.get(uid)
        if user is None:
            return
        roles = self._pick_roles(f"บทบาทของ {user.name}", user.roles)
        if roles is None:
            return
        before = list(user.roles)
        try:
            self.state.users.set_roles(uid, roles)
        except UserError as e:
            QMessageBox.warning(self, "บทบาท", str(e))
            return
        self.state.log("user.roles", "user", uid, {"roles": before}, {"roles": roles})
        self.refresh()

    def reset_pin(self) -> None:
        uid = self._uid()
        user = self.state.users.get(uid)
        if user is None:
            return
        pin, ok = QInputDialog.getText(self, "ตั้ง PIN ใหม่", f"PIN ชั่วคราวของ {user.name} (ต้องเปลี่ยนเมื่อเข้าครั้งแรก):",
                                       QLineEdit.Password)
        if not ok:
            return
        try:
            self.state.users.set_pin(uid, pin, must_change=uid != self.state.actor.id)
        except UserError as e:
            QMessageBox.warning(self, "ตั้ง PIN ใหม่", str(e))
            return
        self.state.log("user.reset_pin", "user", uid)
        self.refresh()

    def toggle_disabled(self) -> None:
        uid = self._uid()
        user = self.state.users.get(uid)
        if user is None:
            return
        try:
            self.state.users.set_disabled(uid, not user.disabled)
        except UserError as e:
            QMessageBox.warning(self, "ปิดใช้", str(e))
            return
        self.state.log("user.disable" if user.disabled else "user.enable", "user", uid)
        self.refresh()

    def unlock(self) -> None:
        uid = self._uid()
        if uid:
            self.state.users.unlock(uid)
            self.state.log("user.unlock", "user", uid)
            self.refresh()

    def verify(self) -> None:
        problems = self.state.audit.verify()
        self.verify_label.setText("ครบถ้วน – ไม่มีบรรทัดถูกแก้หรือลบ" if not problems else "⚠ " + " · ".join(problems[:5]))
