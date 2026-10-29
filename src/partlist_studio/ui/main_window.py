"""Main window: sidebar navigation + pages."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QSize, Qt, QTimer
from PySide6.QtGui import QAction, QColor, QGuiApplication, QKeySequence, QShortcut
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMainWindow,
                               QMessageBox, QPushButton, QStackedWidget, QTabWidget, QVBoxLayout, QWidget)

from .. import APP_NAME, __version__
from ..core.movements import DOC_TYPES
from . import theme
from .actions import Actions
from .palette import Command, CommandPalette
from .pages.dashboard import DashboardPage
from .pages.drawings import DrawingsPage
from .mobile_hub import MobileHub
from .pages.express import ExpressPage
from .pages.gsheets import GoogleSheetsPage
from .pages.mobile import MobilePage
from .pages.models import ModelsPage
from .pages.movements import MovementsPage
from .pages.nesting import NestingPage
from .pages.partlist import PartListPage
from .pages.production import ProductionPage
from .pages.settings import SettingsPage
from .pages.stock import StockPage
from .state import AppState
from .widgets import StepBar
from .work_dialogs import CompareDialog
from .workflow import STEP_PAGES, next_action, workflow_steps

# The sidebar in the order of the work: start, the 6 steps from the drawing to the store, then the master data
NAV_GROUPS = [
    ("", [("dashboard", "▦   ภาพรวม / เริ่มงาน")]),
    ("ขั้นตอนงาน", [
        ("drawings", "①   แบบ 2D (DWG/DXF)"),
        ("parts", "②   Part List"),
        ("production", "③   งานผลิต (SO)"),
        ("nesting", "④   ตัดเลเซอร์"),
        ("stock", "⑤   สโตร์ / พร้อมประกอบ"),
        ("movements", "⑥   เบิก / รับ สต็อก"),
    ]),
    ("ข้อมูลหลัก & เชื่อมต่อ", [
        ("models", "▣   แบบกระบะมาตรฐาน"),
        ("express", "₿   Express"),
        ("sheets", "⇅   Google Sheets"),
        ("mobile", "▯   มือถือ & AR"),
        ("settings", "⚙   ตั้งค่า"),
    ]),
]
NAV = [entry for _title, entries in NAV_GROUPS for entry in entries]
STEP_KEYS = ["dashboard", "drawings", "parts", "production", "nesting", "stock", "movements"]  # Ctrl+0 … Ctrl+6
HELP_TEXT = """<h3>ทำงานตามขั้นตอน 1 → 6</h3>
<ol>
<li><b>แบบ 2D</b> – นำเข้าไฟล์ DWG/DXF (ลากไฟล์มาวางบนหน้าต่างก็ได้) ตรวจรายการแล้วกด <i>เพิ่มเข้า Part List</i></li>
<li><b>Part List</b> – ตรวจ/แก้รายการ ดับเบิลคลิกเพื่อแก้ แล้วกด <i>ตรวจวัตถุดิบเทียบสต็อก</i></li>
<li><b>งานผลิต (SO)</b> – เปิดงานจาก Part List หรือแบบกระบะ บันทึกจำนวนที่ผ่านแต่ละขั้น พิมพ์ใบงาน QR</li>
<li><b>ตัดเลเซอร์</b> – คำนวณแผนตัด เลือกแผ่นเหล็กในช่อง <i>แผ่นที่ใช้</i> สร้างโปรแกรมตัด บันทึกตัดเสร็จ</li>
<li><b>สโตร์</b> – สต็อก ผลตรวจวัตถุดิบ Min/Max ชิ้นส่วนพร้อมประกอบ สต็อกเหล็ก</li>
<li><b>เบิก / รับ</b> – ตรวจใบร่าง PD / FR / RR / AJ แล้วกด <i>บันทึก</i> เพื่อตัด/รับสต็อก แล้วคีย์เข้า Express</li>
</ol>
<p>ปุ่ม <b>ขั้นต่อไป</b> (มุมขวาบน) พาไปทำสิ่งที่รออยู่ต่อทันที</p>
<p><b>มือถือ & AR</b> – เปิดใช้งาน แล้วสแกน QR บนจอด้วยมือถือ: ติดตามการผลิต บันทึกเสร็จ/เสีย แจ้งปัญหา
สแกน AR นับสต็อก หยิบของนำทางด้วย AR (Android · iPhone · iPad ผ่าน Wi-Fi)</p>
<h3>ปุ่มลัด</h3>
<table cellpadding="3">
<tr><td><b>Ctrl+K</b></td><td>ค้นหาคำสั่ง – พิมพ์ชื่อหน้า แท็บ หรือปุ่ม แล้วกด Enter</td></tr>
<tr><td><b>Ctrl+F</b></td><td>ไปที่ช่องค้นหาของหน้านี้</td></tr>
<tr><td><b>Ctrl+0</b></td><td>ภาพรวม / เริ่มงาน</td></tr>
<tr><td><b>Ctrl+1 … Ctrl+6</b></td><td>ขั้นตอนงาน ① – ⑥</td></tr>
<tr><td><b>Ctrl+Enter</b></td><td>ทำขั้นต่อไป</td></tr>
<tr><td><b>Ctrl+N / Ctrl+O / Ctrl+S</b></td><td>งานใหม่ / เปิด / บันทึก</td></tr>
<tr><td><b>F1</b></td><td>หน้านี้</td></tr>
</table>
<p>ในตาราง: คลิก / Shift / Ctrl เลือกหลายแถว · ดับเบิลคลิกเพื่อแก้ · เอาเมาส์ชี้ปุ่มเพื่อดูคำอธิบาย</p>"""


class MainWindow(QMainWindow):
    def __init__(self, state: AppState | None = None):
        super().__init__()
        self.state = state or AppState()
        self.actions = Actions(self.state, self)
        self.resize(1360, 840)
        self.setMinimumSize(QSize(1080, 680))
        self.setAcceptDrops(True)

        root = QWidget()
        self.setCentralWidget(root)
        lay = QHBoxLayout(root)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)

        sidebar = QFrame()
        sidebar.setObjectName("Sidebar")
        sidebar.setFixedWidth(236)
        sl = QVBoxLayout(sidebar)
        sl.setContentsMargins(0, 0, 0, 0)
        brand = QLabel("RRS Part List Studio")
        brand.setObjectName("Brand")
        sub = QLabel("แบบ ZWCAD ⇄ Part List ⇄ สโตร์ ⇄ Google Sheets")
        sub.setObjectName("BrandSub")
        sub.setWordWrap(True)
        sl.addWidget(brand)
        sl.addWidget(sub)
        self.palette_btn = QPushButton("⌕   ค้นหาคำสั่ง…        Ctrl+K")
        self.palette_btn.setObjectName("PaletteButton")
        self.palette_btn.setCursor(Qt.PointingHandCursor)
        self.palette_btn.setToolTip("พิมพ์ชื่อหน้า แท็บ หรือปุ่มที่ต้องการ แล้วกด Enter – ไม่ต้องจำว่าอยู่เมนูไหน")
        self.palette_btn.clicked.connect(self.open_palette)
        sl.addWidget(self.palette_btn)
        self.nav = QListWidget()
        self.nav.setObjectName("NavList")
        self.nav.setCursor(Qt.PointingHandCursor)
        for title, entries in NAV_GROUPS:
            if title:
                head = QListWidgetItem(title.upper())
                head.setFlags(Qt.NoItemFlags)
                head.setForeground(QColor("#6F87A5"))
                font = head.font()
                font.setPointSizeF(max(7.0, font.pointSizeF() - 1))
                font.setBold(True)
                head.setFont(font)
                head.setSizeHint(QSize(200, 24))
                self.nav.addItem(head)
            for key, label in entries:
                item = QListWidgetItem(label)
                item.setData(Qt.UserRole, key)
                item.setSizeHint(QSize(200, 35))  # all 12 fit a 1366 x 768 screen without scrolling
                if key in STEP_KEYS:
                    item.setToolTip(f"{label.split('   ', 1)[-1]}  (Ctrl+{STEP_KEYS.index(key)})")
                self.nav.addItem(item)
        sl.addWidget(self.nav, 1)
        self.foot = QLabel(f"v{__version__}")
        self.foot.setObjectName("SidebarFoot")
        self.foot.setWordWrap(True)
        sl.addWidget(self.foot)
        lay.addWidget(sidebar)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(0)
        self.steps = StepBar(self.go, self.run_next)
        rl.addWidget(self.steps)
        self.stack = QStackedWidget()
        self.stack.setObjectName("Content")
        rl.addWidget(self.stack, 1)
        lay.addWidget(right, 1)

        self.pages: dict[str, QWidget] = {}
        self.pages["dashboard"] = DashboardPage(self.state, self.actions, self.go)
        self.pages["drawings"] = DrawingsPage(self.state, self.actions)
        self.pages["parts"] = PartListPage(self.state, self.actions)
        self.pages["models"] = ModelsPage(self.state, self.actions)
        self.pages["production"] = ProductionPage(self.state, self.actions)
        self.pages["nesting"] = NestingPage(self.state, self.actions)
        self.pages["stock"] = StockPage(self.state, self.actions)
        self.pages["movements"] = MovementsPage(self.state, self.actions, self.pages["stock"])
        self.pages["sheets"] = GoogleSheetsPage(self.state, self.actions, self.pages["stock"])
        self.pages["express"] = ExpressPage(self.state, self.actions, self.pages["stock"], self.pages["sheets"])
        self.mobile_hub = MobileHub(self.state)
        self.pages["mobile"] = MobilePage(self.state, self.actions, self.mobile_hub)
        self.pages["settings"] = SettingsPage(self.state)
        for key, _label in NAV:
            self.stack.addWidget(self.pages[key])
        self.nav.currentItemChanged.connect(self._nav_changed)
        self.go("dashboard")

        self._build_menu()
        self._build_shortcuts()
        self.statusBar().showMessage("พร้อมใช้งาน · Ctrl+K ค้นหาคำสั่ง · F1 วิธีใช้และปุ่มลัด")
        self.state.message.connect(lambda m: self.statusBar().showMessage(m, 8000))
        self.state.partlist_changed.connect(self._update_title)
        self._update_title()
        self._steps_due = False
        for signal in (self.state.partlist_changed, self.state.jobs_changed, self.state.laser_changed,
                       self.state.ledger_changed, self.state.stock_changed):
            signal.connect(self._steps_changed)
        self.refresh_steps()
        self.pages["mobile"].refresh()  # the badge of the inbox in the sidebar
        if self.mobile_hub.option("autostart"):
            QTimer.singleShot(800, self._start_mobile)

    def _start_mobile(self) -> None:
        if not self.mobile_hub.start():
            self.state.notify(f"เปิดการเชื่อมต่อมือถืออัตโนมัติไม่ได้: {self.mobile_hub.error}")

    def set_nav_badge(self, key: str, count: int) -> None:
        """'▯   มือถือ & AR  (3)': what waits on that page."""
        label = dict(NAV).get(key, "")
        for row in range(self.nav.count()):
            item = self.nav.item(row)
            if item.data(Qt.UserRole) == key:
                item.setText(f"{label}  ({count})" if count else label)
                if count:
                    item.setForeground(QColor(theme.ACCENT))
                else:
                    item.setData(Qt.ForegroundRole, None)
                return

    def _build_menu(self) -> None:
        a = self.actions
        file_menu = self.menuBar().addMenu("ไฟล์")
        for text, slot, key in (("งานใหม่", a.new, QKeySequence.New), ("เปิด…", lambda: a.open(), QKeySequence.Open),
                                ("บันทึก", lambda: a.save(), QKeySequence.Save),
                                ("บันทึกเป็น…", lambda: a.save(True), QKeySequence.SaveAs)):
            act = QAction(text, self)
            act.setShortcut(key)
            act.triggered.connect(slot)
            file_menu.addAction(act)
            if text == "เปิด…":
                self.recent_menu = file_menu.addMenu("เปิดไฟล์ล่าสุด")
                self.recent_menu.aboutToShow.connect(self._fill_recent)
        file_menu.addSeparator()
        imp = file_menu.addMenu("นำเข้า")
        imp.addAction("แบบ 2D ZWCAD (DWG/DXF)…", lambda: a.import_drawings())
        imp.addAction("ตาราง BOM ZWCAD / Excel / CSV…", a.import_table)
        imp.addAction("ไฟล์ Parts List All Model (แบบกระบะ + รูป)…", lambda: self.pages["models"].import_workbook())
        imp.addAction("สต็อก: ไฟล์นับสต๊อค / สต๊อกเหล็ก / อะไหล่กระบะ…", lambda: self.pages["stock"].import_stock())
        imp.addAction("ไฟล์จาก Express (ทะเบียนสินค้า / รายงาน)…", self.pages["express"].import_express)
        exp = file_menu.addMenu("ส่งออก")
        exp.addAction("ตาราง Part List สำหรับ ZWCAD (DXF)…", a.export_cad_dxf)
        exp.addAction("ตาราง Part List สำหรับ ZWCAD (DWG)…", a.export_cad_dwg)
        exp.addAction("BOM สำหรับ ZWCAD (CSV/Excel)…", a.export_cad_table)
        exp.addAction("Part List ภาษาไทย (Excel)…", a.export_excel_report)
        exp.addAction("Part List รูปแบบบริษัท (Parts List All Model พร้อมรูป)…", a.export_company_bom)
        exp.addAction("ทะเบียนแบบ (Excel)…", a.export_drawing_register)
        file_menu.addSeparator()
        ex = self.menuBar().addMenu("Express")
        ex.addAction("นำเข้าทะเบียนสินค้า / สินค้าคงเหลือ…", self.pages["express"].import_express)
        ex.addSeparator()
        ex.addAction("ร่าง PD จ่ายวัตถุดิบเพื่อผลิต…", self.pages["express"].export_pd)
        ex.addAction("ร่างใบขอซื้อ…", self.pages["express"].export_purchase)
        ex.addAction("สินค้าใหม่สำหรับเปิดรหัส…", self.pages["express"].export_new_items)
        ex.addSeparator()
        ex.addAction("Parts List All Model (รหัส Express)…", self.pages["express"].export_partlist_express)
        ex.addAction("ฟอร์มทะเบียนสินค้า…", self.pages["express"].export_item_form)
        ex.addAction("ใช้รหัส Express กับแบบกระบะ…", lambda: (self.go("express"),
                                                             self.pages["express"].apply_express_codes()))
        ex.addSeparator()
        ex.addAction("ตรวจรหัส Part List ↔ Express", lambda: (self.go("express"), self.pages["express"].check_codes()))
        ex.addAction("ตารางเทียบรหัส", lambda: (self.go("express"), self.pages["express"].tabs.setCurrentIndex(1)))
        ex.addSeparator()
        ex.addAction("ตรวจรูปแบบรหัส Express", lambda: (self.go("express"), self.pages["express"].audit_codes()))
        ex.addAction("ตั้งรหัสใหม่ตามกฎรหัส…", self.pages["express"].new_code)
        work = self.menuBar().addMenu("ขั้นตอนงาน")
        act = QAction("ทำขั้นต่อไป ›", self)
        act.setShortcut(QKeySequence("Ctrl+Return"))
        act.triggered.connect(self.run_next)
        work.addAction(act)
        work.addSeparator()
        work.addAction("① นำเข้าแบบ DWG/DXF…", lambda: a.import_drawings())
        work.addAction("② Part List", lambda: self.go("parts"))
        work.addAction("③ เปิดงานผลิตจาก Part List…", lambda: (self.go("production"),
                                                              self.pages["production"].new_from_partlist()))
        work.addAction("③ เปิดงานผลิตจากแบบกระบะ (เลือกรุ่นย่อย)…", lambda: self.go("models"))
        work.addAction("④ วางแผนตัดเลเซอร์", lambda: (self.go("nesting"), self.pages["nesting"].tabs.setCurrentIndex(0),
                                                      self.pages["nesting"].run()))
        work.addAction("④ คิวเลเซอร์ / บันทึกตัดเสร็จ",
                       lambda: (self.go("nesting"), self.pages["nesting"].tabs.setCurrentIndex(2)))
        work.addAction("⑤ ชิ้นส่วนพร้อมประกอบ (แยกกลุ่ม)",
                       lambda: (self.go("stock"), self.pages["stock"].tabs.setCurrentWidget(self.pages["stock"].ready)))
        work.addAction("⑤ Min / Max & เตือนสั่งซื้อ", lambda: (self.go("stock"), self.pages["stock"].tabs.setCurrentIndex(2),
                                                             self.pages["stock"].replenish.run()))
        docs = work.addMenu("⑥ ใบเบิก / รับใหม่")
        for code, (name, _s) in DOC_TYPES.items():
            docs.addAction(f"{code} – {name}", lambda c=code: (self.go("movements"), self.pages["movements"].new_doc(c)))
        work.addAction("⑥ ประวัติการเคลื่อนไหวสินค้า", lambda: (self.go("movements"),
                                                                self.pages["movements"].tabs.setCurrentIndex(1)))
        work.addSeparator()
        work.addAction("เทียบ Rev. แบบ / Part List…", self.compare_revisions)
        file_menu.addSeparator()
        quit_act = QAction("ออก", self)
        quit_act.setShortcut(QKeySequence.Quit)
        quit_act.triggered.connect(self.close)
        file_menu.addAction(quit_act)
        help_menu = self.menuBar().addMenu("ช่วยเหลือ")
        act = QAction("วิธีใช้ย่อ และปุ่มลัด", self)
        act.setShortcut(QKeySequence("F1"))
        act.triggered.connect(self.show_help)
        help_menu.addAction(act)
        act = QAction("ค้นหาคำสั่ง…", self)
        act.setShortcut(QKeySequence("Ctrl+K"))
        act.triggered.connect(self.open_palette)
        help_menu.addAction(act)
        help_menu.addSeparator()
        help_menu.addAction("เกี่ยวกับโปรแกรม", self._about)

    def _build_shortcuts(self) -> None:
        for n, key in enumerate(STEP_KEYS):
            QShortcut(QKeySequence(f"Ctrl+{n}"), self, activated=lambda k=key: self.go(k))
        QShortcut(QKeySequence.Find, self, activated=self.focus_search)

    # ---- finding things: the command palette, the search box of a page, recent files, help ------
    def commands(self) -> list[Command]:
        """Every page, tab, menu command and button of the pages, for the command palette."""
        out: list[Command] = []
        titles = {key: label.split("   ", 1)[-1] for key, label in NAV}
        for key, title in titles.items():
            n = STEP_KEYS.index(key) if key in STEP_KEYS else -1
            out.append(Command(f"ไปหน้า {title}", "หน้า", lambda k=key: self.go(k), f"Ctrl+{n}" if n >= 0 else ""))

        def walk(menu, path):
            for act in menu.actions():
                if act.isSeparator() or not act.text():
                    continue
                text = act.text().replace("&&", "&")
                if act.menu() is not None:
                    walk(act.menu(), f"{path} › {text}")
                elif menu is not self.recent_menu:
                    out.append(Command(text.rstrip("…").strip(), f"เมนู {path}", act.trigger,
                                       act.shortcut().toString(QKeySequence.NativeText)))

        for act in self.menuBar().actions():
            if act.menu() is not None:
                walk(act.menu(), act.text())
        seen = {(c.title, c.where) for c in out}
        for key, page in self.pages.items():
            tabs = getattr(page, "tabs", None)
            tabs = tabs if isinstance(tabs, QTabWidget) else None
            if tabs is not None:
                for i in range(tabs.count()):
                    name = tabs.tabText(i).replace("&&", "&")
                    out.append(Command(name, f"แท็บในหน้า {titles[key]}",
                                       lambda k=key, t=tabs, i=i: (self.go(k), t.setCurrentIndex(i))))
            for btn in page.findChildren(QPushButton):
                text = btn.text().replace("&&", "&").strip()
                if not text or btn.objectName() in ("Step", "Stepper") or text.startswith("ไป ›") or len(text) < 3:
                    continue
                tab = next((i for i in range(tabs.count()) if tabs.widget(i).isAncestorOf(btn)), -1) if tabs else -1
                where = f"หน้า {titles[key]}" + (f" › {tabs.tabText(tab).replace('&&', '&')}" if tab >= 0 else "")
                if btn.menu() is not None:
                    for act in btn.menu().actions():
                        if act.text() and not act.isSeparator() and (act.text(), where) not in seen:
                            seen.add((act.text(), where))
                            out.append(Command(act.text().rstrip("…").strip(), f"{text.rstrip(' ▾')} · {where}",
                                               lambda k=key, t=tabs, i=tab, a=act: self._run_button(k, t, i, a)))
                    continue
                title = text.rstrip("…").strip()
                tip = btn.toolTip().split("\n", 1)[0]
                if (title, where) in seen:
                    continue
                seen.add((title, where))
                out.append(Command(title, where, lambda k=key, t=tabs, i=tab, b=btn: self._run_button(k, t, i, b),
                                   detail=tip))
        return out

    def _run_button(self, key: str, tabs, index: int, target) -> None:
        self.go(key)
        if tabs is not None and index >= 0:
            tabs.setCurrentIndex(index)
        if isinstance(target, QAction):
            target.trigger()
        elif target.isEnabled():
            target.click()
        else:
            self.state.notify(f"“{target.text()}” ยังกดไม่ได้ – " + (target.toolTip() or "เลือกแถวหรือเตรียมข้อมูลก่อน"))

    def open_palette(self) -> None:
        palette = CommandPalette(self.commands(), self)
        if palette.exec() and palette.chosen is not None:
            QTimer.singleShot(0, palette.chosen.run)  # after the palette is closed: dialogs open on top of the window

    def focus_search(self) -> None:
        """Ctrl+F: the search box of the page (and tab) on screen."""
        page = self.pages.get(self.current_page())
        if page is None:
            return
        for edit in page.findChildren(QLineEdit):
            hint = edit.placeholderText()
            if edit.isVisible() and ("ค้นหา" in hint or "สแกน" in hint):
                edit.setFocus(Qt.ShortcutFocusReason)
                edit.selectAll()
                return
        self.state.notify("หน้านี้ไม่มีช่องค้นหา – กด Ctrl+K เพื่อค้นหาคำสั่ง")

    def _fill_recent(self) -> None:
        self.recent_menu.clear()
        files = self.actions.recent_files()
        for path in files:
            self.recent_menu.addAction(Path(path).name, lambda p=path: self.actions.open(p)).setToolTip(path)
        if not files:
            self.recent_menu.addAction("(ยังไม่มี)").setEnabled(False)

    def help_box(self) -> QMessageBox:
        box = QMessageBox(self)
        box.setWindowTitle("วิธีใช้ย่อ และปุ่มลัด")
        box.setTextFormat(Qt.RichText)
        box.setText(HELP_TEXT)
        box.setStyleSheet("QLabel { min-width: 640px; }")  # one line per step, not a narrow column
        return box

    def show_help(self) -> None:
        self.help_box().exec()

    # ---- the window as it was left: size, place, page -----------------------
    def restore_session(self) -> None:
        s = self.state.settings
        geometry = s.q.value("window/geometry")
        if geometry is None or not self.restoreGeometry(geometry):
            screen = QGuiApplication.primaryScreen()
            avail = screen.availableGeometry() if screen is not None else None
            if avail is not None and (avail.width() < 1440 or avail.height() < 880):
                self.setWindowState(Qt.WindowMaximized)  # a laptop screen: use all of it
        page = s.get("window/page")
        if page in self.pages:
            self.go(page)

    def save_session(self) -> None:
        s = self.state.settings
        s.set("window/geometry", self.saveGeometry())
        s.set("window/page", self.current_page())

    def compare_revisions(self) -> None:
        CompareDialog(self.state, self.actions, self).exec()

    def go(self, key: str) -> None:
        for row in range(self.nav.count()):
            if self.nav.item(row).data(Qt.UserRole) == key:
                self.nav.setCurrentRow(row)
                return

    def current_page(self) -> str:
        item = self.nav.currentItem()
        return item.data(Qt.UserRole) if item else ""

    def _nav_changed(self, item, _previous=None) -> None:
        key = item.data(Qt.UserRole) if item else None
        if key in self.pages:
            self.stack.setCurrentWidget(self.pages[key])
            self.refresh_steps()

    # ---- the work path: the step bar and the next thing to do -------------
    def _steps_changed(self) -> None:
        if not self._steps_due:  # many signals in a row: one refresh
            self._steps_due = True
            QTimer.singleShot(0, self.refresh_steps)

    def refresh_steps(self) -> None:
        self._steps_due = False
        current = self.current_page()
        self.steps.setVisible(current in STEP_PAGES)
        if current in STEP_PAGES:
            self.steps.set_steps(workflow_steps(self.state), current, next_action(self.state).text)
        dash = self.pages.get("dashboard")
        if dash is not None and current == "dashboard":
            dash.refresh_flow()

    def run_next(self) -> None:
        """Open the page (and tab) of the next thing to do, and start it when it is one click."""
        nxt = next_action(self.state)
        self.go(nxt.key)
        page = self.pages[nxt.key]
        if nxt.tab >= 0 and hasattr(page, "tabs"):
            page.tabs.setCurrentIndex(nxt.tab)
        if nxt.action == "import_drawings":
            self.actions.import_drawings()
        elif nxt.action == "new_job":
            page.new_from_partlist()

    def _update_title(self) -> None:
        name = Path(self.state.path).name if self.state.path else "งานใหม่"
        self.setWindowTitle(f"{name}{' *' if self.state.dirty else ''} – {APP_NAME}")
        info = self.state.partlist.info
        job = " · ".join(x for x in (info.so_no, info.customer, info.vehicle_model) if x)
        self.foot.setText(f"{job}\nv{__version__}" if job else f"v{__version__}")

    def _about(self) -> None:
        QMessageBox.about(self, APP_NAME, f"<b>{APP_NAME}</b> v{__version__}<br>"
                                          "จัดทำ Part List จากแบบ ZWCAD (DWG/DXF) เชื่อมกับสต็อกสโตร์และ Google Sheets")

    # ---- drag & drop drawings / project files ----------------------------
    def dragEnterEvent(self, event):  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event):  # noqa: N802
        paths = [u.toLocalFile() for u in event.mimeData().urls() if u.isLocalFile()]
        drawings = [p for p in paths if Path(p).suffix.lower() in (".dwg", ".dxf")]
        projects = [p for p in paths if p.endswith(".rrspl")]
        if projects:
            QTimer.singleShot(0, lambda: self.actions.open(projects[0]))
        elif drawings:
            QTimer.singleShot(0, lambda: self.actions.import_drawings(drawings))

    def closeEvent(self, event):  # noqa: N802
        if self.actions.confirm_discard():
            self.save_session()
            self.mobile_hub.stop()
            event.accept()
        else:
            event.ignore()
