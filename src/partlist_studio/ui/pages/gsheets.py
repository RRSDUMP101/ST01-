"""Google Sheets - pull / push the Part List, stock and material check."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QStandardPaths
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import (QFileDialog, QFormLayout, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QVBoxLayout,
                               QWidget)

from ...core.gsheets import SheetsClient, SheetsError, detect_mode, service_account_email
from ...core.models import COLUMN_KEYS, COLUMN_LABELS
from ...core.partlist_io import prepare_rows
from ...core.company_files import models_from_rows, models_to_rows
from ...core.stock import REQUIREMENT_HEADERS, StockList, requirement_row
from ...core.xref import CodeXref
from ..state import AppState
from ..widgets import Card, PageHeader, button, run_async

HELP = """<b>ตั้งค่าครั้งแรก</b><ol style='margin-left:-20px'>
<li>เปิด Google Cloud Console → สร้างโปรเจกต์ → เปิดใช้ <i>Google Sheets API</i> และ <i>Google Drive API</i></li>
<li><b>แบบ Service Account</b> (แนะนำสำหรับเครื่องสำนักงาน): สร้าง Service Account → Keys → Add key (JSON)
แล้ว <b>แชร์ Google Sheet ให้อีเมลของ Service Account</b> สิทธิ์ผู้แก้ไข</li>
<li><b>แบบบัญชี Google ของผู้ใช้</b>: สร้าง OAuth Client ID ชนิด <i>Desktop app</i> → ดาวน์โหลด JSON
(ครั้งแรกจะเปิดเบราว์เซอร์ให้ล็อกอิน)</li>
<li>เลือกไฟล์ JSON ด้านบน วางลิงก์ Google Sheet แล้วกด ทดสอบการเชื่อมต่อ</li></ol>"""


class GoogleSheetsPage(QWidget):
    def __init__(self, state: AppState, actions, stock_page, parent=None):
        super().__init__(parent)
        self.state = state
        self.actions = actions
        self.stock_page = stock_page
        s = state.settings
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(14)
        lay.addWidget(PageHeader("Google Sheets", "ดึง/ส่ง Part List, สต็อกสโตร์ และผลตรวจวัตถุดิบ กับ Google Sheet "
                                                  "ที่ฝ่ายขาย สโตร์ จัดซื้อ และฝ่ายผลิตใช้ร่วมกัน"))

        conn = Card("การเชื่อมต่อ")
        form = QFormLayout()
        form.setVerticalSpacing(10)
        cred_row = QHBoxLayout()
        self.cred = QLineEdit(s.get("google/credentials"))
        self.cred.setPlaceholderText("ไฟล์ JSON ของ Service Account หรือ OAuth Client (Desktop app)")
        cred_row.addWidget(self.cred, 1)
        browse = button("เลือกไฟล์…")
        browse.clicked.connect(self._browse)
        cred_row.addWidget(browse)
        form.addRow("Credentials", cred_row)
        acct_row = QHBoxLayout()
        self.account = QLabel("-")
        self.account.setObjectName("Hint")
        acct_row.addWidget(self.account, 1)
        self.copy_btn = button("คัดลอกอีเมล")
        self.copy_btn.clicked.connect(lambda: QGuiApplication.clipboard().setText(self.account.text()))
        acct_row.addWidget(self.copy_btn)
        form.addRow("บัญชี", acct_row)
        self.url = QLineEdit(s.get("google/sheet_url"))
        self.url.setPlaceholderText("https://docs.google.com/spreadsheets/d/…")
        form.addRow("ลิงก์ Google Sheet", self.url)
        tabs = QHBoxLayout()
        self.ws_parts = QLineEdit(s.get("google/ws_parts", "PartList"))
        self.ws_stock = QLineEdit(s.get("google/ws_stock", "Stock"))
        self.ws_check = QLineEdit(s.get("google/ws_check", "MaterialCheck"))
        self.ws_xref = QLineEdit(s.get("google/ws_xref", "CodeXref"))
        self.ws_models = QLineEdit(s.get("google/ws_models", "Models"))
        self.ws_production = QLineEdit(s.get("google/ws_production", "Production"))
        self.ws_movements = QLineEdit(s.get("google/ws_movements", "Movements"))
        for label, edit in (("Part List", self.ws_parts), ("สต็อก", self.ws_stock), ("ผลตรวจ", self.ws_check),
                            ("เทียบรหัส", self.ws_xref), ("แบบกระบะ", self.ws_models), ("งานผลิต", self.ws_production),
                            ("เคลื่อนไหว", self.ws_movements)):
            tabs.addWidget(QLabel(label))
            tabs.addWidget(edit)
        form.addRow("ชื่อแท็บ", tabs)
        conn.body.addLayout(form)
        test_row = QHBoxLayout()
        test = button("ทดสอบการเชื่อมต่อ", "primary")
        test.clicked.connect(self._test)
        test_row.addWidget(test)
        self.conn_status = QLabel("")
        self.conn_status.setObjectName("Hint")
        self.conn_status.setWordWrap(True)
        test_row.addWidget(self.conn_status, 1)
        conn.body.addLayout(test_row)
        lay.addWidget(conn)

        sync = Card("ซิงก์ข้อมูล")
        grid = QGridLayout()
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(10)
        rows = [
            ("Part List", "รายการชิ้นส่วนของงานนี้", self.pull_parts, self.push_parts),
            ("สต็อกสโตร์", "ยอดคงเหลือ Min/Max จากสโตร์", self.pull_stock, self.push_stock),
            ("ผลตรวจวัตถุดิบ", "ต้องใช้ / คงเหลือ / แนะนำสั่งซื้อ", None, self.push_check),
            ("ตารางเทียบรหัส", "รหัส Express/แบบ ↔ รหัสนับสต็อก", self.pull_xref, self.push_xref),
            ("แบบกระบะ", "Part List มาตรฐานทุกแบบ (แบบ | ลำดับ | รหัส | รายการ | ขนาด | จำนวนที่ใช้)",
             self.pull_models, self.push_models),
            ("สถานะการผลิต", "ทุกงานที่ยังไม่ปิด: ชิ้นส่วน ต้องผลิต ตัด/พับ/เชื่อม… สถานะ – ให้ฝ่ายผลิตเปิดดูได้",
             None, self.push_production),
            ("ประวัติการเคลื่อนไหว", "ใบเบิก/รับ ทุกบรรทัด (บัตรสินค้า) พร้อมยอดคงเหลือหลังเคลื่อนไหว", None, self.push_movements),
        ]
        for r, (title, desc, pull, push) in enumerate(rows):
            grid.addWidget(QLabel(f"<b>{title}</b>"), r, 0)
            hint = QLabel(desc)
            hint.setObjectName("Hint")
            grid.addWidget(hint, r, 1)
            if pull:
                b = button("⬇ ดึงจาก Google Sheet")
                b.clicked.connect(pull)
                grid.addWidget(b, r, 2)
            b = button("⬆ ส่งไป Google Sheet")
            b.clicked.connect(push)
            grid.addWidget(b, r, 3)
        grid.setColumnStretch(1, 1)
        sync.body.addLayout(grid)
        lay.addWidget(sync)

        help_card = Card("วิธีตั้งค่า")
        text = QLabel(HELP)
        text.setWordWrap(True)
        help_card.body.addWidget(text)
        lay.addWidget(help_card)
        lay.addStretch(1)

        for edit, key in ((self.cred, "google/credentials"), (self.url, "google/sheet_url"),
                          (self.ws_parts, "google/ws_parts"), (self.ws_stock, "google/ws_stock"),
                          (self.ws_check, "google/ws_check"), (self.ws_xref, "google/ws_xref"),
                          (self.ws_models, "google/ws_models"), (self.ws_production, "google/ws_production"),
                          (self.ws_movements, "google/ws_movements")):
            edit.editingFinished.connect(lambda e=edit, k=key: self._save(k, e.text()))
        self.cred.editingFinished.connect(self._update_account)
        self._client: SheetsClient | None = None
        self._update_account()

    # ---------------------------------------------------------------------
    def _save(self, key: str, value: str) -> None:
        self.state.settings.set(key, value.strip())
        if key == "google/credentials":
            self._client = None

    def _browse(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์ credentials (JSON)", str(Path.home()), "JSON (*.json)")
        if path:
            self.cred.setText(path)
            self._save("google/credentials", path)
            self._update_account()

    def _update_account(self) -> None:
        path = self.cred.text().strip()
        self.copy_btn.setVisible(False)
        if not path:
            self.account.setText("ยังไม่ได้เลือกไฟล์")
            return
        try:
            mode = detect_mode(path)
        except SheetsError as exc:
            self.account.setText(str(exc))
            return
        if mode == "service":
            self.account.setText(service_account_email(path))
            self.copy_btn.setVisible(True)
        else:
            self.account.setText("บัญชี Google ของผู้ใช้ (OAuth) – จะเปิดเบราว์เซอร์ให้ล็อกอินครั้งแรก")

    def client(self) -> SheetsClient:
        if self._client is None:
            data_dir = Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
            data_dir.mkdir(parents=True, exist_ok=True)
            self._client = SheetsClient(self.cred.text().strip(), token_path=str(data_dir / "google_token.json"))
        return self._client

    def _call(self, fn, done, *args) -> None:
        run_async(fn, done, lambda e: self.actions.error("Google Sheets", e), *args)

    def _test(self) -> None:
        self.conn_status.setText("กำลังเชื่อมต่อ…")

        def done(titles):
            self.conn_status.setText("✔ เชื่อมต่อสำเร็จ · แท็บในชีต: " + ", ".join(titles))

        def fail(e):
            self.conn_status.setText("✖ " + e)

        run_async(self.client().worksheet_titles, done, fail, self.url.text())

    # ---- part list -------------------------------------------------------
    def pull_parts(self) -> None:
        def done(rows):
            self.actions.import_rows(prepare_rows(rows), f"Google Sheet / {self.ws_parts.text()}")

        self._call(self.client().read_rows, done, self.url.text(), self.ws_parts.text())

    def push_parts(self) -> None:
        pl = self.state.partlist
        rows = [[COLUMN_LABELS[k] for k in COLUMN_KEYS]] + [[p.get(k) for k in COLUMN_KEYS] for p in pl.parts]
        self._push(self.ws_parts.text(), rows, f"ส่ง Part List {len(pl.parts)} รายการแล้ว")

    # ---- stock -----------------------------------------------------------
    def pull_stock(self) -> None:
        def done(rows):
            stock = StockList.from_rows(rows, source=f"Google Sheet / {self.ws_stock.text()}")
            if not stock.items:
                self.actions.error("ไม่พบรายการสต็อก", "ตรวจหัวตารางในแท็บสต็อก (รหัสสินค้า, ชื่อสินค้า, คงเหลือ, หน่วย…)")
                return
            self.stock_page.set_stock(stock, f"Google Sheet / {self.ws_stock.text()}")
            self.state.notify(f"ดึงสต็อก {len(stock.items)} รายการจาก Google Sheet")

        self._call(self.client().read_rows, done, self.url.text(), self.ws_stock.text())

    def push_stock(self) -> None:
        self._push(self.ws_stock.text(), self.state.stock.to_rows(), "ส่งสต็อกแล้ว")

    def push_check(self) -> None:
        lines = self.state.requirements
        if not lines:
            self.actions.error("ยังไม่มีผลตรวจ", "ไปที่หน้า สโตร์ / คลังสินค้า แล้วกด ตรวจวัตถุดิบเทียบสต็อก ก่อน")
            return
        info = self.state.partlist.info
        rows = [["SO", info.so_no, "เลขที่แบบ", info.drawing_no, "จำนวนผลิต", info.build_qty]]
        rows += [REQUIREMENT_HEADERS] + [requirement_row(line) for line in lines]
        self._push(self.ws_check.text(), rows, "ส่งผลตรวจวัตถุดิบแล้ว")

    # ---- code table / model BOMs ---------------------------------------
    def pull_xref(self) -> None:
        def done(rows):
            added = self.state.xref.merge(CodeXref.from_rows(rows).entries)
            self.state.set_xref(self.state.xref)
            self.state.notify(f"ดึงตารางเทียบรหัส เพิ่ม {added} คู่")

        self._call(self.client().read_rows, done, self.url.text(), self.ws_xref.text())

    def push_xref(self) -> None:
        self._push(self.ws_xref.text(), self.state.xref.to_rows(), f"ส่งตารางเทียบรหัส {len(self.state.xref.entries)} คู่แล้ว")

    def pull_models(self) -> None:
        def done(rows):
            models = models_from_rows(rows, images_from=self.state.models)
            if models:
                self.state.set_models(models)
            self.state.notify(f"ดึงแบบกระบะ {len(models)} แบบ")

        self._call(self.client().read_rows, done, self.url.text(), self.ws_models.text())

    def push_models(self) -> None:
        self._push(self.ws_models.text(), models_to_rows(self.state.models), f"ส่งแบบกระบะ {len(self.state.models)} แบบแล้ว")

    def push_production(self) -> None:
        from ...core.production import CLOSED, STATUS_HEADERS, status_rows

        jobs = [j for j in self.state.jobs if j.status not in CLOSED]
        self._push(self.ws_production.text(), [STATUS_HEADERS] + status_rows(jobs), f"ส่งสถานะการผลิต {len(jobs)} งานแล้ว")

    def push_movements(self) -> None:
        from ...core.movements import HISTORY_HEADERS, history_rows

        moves = self.state.ledger.movements
        self._push(self.ws_movements.text(), [HISTORY_HEADERS] + history_rows(moves), f"ส่งประวัติ {len(moves)} บรรทัดแล้ว")

    def _push(self, worksheet: str, rows: list[list], message: str) -> None:
        self._call(self.client().write_rows, lambda url: self.state.notify(f"{message} → {worksheet}"),
                   self.url.text(), worksheet, rows)
