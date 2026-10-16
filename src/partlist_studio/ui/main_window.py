"""Main window: sidebar navigation + pages."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QSize, Qt, QTimer
from PySide6.QtGui import QAction, QColor, QKeySequence
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QLabel, QListWidget, QListWidgetItem, QMainWindow,
                               QMessageBox, QStackedWidget, QVBoxLayout, QWidget)

from .. import APP_NAME, __version__
from ..core.movements import DOC_TYPES
from .actions import Actions
from .pages.dashboard import DashboardPage
from .pages.drawings import DrawingsPage
from .pages.express import ExpressPage
from .pages.gsheets import GoogleSheetsPage
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
        ("stock", "⑤   สโตร์ / ชิ้นส่วนพร้อมประกอบ"),
        ("movements", "⑥   เบิก / รับ สต็อก"),
    ]),
    ("ข้อมูลหลัก & เชื่อมต่อ", [
        ("models", "▣   แบบกระบะมาตรฐาน"),
        ("express", "₿   Express"),
        ("sheets", "⇅   Google Sheets"),
        ("settings", "⚙   ตั้งค่า"),
    ]),
]
NAV = [entry for _title, entries in NAV_GROUPS for entry in entries]


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
                head.setSizeHint(QSize(200, 30))
                self.nav.addItem(head)
            for key, label in entries:
                item = QListWidgetItem(label)
                item.setData(Qt.UserRole, key)
                item.setSizeHint(QSize(200, 42))
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
        self.pages["settings"] = SettingsPage(self.state)
        for key, _label in NAV:
            self.stack.addWidget(self.pages[key])
        self.nav.currentItemChanged.connect(self._nav_changed)
        self.go("dashboard")

        self._build_menu()
        self.statusBar().showMessage("พร้อมใช้งาน")
        self.state.message.connect(lambda m: self.statusBar().showMessage(m, 8000))
        self.state.partlist_changed.connect(self._update_title)
        self._update_title()
        self._steps_due = False
        for signal in (self.state.partlist_changed, self.state.jobs_changed, self.state.laser_changed,
                       self.state.ledger_changed, self.state.stock_changed):
            signal.connect(self._steps_changed)
        self.refresh_steps()

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
        help_menu.addAction("เกี่ยวกับโปรแกรม", self._about)

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
            event.accept()
        else:
            event.ignore()
