"""Tab of สโตร์ / คลังสินค้า: สต็อกเหล็ก - plates, bars and tubes with size, weight, balance and the laser queue."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ...core import steel
from ...core.movements import DocLine
from ...core.stock import _key
from ..state import AppState
from ..widgets import StatusChipRow, button, empty_hint, fill, fit_to_screen, selected_rows, table

KINDS = {"ทุกรายการ": None, "เหล็กแผ่น": steel.FORM_SHEET, "เส้น / ท่อ": steel.FORM_BAR,
         "ต้องสั่ง / ตรวจ": "need"}
NEED = {steel.ST_SHORT, steel.ST_EMPTY, steel.ST_LOW, steel.ST_NO_BALANCE}


class SteelTab(QWidget):
    """สต็อกเหล็ก: the steel register (ไฟล์สต็อกเหล็ก) with the balance of the stock, the sheets the laser queue
    still has to cut and what is left after them; counts and receipts go through the documents (AJ / RR)."""

    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.lines: list[steel.SteelLine] = []
        self._shown: list[steel.SteelLine] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 12, 12, 12)
        bar = QHBoxLayout()
        self.import_btn = button("นำเข้าไฟล์สต็อกเหล็ก…", "primary",
                                 "ไฟล์ทะเบียนเหล็ก (รหัสสินค้า · ชื่อสินค้า · กลุ่มวัสดุ · ความหนา · กว้าง · ยาว · รหัสนับสต็อก) – "
                                 "ยอดคงเหลือใช้จาก Express / ไฟล์นับสต๊อค / เอกสารในโปรแกรม ถ้าไฟล์ไม่มียอด")
        self.import_btn.clicked.connect(lambda: self.import_file())
        bar.addWidget(self.import_btn)
        self.kind = QComboBox()
        self.kind.addItems(list(KINDS))
        self.kind.currentIndexChanged.connect(self._show)
        bar.addWidget(self.kind)
        self.family = QComboBox()
        self.family.addItem("ทุกวัสดุ", "")
        for key, name in steel.FAMILY_NAMES.items():
            self.family.addItem(name, key)
        self.family.currentIndexChanged.connect(self._show)
        bar.addWidget(self.family)
        self.search = QLineEdit()
        self.search.setPlaceholderText("ค้นหา รหัส / ชื่อ / หนา เช่น 3 มม.")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self._show)
        bar.addWidget(self.search, 1)
        self.chips = StatusChipRow(steel.STATUSES, hide_zero=True)
        bar.addLayout(self.chips)
        lay.addLayout(bar)
        hint = QLabel("คงเหลือ = ยอดจาก Express / ไฟล์นับสต๊อค / เอกสารเบิก-รับในโปรแกรม · คิวเลเซอร์ใช้ = แผ่นที่โปรแกรมตัด"
                      "ซึ่งยังรอตัดต้องใช้ (เลือกแผ่นได้ที่หน้า ตัดเลเซอร์) · เหลือหลังตัด < Min ขึ้น ต่ำกว่า Min · "
                      "ยังไม่มียอด = ไฟล์ทะเบียนไม่มียอด และยังไม่มียอดจากแหล่งอื่น (ตรวจนับเพื่อตั้งยอด)")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self.table = table(steel.HEADERS, [110, 300, 80, 80, 70, 120, 55, 75, 75, 110, 95, 95, 55, 95, 200])
        empty_hint(self.table, lambda: "ไม่พบรายการที่ตรงกับการค้นหา / ตัวกรอง – ล้างช่องค้นหาเพื่อดูทั้งหมด" if self.lines else
                   "ยังไม่มีเหล็กในสต็อก – กด นำเข้าไฟล์สต็อกเหล็ก… หรือนำเข้าสต็อกจาก Express")
        self.table.setSortingEnabled(False)
        lay.addWidget(self.table, 1)
        low = QHBoxLayout()
        self.summary = QLabel()
        low.addWidget(self.summary, 1)
        self.count_btn = button("ตรวจนับ → ใบปรับยอด (AJ)…", tooltip="นับแผ่นจริงของแถวที่เลือก ระบบร่างใบปรับยอดให้ "
                                                                 "ตรวจแล้วกด บันทึก ที่หน้า เบิก/รับ สต็อก")
        self.count_btn.clicked.connect(lambda: self.make_doc("AJ"))
        self.receive_btn = button("รับเหล็กเข้า → ใบรับ (RR)…", tooltip="จำนวนที่รับเข้าของแถวที่เลือก ระบบร่างใบรับสินค้าให้")
        self.receive_btn.clicked.connect(lambda: self.make_doc("RR"))
        self.export_btn = button("ส่งออก Excel", tooltip="ตารางสต็อกเหล็กที่แสดงอยู่เป็น Excel")
        self.export_btn.clicked.connect(self.export)
        for b in (self.count_btn, self.receive_btn, self.export_btn):
            low.addWidget(b)
        lay.addLayout(low)
        for signal in (state.stock_changed, state.laser_changed, state.ledger_changed):
            signal.connect(self.refresh)
        self.refresh()

    # ---------------------------------------------------------------------
    def _origin(self) -> dict[int, tuple[str, bool]]:
        """id(item) -> (source, the balance is known): a source with balances, or documents of this program."""
        moved = {_key(m.code) for m in self.state.ledger.movements if m.code}
        out: dict[int, tuple[str, bool]] = {}
        for name in self.state.active_sources:
            source = self.state.stock_sources.get(name)
            if source is None:
                continue
            for item in source.items:
                if id(item) not in out:
                    out[id(item)] = (name, source.has_quantities or _key(item.code) in moved)
        return out

    def refresh(self) -> None:
        self.lines = steel.steel_lines(self.state.stock, self.state.cut_queue.programs, self.state.settings.densities,
                                       self._origin())
        self._show()

    def _show(self) -> None:
        kind = KINDS.get(self.kind.currentText())
        family = self.family.currentData()
        words = self.search.text().strip().lower().split()
        shown = []
        for s in self.lines:
            if kind == "need" and s.status not in NEED:
                continue
            if kind not in (None, "need") and s.form != kind:
                continue
            if family and s.family != family:
                continue
            text = f"{s.item.code} {s.item.name} {s.thickness:g} มม. t{s.thickness:g}".lower()
            if words and not all(w in text for w in words):
                continue
            shown.append(s)
        self._shown = shown
        fill(self.table, steel.rows(shown), status_col=steel.HEADERS.index("สถานะ"))
        counts: dict[str, int] = {}
        for s in self.lines:
            counts[s.status] = counts.get(s.status, 0) + 1
        self.chips.set_counts(counts)
        self.summary.setText(steel.summary(self.lines) if self.lines else
                             "ยังไม่มีรายการเหล็ก – กด นำเข้าไฟล์สต็อกเหล็ก… (หรือนำเข้า Express / ไฟล์นับสต๊อค ที่แท็บ สต็อกสโตร์)")

    # ---------------------------------------------------------------------
    def import_file(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์สต็อกเหล็ก", self.state.settings.get("last_dir"),
                                                  "Excel / CSV (*.xlsx *.xlsm *.xls *.csv)")
            if not path:
                return
        try:
            stock = steel.read_register(path)
        except Exception as exc:  # noqa: BLE001 - shown to the user
            self.actions.error("อ่านไฟล์ไม่ได้", str(exc))
            return
        if not stock.items:
            self.actions.error("ไม่พบรายการ", "ไฟล์นี้ไม่มีตารางที่มีหัวคอลัมน์ รหัสสินค้า / ชื่อสินค้า")
            return
        self.state.settings.set("last_dir", str(Path(path).parent))
        self.state.add_stock_source(steel.SOURCE_PREFIX + Path(path).name, stock)
        lines = [s for s in self.lines if s.source == steel.SOURCE_PREFIX + Path(path).name]
        plates = sum(1 for s in lines if s.form == steel.FORM_SHEET)
        self.state.notify(f"นำเข้าสต็อกเหล็ก {len(stock.items)} รายการ (แผ่น {plates})"
                          + ("" if stock.has_quantities else " · ไฟล์ไม่มียอดคงเหลือ: ใช้ยอดจาก Express / ไฟล์นับสต๊อค "
                                                              "หรือ ตรวจนับ เพื่อตั้งยอด"))

    def make_doc(self, doc_type: str) -> None:
        rows = selected_rows(self.table)
        picked = [self._shown[r] for r in rows if r < len(self._shown)]
        if not picked:
            self.actions.error("เลือกรายการ", "เลือกแถวเหล็กที่จะ" + ("ตรวจนับ" if doc_type == "AJ" else "รับเข้า") + "ก่อน")
            return
        dialog = QtyDialog(doc_type, picked, self)
        if not dialog.exec():
            dialog.deleteLater()
            return
        lines = []
        for s, qty in zip(picked, dialog.values()):
            change = qty - s.on_hand if doc_type == "AJ" else qty
            if abs(change) < 1e-9:
                continue
            note = f"นับได้ {qty:g} (เดิม {s.on_hand:g})" if doc_type == "AJ" else "รับเหล็กเข้า"
            lines.append(DocLine(s.item.code, s.item.name, round(change, 3), s.item.unit_name, s.item.location or "01",
                                 s.item.unit_cost, note))
        dialog.deleteLater()
        if not lines:
            self.state.notify("ยอดไม่เปลี่ยน – ไม่ได้ร่างเอกสาร")
            return
        doc = self.state.ledger.new_doc(doc_type, lines, remark="สต็อกเหล็ก" + (" (ตรวจนับ)" if doc_type == "AJ" else ""),
                                        date=date.today().isoformat())
        self.state.save_library()
        self.state.ledger_changed.emit()
        self.state.notify(f"ร่าง {doc.doc_no} {len(lines)} รายการ – ตรวจแล้วกด บันทึก ในหน้า เบิก/รับ สต็อก")
        self.actions.go("movements")

    def export(self) -> None:
        path = self.actions.save_path("ส่งออกสต็อกเหล็ก", f"สต็อกเหล็ก_{date.today():%Y%m%d}.xlsx", "Excel (*.xlsx)")
        if not path:
            return
        steel.export_lines(self._shown, path)
        self.state.notify(f"ส่งออก {Path(path).name} แล้ว ({len(self._shown)} รายการ)")


class QtyDialog(QDialog):
    """Counted sheets (AJ) or sheets received (RR) of the chosen steel items."""

    def __init__(self, doc_type: str, lines: list[steel.SteelLine], parent=None):
        super().__init__(parent)
        count = doc_type == "AJ"
        self.setWindowTitle("ตรวจนับเหล็ก (ใบปรับยอด AJ)" if count else "รับเหล็กเข้า (ใบรับ RR)")
        fit_to_screen(self, 760, 420)
        lay = QVBoxLayout(self)
        hint = QLabel("ใส่จำนวนที่นับได้จริง – ระบบร่างใบปรับยอดเฉพาะส่วนต่าง" if count else
                      "ใส่จำนวนที่รับเข้า – ระบบร่างใบรับสินค้า (ซื้อ)")
        hint.setObjectName("Hint")
        lay.addWidget(hint)
        self.table = QTableWidget(len(lines), 5)
        self.table.setHorizontalHeaderLabels(["รหัสสินค้า", "ชื่อสินค้า", "หน่วย", "ยอดในโปรแกรม",
                                              "นับได้" if count else "รับเข้า"])
        self.table.verticalHeader().setVisible(False)
        for i, w in enumerate([110, 330, 60, 100, 110]):
            self.table.setColumnWidth(i, w)
        self.spins: list[QDoubleSpinBox] = []
        for r, s in enumerate(lines):
            for c, text in enumerate((s.item.code, s.item.name, s.item.unit_name, f"{s.on_hand:g}" if s.counted else "–")):
                cell = QTableWidgetItem(text)
                cell.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
                self.table.setItem(r, c, cell)
            spin = QDoubleSpinBox()
            spin.setRange(0, 1_000_000)
            spin.setDecimals(2)
            spin.setValue(max(0.0, s.on_hand) if count else 0)
            self.table.setCellWidget(r, 4, spin)
            self.spins.append(spin)
        lay.addWidget(self.table, 1)
        box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        box.button(QDialogButtonBox.Ok).setText("ร่างเอกสาร")
        box.button(QDialogButtonBox.Ok).setProperty("kind", "primary")
        box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)

    def values(self) -> list[float]:
        return [s.value() for s in self.spins]
