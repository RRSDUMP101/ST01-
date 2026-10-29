"""มือถือ & AR: the mobile app for phones and tablets on the factory Wi-Fi - turn it on, pair the phones with a QR,
the phones paired, what they sent (counts, picks, problems) to confirm, the store map for the AR guidance and the
location labels."""

from __future__ import annotations

from datetime import datetime

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QColor, QGuiApplication, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QMessageBox,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ...core import certs
from ...core.mobile import KIND_NAMES, ROLES
from ...core.production import STEPS
from ...core.qr import location_payload
from ...core.store_map import Rack, parse_location, racks_from_locations
from .. import theme
from ..mobile_hub import MobileHub
from ..printing import open_document, qr_image, write_location_labels_pdf
from ..state import AppState
from ..widgets import Card, PageHeader, button, empty_hint, fill, selected_rows, table

RACK_HEADERS = ["รหัสชั้นวาง", "ชื่อ", "ทางเดิน", "ฝั่ง", "ลำดับจากทางเข้า", "จำนวนชั้น", "ช่องต่อชั้น", "ชั้น 1 อยู่ล่าง",
                "เลขช่อง ซ้าย→ขวา"]
SIDE_TEXT = {"L": "ซ้าย", "R": "ขวา"}


def _when(iso: str) -> str:
    try:
        d = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return iso or ""
    return f"{d.day:02d}/{d.month:02d}/{d.year + 543} {d:%H:%M}"


