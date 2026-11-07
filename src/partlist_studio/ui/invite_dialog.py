"""เชิญเครื่องใหม่ (นอกโรงงาน): one link for one phone, sent by LINE - the phone taps it, types a name and starts.
The role (and the name) are set here on the PC; the link works once, until the time chosen, from anywhere
(core/mobile.py MobileService.new_invite)."""

from __future__ import annotations

from PySide6.QtCore import Qt, Slot
from PySide6.QtGui import QGuiApplication, QPixmap
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..core.mobile import ROLES
from .mobile_hub import MobileHub
from .printing import qr_image
from .state import AppState

TIMES = {30: "30 นาที", 120: "2 ชั่วโมง", 24 * 60: "24 ชั่วโมง"}


class InviteDialog(QDialog):
    def __init__(self, state: AppState, hub: MobileHub, parent=None):
        super().__init__(parent)
        self.setObjectName("InviteDialog")
        self.state, self.hub = state, hub
        self.code = ""
        self.link = ""
        self.setWindowTitle("เชิญเครื่องใหม่ (ใช้นอกโรงงาน)")
        self.setMinimumWidth(620)
        lay = QVBoxLayout(self)
        intro = QLabel("ส่งลิงก์เดียวทาง LINE: คนที่ได้รับแตะลิงก์ → ใส่ชื่อ → <b>เริ่มใช้งาน</b> ได้เลย "
                       "ไม่ต้องมาสแกน QR ที่โรงงาน ไม่ต้องพิมพ์รหัส · ลิงก์ใช้ได้ <b>1 เครื่อง</b> ภายในเวลาที่เลือก "
                       "บทบาทกำหนดจากคอมนี้ (มือถือเปลี่ยนเองไม่ได้)")
        intro.setWordWrap(True)
        intro.setObjectName("Hint")
        lay.addWidget(intro)
        form = QFormLayout()
        self.role = QComboBox()
        for key, label in ROLES.items():
            self.role.addItem(label, key)
        self.role.setCurrentIndex(max(0, self.role.findData("viewer")))
        form.addRow("บทบาท", self.role)
        self.name = QLineEdit()
        self.name.setPlaceholderText("ไม่บังคับ เช่น เบนซ์ (ฝ่ายขาย) – ขึ้นให้ในมือถือ แก้ได้")
        self.name.setMaxLength(40)
        form.addRow("ชื่อ", self.name)
        self.minutes = QComboBox()
        for m, label in TIMES.items():
            self.minutes.addItem(label, m)
        self.minutes.setCurrentIndex(1)
        form.addRow("ใช้ได้ภายใน", self.minutes)
        lay.addLayout(form)
        self.make_btn = QPushButton("สร้างลิงก์เชิญ")
        self.make_btn.setProperty("kind", "primary")
        self.make_btn.clicked.connect(self.make)
        lay.addWidget(self.make_btn, 0, Qt.AlignLeft)

        self.result = QWidget()
        res = QHBoxLayout(self.result)
        res.setContentsMargins(0, 8, 0, 0)
        self.qr = QLabel()
        self.qr.setFixedSize(190, 190)
        self.qr.setAlignment(Qt.AlignCenter)
        self.qr.setToolTip("ส่งรูป QR นี้ให้ได้ด้วย (แคปหน้าจอ) – สแกนด้วยกล้องมือถือ")
        res.addWidget(self.qr, 0, Qt.AlignTop)
        right = QVBoxLayout()
        right.addWidget(QLabel("<b>ข้อความเชิญ</b> (คัดลอกไปวางใน LINE)"))
        self.message = QPlainTextEdit()
        self.message.setReadOnly(True)
        self.message.setMinimumHeight(110)
        right.addWidget(self.message, 1)
        self.short_note = QLabel()
        self.short_note.setWordWrap(True)
        self.short_note.setObjectName("Hint")
        right.addWidget(self.short_note)
        row = QHBoxLayout()
        self.copy_btn = QPushButton("คัดลอกข้อความ")
        self.copy_btn.setProperty("kind", "primary")
        self.copy_btn.clicked.connect(self.copy)
        row.addWidget(self.copy_btn)
        self.cancel_btn = QPushButton("ยกเลิกลิงก์นี้")
        self.cancel_btn.setToolTip("ลิงก์ใช้ไม่ได้อีก (เช่น ส่งผิดคน)")
        self.cancel_btn.clicked.connect(self.cancel_invite)
        row.addWidget(self.cancel_btn)
        row.addStretch(1)
        right.addLayout(row)
        res.addLayout(right, 1)
        self.result.setVisible(False)
        lay.addWidget(self.result)
        close = QPushButton("ปิด")
        close.clicked.connect(self.accept)
        lay.addWidget(close, 0, Qt.AlignRight)
        hub.invite_shortened.connect(self._shortened)

    def make(self) -> None:
        if not self.hub.online:
            self.short_note.setText("เปิดออนไลน์ก่อน")
            return
        role = self.role.currentData()
        self.code = self.hub.service.new_invite(role, self.name.text(), self.minutes.currentData())
        self.state.log("device.invite", "device", "", after={"role": role, "name": self.name.text().strip(),
                                                              "minutes": self.minutes.currentData()})
        self.link = self.hub.invite_link(self.code)
        self.result.setVisible(True)
        self.make_btn.setText("สร้างลิงก์เชิญอีกเครื่อง")
        self._show(self.link)
        if self.hub.shorten_invite(self.code):
            self.short_note.setText("กำลังย่อลิงก์ให้สั้น (is.gd)…")
        else:
            self.short_note.setText("")

    def _show(self, link: str) -> None:
        self.message.setPlainText(self.hub.service.invite_message(self.code, link))
        self.qr.setPixmap(QPixmap.fromImage(qr_image(link, 190)))

    @Slot(str, str)
    def _shortened(self, long: str, short: str) -> None:
        if long != self.link or not self.code:
            return
        if short:
            self._show(short)
            self.short_note.setText(f"ลิงก์สั้น {short} พาไปที่ลิงก์เต็มของคำเชิญนี้ · ใช้ได้ครั้งเดียว")
        else:
            self.short_note.setText("ย่อลิงก์ไม่ได้ (ไม่มีอินเทอร์เน็ต หรือ is.gd ไม่ตอบ) – ใช้ลิงก์เต็มได้เหมือนกัน")

    def copy(self) -> None:
        QGuiApplication.clipboard().setText(self.message.toPlainText())
        self.state.notify("คัดลอกข้อความเชิญแล้ว – วางใน LINE ส่งให้คนที่จะใช้ (ลิงก์ใช้ได้ 1 เครื่อง)")

    def cancel_invite(self) -> None:
        if self.code:
            self.hub.service.cancel_invite(self.code)
            self.state.log("device.invite_cancel", "device", "", after={})
        self.code = ""
        self.result.setVisible(False)
        self.make_btn.setText("สร้างลิงก์เชิญ")
        self.state.notify("ยกเลิกลิงก์เชิญแล้ว – ลิงก์นั้นใช้ไม่ได้อีก")

    def done(self, r: int) -> None:
        try:
            self.hub.invite_shortened.disconnect(self._shortened)
        except (RuntimeError, TypeError):
            pass
        super().done(r)