class StoreMapView(QWidget):
    """The store from above: aisles from the entrance, the racks along them."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.racks: list[Rack] = []
        self.setMinimumHeight(220)

    def set_racks(self, racks: list[Rack]) -> None:
        self.racks = list(racks)
        self.update()

    def paintEvent(self, _event):  # noqa: N802 - Qt API
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.fillRect(self.rect(), QColor("#F7F9FC"))
        if not self.racks:
            p.setPen(QColor(theme.MUTED))
            p.drawText(self.rect(), Qt.AlignCenter, "ยังไม่มีผังสโตร์ – กด หาชั้นวางจากตำแหน่งเก็บ หรือ เพิ่มชั้นวาง")
            p.end()
            return
        aisles = sorted({r.aisle for r in self.racks})
        deep = max(r.order for r in self.racks)
        w, h = self.width(), self.height()
        col = min(200.0, (w - 20) / max(1, len(aisles)))
        row = min(84.0, (h - 50) / max(1, deep))
        p.setPen(Qt.NoPen)
        p.setBrush(QColor("#FDE7D2"))
        p.drawRect(0, h - 22, w, 22)
        p.setPen(QColor(theme.MUTED))
        p.drawText(0, h - 22, w, 22, Qt.AlignCenter, "ทางเข้าสโตร์")
        for i, aisle in enumerate(aisles):
            x = 10 + i * col
            p.setPen(Qt.NoPen)
            p.setBrush(QColor("#E4E9F1"))
            p.drawRoundedRect(int(x + col * 0.38), 6, int(col * 0.24), int(h - 34), 6, 6)
            p.setPen(QColor(theme.MUTED))
            p.drawText(int(x + col * 0.38), 8, int(col * 0.24), 18, Qt.AlignCenter, str(aisle))
            for r in (r for r in self.racks if r.aisle == aisle):
                y = h - 30 - r.order * row
                rx = x if r.side == "L" else x + col * 0.64
                box = (int(rx), int(y), int(col * 0.36), int(row - 8))
                p.setPen(QPen(QColor(theme.NAVY), 1.5))
                p.setBrush(QColor("#FFFFFF"))
                p.drawRoundedRect(*box, 5, 5)
                font = p.font()
                font.setPointSizeF(max(6.5, min(9.0, font.pointSizeF())))
                p.setFont(font)
                p.setPen(QColor(theme.TEXT))
                p.drawText(*box, Qt.AlignCenter | Qt.TextWordWrap, r.code.split("-", 1)[-1] + (f"\n{r.levels}×{r.slots}" if r.slots else ""))
        p.end()


class MobilePage(QWidget):
    def __init__(self, state: AppState, actions, hub: MobileHub | None = None, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.hub = hub or MobileHub(state)
        self._filling = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        head = PageHeader("มือถือ & AR", "แอปบนมือถือ / แท็บเล็ต (Android · iPhone · iPad) ผ่าน Wi-Fi ในโรงงาน – "
                                          "ติดตามการผลิต · สแกน AR นับสต็อก · หยิบของนำทางด้วย AR")
        self.status = QLabel()
        self.status.setObjectName("StatusChip")
        head.add_action(self.status)
        self.toggle_btn = button("เปิดใช้งานมือถือ", "primary", "เปิด/ปิดการเชื่อมต่อของมือถือกับโปรแกรมนี้")
        self.toggle_btn.clicked.connect(self.toggle)
        head.add_action(self.toggle_btn)
        lay.addWidget(head)
        self.tabs = QTabWidget()
        self.tabs.addTab(self._connect_tab(), "เชื่อมต่อมือถือ")
        self.tabs.addTab(self._devices_tab(), "อุปกรณ์")
        self.tabs.addTab(self._inbox_tab(), "งานจากมือถือ")
        self.tabs.addTab(self._map_tab(), "ผังสโตร์ (AR)")
        lay.addWidget(self.tabs, 1)
        self.hub.changed.connect(self.refresh)
        self.hub.event.connect(self._phone_event)
        self.clock = QTimer(self)
        self.clock.setInterval(1000)
        self.clock.timeout.connect(self._tick)
        self.clock.start()
        self.refresh()

    # ---- เชื่อมต่อ ------------------------------------------------------------------------------------
    def _connect_tab(self) -> QWidget:
        w = QWidget()
        grid = QHBoxLayout(w)
        grid.setContentsMargins(0, 10, 0, 0)
        grid.setSpacing(14)
        qr = Card("สแกนด้วยกล้องมือถือ")
        self.qr = QLabel()
        self.qr.setAlignment(Qt.AlignCenter)
        self.qr.setMinimumSize(280, 280)
        qr.body.addWidget(self.qr, 1)
        self.code = QLabel()
        self.code.setAlignment(Qt.AlignCenter)
        self.code.setStyleSheet(f"font-size: 22pt; font-weight: 800; letter-spacing: 4px; color: {theme.NAVY};")
        qr.body.addWidget(self.code)
        self.code_left = QLabel()
        self.code_left.setAlignment(Qt.AlignCenter)
        self.code_left.setObjectName("PageSub")
        qr.body.addWidget(self.code_left)
        row = QHBoxLayout()
        self.new_code_btn = button("สร้างรหัสจับคู่ใหม่", tooltip="รหัสใช้ได้ 15 นาที จับคู่ได้หลายเครื่อง")
        self.new_code_btn.clicked.connect(self.new_code)
        row.addWidget(self.new_code_btn)
        self.copy_btn = button("คัดลอกลิงก์", tooltip="ส่งลิงก์ให้มือถือทาง LINE / อีเมล")
        self.copy_btn.clicked.connect(self.copy_link)
        row.addWidget(self.copy_btn)
        qr.body.addLayout(row)
        self.address = QComboBox()
        self.address.setToolTip("ถ้าคอมมีหลายเครือข่าย เลือกเครือข่ายเดียวกับ Wi-Fi ของมือถือ")
        self.address.currentIndexChanged.connect(self._show_qr)
        qr.body.addWidget(self.address)
        grid.addWidget(qr, 0)

        right = QVBoxLayout()
        steps = Card("ขั้นตอน (ครั้งแรกของแต่ละเครื่อง)")
        text = QLabel(
            "<ol style='margin-left:-20px'>"
            "<li>ต่อมือถือ/แท็บเล็ตเข้า <b>Wi-Fi เดียวกับคอมเครื่องนี้</b></li>"
            "<li>เปิดกล้องมือถือ <b>สแกน QR</b> ทางซ้าย → หน้าติดตั้งจะเปิดขึ้น</li>"
            "<li>กด <b>ดาวน์โหลดใบรับรอง</b> แล้วติดตั้งตามขั้นตอนบนจอ (ครั้งเดียว – ให้แอปใช้กล้องได้)</li>"
            "<li>กด <b>เปิดแอปมือถือ</b> → ใส่ชื่อ เลือกบทบาท → <b>เริ่มใช้งาน</b></li>"
            "<li>เพิ่มลงหน้าจอหลัก: iPhone ปุ่มแชร์ → <i>เพิ่มไปยังหน้าจอโฮม</i> · Android ⋮ → <i>ติดตั้งแอป</i></li></ol>"
            "<p style='color:#6B7A90'>ข้อมูลทั้งหมดอยู่ในคอมเครื่องนี้ มือถือไม่เก็บสำเนา · คอมต้องเปิดโปรแกรมไว้ขณะใช้งาน · "
            "ถ้า Windows ถามเรื่องไฟร์วอลล์ ให้กด <b>อนุญาต</b> (เครือข่ายส่วนตัว)</p>")
        text.setWordWrap(True)
        text.setTextFormat(Qt.RichText)
        steps.body.addWidget(text)
        right.addWidget(steps)
        opts = Card("ตั้งค่า")
        form = QFormLayout()
        self.port = QSpinBox()
        self.port.setRange(1024, 65535)
        self.port.setValue(int(self.hub.option("port")))
        form.addRow("พอร์ตแอป (https)", self.port)
        self.http_port = QSpinBox()
        self.http_port.setRange(1024, 65535)
        self.http_port.setValue(int(self.hub.option("http_port")))
        form.addRow("พอร์ตหน้าติดตั้ง (http)", self.http_port)
        self.autostart = QCheckBox("เปิดใช้งานมือถือทุกครั้งที่เปิดโปรแกรม")
        self.autostart.setChecked(bool(self.hub.option("autostart")))
        self.autostart.toggled.connect(self._autostart_toggled)
        form.addRow("", self.autostart)
        opts.body.addLayout(form)
        apply_btn = button("ใช้พอร์ตใหม่", tooltip="บันทึกพอร์ต แล้วเปิดการเชื่อมต่อใหม่")
        apply_btn.clicked.connect(self.apply_ports)
        opts.body.addWidget(apply_btn, 0, Qt.AlignLeft)
        right.addWidget(opts)
        cert = Card("ใบรับรองของเครื่องนี้")
        self.cert_info = QLabel()
        self.cert_info.setWordWrap(True)
        self.cert_info.setTextInteractionFlags(Qt.TextSelectableByMouse)
        cert.body.addWidget(self.cert_info)
        renew = button("สร้างใบรับรองใหม่…", tooltip="ใช้เมื่อคอมเปลี่ยนเครื่อง/ใบรับรองรั่วไหล – มือถือทุกเครื่องต้องติดตั้งใหม่")
        renew.clicked.connect(self.renew_cert)
        cert.body.addWidget(renew, 0, Qt.AlignLeft)
        right.addWidget(cert)
        right.addStretch(1)
        side = QWidget()
        side.setLayout(right)
        right.setContentsMargins(0, 0, 4, 0)
        scroll = QScrollArea()  # the three cards are taller than a 1366 x 768 screen
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        scroll.setWidget(side)
        grid.addWidget(scroll, 1)
        return w

    # ---- อุปกรณ์ ----------------------------------------------------------------------------------------
    def _devices_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 10, 0, 0)
        row = QHBoxLayout()
        self.role_btn = button("เปลี่ยนบทบาท…", tooltip="หน้างานผลิต / สโตร์ / วางแผน / ดูอย่างเดียว")
        self.role_btn.clicked.connect(self.change_role)
        row.addWidget(self.role_btn)
        self.station_btn = button("ตั้งสถานี…", tooltip="สถานีที่คนนี้ทำงาน (คิวของฉันในหน้าแรกของแอป)")
        self.station_btn.clicked.connect(self.change_station)
        row.addWidget(self.station_btn)
        self.revoke_btn = button("ยกเลิกสิทธิ์ / คืนสิทธิ์", tooltip="เครื่องที่ถูกยกเลิกใช้แอปไม่ได้จนกว่าจะคืนสิทธิ์")
        self.revoke_btn.clicked.connect(self.toggle_revoke)
        row.addWidget(self.revoke_btn)
        self.remove_btn = button("ลบเครื่อง", "danger", "ลบออกจากรายการ (ต้องจับคู่ใหม่ถ้าจะใช้อีก)")
        self.remove_btn.clicked.connect(self.remove_device)
        row.addWidget(self.remove_btn)
        row.addStretch(1)
        lay.addLayout(row)
        self.devices = table(["ชื่อ", "บทบาท", "สถานี", "ใช้ล่าสุด", "IP", "จับคู่เมื่อ", "สถานะ"], [180, 150, 90, 140, 120, 140])
        empty_hint(self.devices, "ยังไม่มีมือถือที่จับคู่ – สแกน QR ในแท็บ เชื่อมต่อมือถือ")
        self.devices.itemSelectionChanged.connect(self._device_buttons)
        lay.addWidget(self.devices, 1)
        return w

    # ---- งานจากมือถือ ---------------------------------------------------------------------------------------
    def _inbox_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 10, 0, 0)
        row = QHBoxLayout()
        self.inbox_filter = QComboBox()
        self.inbox_filter.addItem("รอดำเนินการ", "open")
        self.inbox_filter.addItem("ทั้งหมด", "all")
        self.inbox_filter.currentIndexChanged.connect(self._fill_inbox)
        row.addWidget(self.inbox_filter)
        self.confirm_btn = button("ยืนยัน → บันทึกเอกสาร", "primary",
                                  "นับสต็อก → ใบปรับยอด AJ (เฉพาะส่วนต่าง) · หยิบของ → ใบ PD จ่ายชิ้นส่วนประกอบกระบะ – ยอดเปลี่ยนทันที")
        self.confirm_btn.clicked.connect(self.confirm_post)
        row.addWidget(self.confirm_btn)
        self.draft_btn = button("ยืนยันเป็นร่าง", tooltip="สร้างเอกสารร่างไว้ตรวจในหน้า เบิก / รับ สต็อก ก่อนบันทึก")
        self.draft_btn.clicked.connect(self.confirm_draft)
        row.addWidget(self.draft_btn)
        self.reject_btn = button("ไม่ใช้", tooltip="ปิดรายการโดยไม่ทำเอกสาร")
        self.reject_btn.clicked.connect(self.reject)
        row.addWidget(self.reject_btn)
        self.solve_btn = button("แก้แล้ว", tooltip="ปิดการแจ้งปัญหา")
        self.solve_btn.clicked.connect(self.solve)
        row.addWidget(self.solve_btn)
        row.addStretch(1)
        lay.addLayout(row)
        split = QSplitter(Qt.Vertical)
        self.inbox = table(["เวลา", "ประเภท", "จาก", "งาน / รายละเอียด", "สถานะ", "เอกสาร"], [140, 100, 140, 420, 100])
        empty_hint(self.inbox, "ยังไม่มีรายการจากมือถือ – ผลนับสต็อก การหยิบของ และการแจ้งปัญหาจะขึ้นที่นี่")
        self.inbox.itemSelectionChanged.connect(self._show_lines)
        split.addWidget(self.inbox)
        self.lines = table(["รหัส", "รายการ", "ตำแหน่ง", "นับได้ / หยิบ", "ในระบบตอนนับ", "ต่าง", "ยอดตอนนี้", "หมายเหตุ"],
                           [160, 240, 100, 100, 110, 80, 100])
        split.addWidget(self.lines)
        split.setSizes([300, 220])
        lay.addWidget(split, 1)
        return w

    # ---- ผังสโตร์ --------------------------------------------------------------------------------------------
    def _map_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 10, 0, 0)
        hint = QLabel("ตำแหน่งเก็บเขียนแบบ <b>โซน-ชั้นวาง-ช่อง</b> เช่น <b>P-POST-04</b> (ชั้นวาง P-POST ช่อง 4) · ตั้งชั้นวางที่นี่ให้ AR "
                      "ชี้ทางจากป้ายที่กล้องเห็นไปยังช่องของชิ้นที่ต้องหยิบ (ซ้าย/ขวา · ขึ้น/ลง) · เลขช่องเรียงตามชั้นล่างก่อน "
                      "เช่น 4 ช่องต่อชั้น: ช่อง 5 = ชั้นที่ 2 ช่องแรก")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        row = QHBoxLayout()
        auto = button("หาชั้นวางจากตำแหน่งเก็บ", tooltip="เพิ่มชั้นวางจากตำแหน่งเก็บที่ตั้งไว้แล้วในสโตร์ (ที่ยังไม่มีในผัง)")
        auto.clicked.connect(self.auto_racks)
        row.addWidget(auto)
        add = button("เพิ่มชั้นวาง")
        add.clicked.connect(self.add_rack)
        row.addWidget(add)
        self.del_rack_btn = button("ลบชั้นวางที่เลือก", "danger")
        self.del_rack_btn.clicked.connect(self.remove_racks)
        row.addWidget(self.del_rack_btn)
        row.addStretch(1)
        self.per_page = QComboBox()
        for n, text in ((4, "4 ป้าย/A4 (A6)"), (2, "2 ป้าย/A4 (A5)"), (1, "1 ป้าย/A4"), (8, "8 ป้าย/A4")):
            self.per_page.addItem(text, n)
        row.addWidget(self.per_page)
        labels = button("พิมพ์ป้ายตำแหน่ง (QR ใหญ่)…", "primary", "ป้ายทุกช่องของชั้นวางที่เลือก (ไม่เลือก = ทุกชั้นวาง) – ติดที่ช่องให้ AR อ่านได้จากระยะไกล")
        labels.clicked.connect(self.print_labels)
        row.addWidget(labels)
        lay.addLayout(row)
        split = QSplitter(Qt.Horizontal)
        self.racks = table(RACK_HEADERS, [110, 150, 70, 60, 110, 80, 80, 90, 110], editable=True)
        empty_hint(self.racks, "ยังไม่มีชั้นวางในผัง – กด หาชั้นวางจากตำแหน่งเก็บ")
        self.racks.itemChanged.connect(self._rack_edited)
        split.addWidget(self.racks)
        self.map_view = StoreMapView()
        split.addWidget(self.map_view)
        split.setSizes([760, 340])
        lay.addWidget(split, 1)
        return w

    # ---- show --------------------------------------------------------------------------------------------------
    def refresh(self) -> None:
        running = self.hub.running
        self.toggle_btn.setText("ปิดการเชื่อมต่อมือถือ" if running else "เปิดใช้งานมือถือ")
        self.toggle_btn.setProperty("kind", "" if running else "primary")
        self.toggle_btn.style().unpolish(self.toggle_btn)
        self.toggle_btn.style().polish(self.toggle_btn)
        if running:
            n = len(self.hub.service.data.devices)
            self.status.setText(f"● เปิดอยู่ · {self.hub.app_url(self._ip())} · {n} เครื่อง")
            color = theme.STATUS_COLORS["พร้อม"]
        else:
            self.status.setText("ปิดอยู่" + (f" – {self.hub.error}" if self.hub.error else ""))
            color = theme.STATUS_COLORS["ขาด"] if self.hub.error else theme.MUTED
        self.status.setStyleSheet(f"QLabel#StatusChip {{ background: {color}; }}")
        current = self._ip()
        self.address.blockSignals(True)
        self.address.clear()
        for ip in self.hub.addresses():
            self.address.addItem(f"คอมเครื่องนี้: {ip}", ip)
        if current:
            self.address.setCurrentIndex(max(0, self.address.findData(current)))
        self.address.setVisible(self.address.count() > 1)
        self.address.blockSignals(False)
        self.new_code_btn.setEnabled(running)
        self.copy_btn.setEnabled(running)
        self._show_qr()
        self._fill_devices()
        self._fill_inbox()
        self._fill_racks()
        info = certs.info(self.hub.folder / "certs")
        if info["ca"]:
            self.cert_info.setText(f"ใบรับรองหลัก ใช้ได้ถึง {info['ca_until']}<br>ใบรับรองเซิร์ฟเวอร์ ถึง {info['server_until']} "
                                   f"({', '.join(info['server_ips'])})<br><span style='color:#6B7A90'>ลายนิ้วมือ SHA-256: "
                                   f"{info['ca_fingerprint'][:47]}…</span>")
        else:
            self.cert_info.setText("ยังไม่มี – สร้างให้อัตโนมัติเมื่อเปิดใช้งานมือถือครั้งแรก")
        pending = self.hub.pending()
        self.tabs.setTabText(2, f"งานจากมือถือ ({pending})" if pending else "งานจากมือถือ")
        window = self.window()
        if hasattr(window, "set_nav_badge"):
            window.set_nav_badge("mobile", pending)

    def _ip(self) -> str:
        data = self.address.currentData() if self.address.count() else None
        return data or (self.hub.addresses()[0] if self.hub.addresses() else "")

    def _show_qr(self, *_args) -> None:
        if not self.hub.running:
            self.qr.setPixmap(QPixmap())
            self.qr.setText("กด เปิดใช้งานมือถือ ก่อน")
            self.code.setText("")
            self.code_left.setText("")
            return
        url = self.hub.setup_url(self._ip())
        self.qr.setPixmap(QPixmap.fromImage(qr_image(url, 300)))
        self.qr.setToolTip(url)
        code = self.hub.service.pair_code if self.hub.service.pairing_open else ""
        self.code.setText(f"{code[:4]} {code[4:]}" if code else "")
        self._tick()

    def _tick(self) -> None:
        if not self.hub.running:
            return
        s = self.hub.service
        if s.pairing_open and s.pair_expires is not None:
            left = int((s.pair_expires - datetime.now()).total_seconds())
            self.code_left.setText(f"รหัสจับคู่ใช้ได้อีก {left // 60}:{left % 60:02d} นาที · {self.hub.setup_url(self._ip())}")
        else:
            if self.code.text():
                self.code.setText("")
                self.qr.setPixmap(QPixmap.fromImage(qr_image(self.hub.setup_url(self._ip()), 300)))
            self.code_left.setText("รหัสหมดเวลา – กด สร้างรหัสจับคู่ใหม่ (เครื่องที่จับคู่แล้วใช้ต่อได้)")

    def _fill_devices(self) -> None:
        devices = self.hub.service.data.devices
        rows = [[d.name, ROLES.get(d.role, d.role), d.station or "-", _when(d.last_seen), d.last_ip, _when(d.created),
                 "ยกเลิกสิทธิ์" if d.revoked else "ใช้งาน"] for d in devices]
        selected = {devices[r].id for r in selected_rows(self.devices) if r < len(devices)} if self.devices.rowCount() else set()
        fill(self.devices, rows, data=[d.id for d in devices])
        for r, d in enumerate(devices):
            if d.id in selected:
                self.devices.selectRow(r)
        self._device_buttons()

    def _device_buttons(self) -> None:
        on = bool(selected_rows(self.devices))
        for b in (self.role_btn, self.station_btn, self.revoke_btn, self.remove_btn):
            b.setEnabled(on)

    def _subs(self) -> list:
        subs = list(reversed(self.hub.service.data.inbox))
        if self.inbox_filter.currentData() == "open":
            subs = [s for s in subs if s.is_open]
        return subs

    def _fill_inbox(self, *_args) -> None:
        subs = self._subs()
        rows = [[_when(s.created), KIND_NAMES.get(s.kind, s.kind), s.by, s.summary(), s.status, s.doc_no] for s in subs]
        fill(self.inbox, rows, status_col=4, data=[s.id for s in subs])
        self._show_lines()

    def _selected_sub(self):
        rows = selected_rows(self.inbox)
        subs = self._subs()
        return subs[rows[0]] if rows and rows[0] < len(subs) else None

    def _show_lines(self) -> None:
        sub = self._selected_sub()
        rows = []
        if sub is not None and sub.kind == "count":
            from ...core.catalog import code_finder

            find = code_finder(self.state.stock)
            for ln in sub.lines:
                item = find(ln["code"])
                rows.append([ln["code"], ln.get("name", ""), ln.get("location", ""), ln["counted"], ln["system"],
                             f"{ln['diff']:+g}" if ln.get("diff") else "ตรง", item.on_hand if item else "-", ln.get("note", "")])
        elif sub is not None and sub.kind == "pick":
            for ln in sub.lines:
                rows.append([ln["code"], ln.get("name", ""), ln.get("location", ""), ln["qty"], "", "",
                             "", "สแกนยืนยันแล้ว" if ln.get("verified") else "ไม่ได้สแกนยืนยัน"])
        elif sub is not None:
            rows.append([sub.code, sub.name, sub.step, "", "", "", "", sub.text])
        fill(self.lines, rows)
        is_open = sub is not None and sub.is_open
        self.confirm_btn.setEnabled(is_open and sub.kind != "problem")
        self.draft_btn.setEnabled(is_open and sub.kind != "problem")
        self.reject_btn.setEnabled(is_open)
        self.solve_btn.setEnabled(is_open and sub.kind == "problem")

    def _fill_racks(self) -> None:
        self._filling = True
        racks = self.hub.service.data.store_map.racks
        self.racks.setRowCount(len(racks))
        for r, rack in enumerate(racks):
            values = [rack.code, rack.name, rack.aisle, SIDE_TEXT.get(rack.side, "ซ้าย"), rack.order, rack.levels, rack.slots]
            for c, v in enumerate(values):
                self.racks.setItem(r, c, QTableWidgetItem(str(v)))
            for c, on in ((7, rack.bottom_first), (8, rack.left_to_right)):
                item = QTableWidgetItem()
                item.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable | Qt.ItemIsUserCheckable)
                item.setCheckState(Qt.Checked if on else Qt.Unchecked)
                self.racks.setItem(r, c, item)
        self.racks.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self._filling = False
        self.map_view.set_racks(racks)

    # ---- actions -----------------------------------------------------------------------------------------------
    def toggle(self) -> None:
        if self.hub.running:
            self.hub.stop()
            self.state.notify("ปิดการเชื่อมต่อมือถือแล้ว")
            return
        QGuiApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            ok = self.hub.start()
        finally:
            QGuiApplication.restoreOverrideCursor()
        if not ok:
            self.actions.error("เปิดการเชื่อมต่อมือถือไม่ได้", self.hub.error)
            return
        self.tabs.setCurrentIndex(0)
        self.state.notify(f"เปิดใช้งานมือถือแล้ว – สแกน QR บนจอด้วยมือถือ ({self.hub.app_url(self._ip())})")

    def _autostart_toggled(self, on: bool) -> None:
        self.hub.set_options(autostart=bool(on))

    def new_code(self) -> None:
        self.hub.service.new_pair_code()
        self._show_qr()

    def copy_link(self) -> None:
        QGuiApplication.clipboard().setText(self.hub.setup_url(self._ip()))
        self.state.notify("คัดลอกลิงก์แล้ว – ส่งให้มือถือแล้วเปิดในเบราว์เซอร์")

    def apply_ports(self) -> None:
        self.hub.set_options(port=self.port.value(), http_port=self.http_port.value())
        if self.hub.running and not self.hub.restart():
            self.actions.error("เปิดการเชื่อมต่อมือถือไม่ได้", self.hub.error)
        self.refresh()

    def renew_cert(self) -> None:
        if QMessageBox.question(self, "สร้างใบรับรองใหม่", "มือถือทุกเครื่องจะต้องติดตั้งใบรับรองใหม่ก่อนใช้แอปต่อ\nสร้างใหม่หรือไม่?") \
                != QMessageBox.Yes:
            return
        folder = self.hub.folder / "certs"
        for name in ("ca.pem", "ca.key", "server.pem", "server.key"):
            (folder / name).unlink(missing_ok=True)
        if self.hub.running:
            self.hub.restart()
        self.refresh()

    def _device(self):
        rows = selected_rows(self.devices)
        devices = self.hub.service.data.devices
        return devices[rows[0]] if rows and rows[0] < len(devices) else None

    def change_role(self) -> None:
        d = self._device()
        if d is None:
            return
        names = list(ROLES.values())
        name, ok = QInputDialog.getItem(self, "บทบาท", f"บทบาทของ {d.name}", names, names.index(ROLES.get(d.role, names[0])), False)
        if ok:
            self.hub.service.set_device(d.id, role=next(k for k, v in ROLES.items() if v == name))

    def change_station(self) -> None:
        d = self._device()
        if d is None:
            return
        options = ["(ไม่ระบุ)", *STEPS]
        name, ok = QInputDialog.getItem(self, "สถานี", f"สถานีของ {d.name}", options,
                                        options.index(d.station) if d.station in options else 0, False)
        if ok:
            self.hub.service.set_device(d.id, station="" if name == options[0] else name)

    def toggle_revoke(self) -> None:
        d = self._device()
        if d is not None:
            self.hub.service.set_device(d.id, revoked=not d.revoked)

    def remove_device(self) -> None:
        d = self._device()
        if d is not None and QMessageBox.question(self, "ลบเครื่อง", f"ลบ {d.name}? เครื่องนี้จะใช้แอปไม่ได้จนกว่าจะจับคู่ใหม่") \
                == QMessageBox.Yes:
            self.hub.service.remove_device(d.id)

    def confirm_post(self) -> None:
        self.confirm(True)

    def confirm_draft(self) -> None:
        self.confirm(False)

    def confirm(self, post: bool) -> None:
        sub = self._selected_sub()
        if sub is None:
            return
        try:
            doc = self.hub.service.confirm(sub.id, "คอม", post=post)
        except Exception as e:  # noqa: BLE001 - shown to the user
            self.actions.error("ยืนยันไม่ได้", str(e))
            return
        if doc is None:
            self.state.notify("ยืนยันแล้ว – ยอดนับตรงกับระบบทุกรายการ ไม่ต้องทำเอกสาร")
        elif post:
            self.state.notify(f"บันทึก {doc.doc_no} {doc.type_name} แล้ว – ส่งออกร่างเพื่อคีย์เข้า Express ได้ที่หน้า เบิก / รับ สต็อก")
        else:
            self.state.notify(f"ร่าง {doc.doc_no} แล้ว – ตรวจแล้วกด บันทึก ในหน้า เบิก / รับ สต็อก")
            self.state.ledger_changed.emit()

    def reject(self) -> None:
        sub = self._selected_sub()
        if sub is not None:
            self.hub.service.reject(sub.id, "คอม")

    def solve(self) -> None:
        sub = self._selected_sub()
        if sub is not None:
            self.hub.service.solve_problem(sub.id, "คอม")

    def _phone_event(self, kind: str, payload) -> None:
        if kind == "problem":
            QApplication.beep()
            self.state.notify(f"⚠ แจ้งปัญหาจากมือถือ ({payload.by}): {payload.summary()}")
        elif kind in ("count", "pick"):
            self.state.notify(f"มือถือส่ง{KIND_NAMES[kind]}มา ({payload.by}) – ยืนยันที่หน้า มือถือ & AR")
        elif kind == "device" and payload is not None:
            self.state.notify(f"จับคู่ / แก้ไขเครื่อง {payload.name} แล้ว")

    # ---- store map ---------------------------------------------------------------------------------------------
    def _cell(self, r: int, c: int) -> str:
        item = self.racks.item(r, c)
        return item.text().strip() if item else ""

    def _ticked(self, r: int, c: int) -> bool:
        item = self.racks.item(r, c)
        return item is not None and item.checkState() == Qt.Checked

    def _racks_from_table(self) -> list[Rack]:
        out = []
        for r in range(self.racks.rowCount()):
            def text(c, r=r):
                return self._cell(r, c)

            def checked(c, r=r):
                return self._ticked(r, c)

            code = text(0)
            if not code:
                continue
            out.append(Rack.from_dict({"code": code, "name": text(1), "aisle": text(2) or 1,
                                       "side": "R" if text(3).startswith(("ข", "R", "r")) else "L", "order": text(4) or 1,
                                       "levels": text(5) or 1, "slots": text(6) or 0, "bottom_first": checked(7),
                                       "left_to_right": checked(8)}))
        return out

    def _rack_edited(self, _item) -> None:
        if self._filling:
            return
        self.hub.service.set_racks(self._racks_from_table())
        self.map_view.set_racks(self.hub.service.data.store_map.racks)

    def auto_racks(self) -> None:
        before = len(self.hub.service.data.store_map.racks)
        racks = racks_from_locations(self.hub.service.all_locations(), self.hub.service.data.store_map.racks)
        self.hub.service.set_racks(racks)
        self.refresh()
        added = len(racks) - before
        self.state.notify(f"เพิ่ม {added} ชั้นวางจากตำแหน่งเก็บ" if added else "ไม่มีชั้นวางใหม่จากตำแหน่งเก็บ (ตั้งตำแหน่งที่หน้า สโตร์ → ชิ้นส่วนพร้อมประกอบ)")

    def add_rack(self) -> None:
        code, ok = QInputDialog.getText(self, "เพิ่มชั้นวาง", "รหัสชั้นวาง (ตำแหน่งเก็บส่วนหน้า เช่น P-POST):")
        if ok and code.strip():
            racks = list(self.hub.service.data.store_map.racks)
            aisle = max((r.aisle for r in racks), default=1)
            racks.append(Rack.from_dict({"code": code, "aisle": aisle, "order": len([r for r in racks if r.aisle == aisle]) + 1}))
            self.hub.service.set_racks(racks)
            self.refresh()

    def remove_racks(self) -> None:
        rows = set(selected_rows(self.racks))
        if rows:
            racks = [r for i, r in enumerate(self.hub.service.data.store_map.racks) if i not in rows]
            self.hub.service.set_racks(racks)
            self.refresh()

    def location_labels(self) -> list[tuple[str, str, str]]:
        """(QR text, location, line under it) of every slot of the chosen racks, else of every rack."""
        racks = self.hub.service.data.store_map.racks
        rows = selected_rows(self.racks)
        chosen = [racks[r] for r in rows if r < len(racks)] or list(racks)
        known = self.hub.service.all_locations()
        out: dict[str, tuple[str, str, str]] = {}
        for rack in chosen:
            slots = rack.levels * rack.slots if rack.slots else 0
            locs = [f"{rack.code}-{n:02d}" for n in range(1, slots + 1)] if slots else \
                [loc for loc in known if parse_location(loc, racks).rack_code == rack.code]
            for loc in locs:
                slot = parse_location(loc, racks)
                where = " · ".join(x for x in (rack.name, f"ชั้นที่ {slot.level}" if rack.levels > 1 and slot.level else "",
                                                 f"ช่อง {slot.column}" if slot.column else "") if x)
                out[loc] = (location_payload(loc, rack.name), loc, where or rack.where)
        return list(out.values())

    def print_labels(self) -> None:
        labels = self.location_labels()
        if not labels:
            self.actions.error("ยังไม่มีตำแหน่ง", "เพิ่มชั้นวางในผัง (ใส่จำนวนชั้นและช่องต่อชั้น) หรือ ตั้งตำแหน่งเก็บในสโตร์ก่อน")
            return
        path, _ = QFileDialog.getSaveFileName(self, "ป้ายตำแหน่ง (AR)", "ป้ายตำแหน่ง_AR.pdf", "PDF (*.pdf)")
        if not path:
            return
        n = write_location_labels_pdf(path, labels, self.per_page.currentData())
        self.state.notify(f"ป้ายตำแหน่ง {n} ป้าย → {path}")
        open_document(path)
