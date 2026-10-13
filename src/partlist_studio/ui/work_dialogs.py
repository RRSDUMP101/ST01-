"""Dialogs of the work flow: model variant (เลือกรุ่นย่อย), new item code (ตั้งรหัสใหม่), revision compare (เทียบ Rev.)."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QDate, Qt
from PySide6.QtGui import QBrush, QGuiApplication
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDateEdit, QDialog, QDialogButtonBox, QFileDialog, QGridLayout,
                               QHBoxLayout, QLabel, QLineEdit, QPushButton, QSpinBox, QVBoxLayout)

from ..core import code_rules, revision
from ..core.company_files import ModelBOM
from ..core.express_codes import (ST_NONE, VARIANT_BRANDS, VARIANT_HEIGHTS, VARIANT_LENGTHS, Resolved,
                                  resolve_variant, resolved_to_parts, row_options, summary)
from ..core.models import Part, PartList
from ..core.stock import find_by_code
from . import theme
from .state import AppState
from .widgets import button, fill, table

AS_SHEET = "ตามแบบ"
ST_MANUAL = "เลือกเอง"


def _buttons(dialog: QDialog, ok_text: str) -> QDialogButtonBox:
    box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
    box.button(QDialogButtonBox.Ok).setText(ok_text)
    box.button(QDialogButtonBox.Ok).setProperty("kind", "primary")
    box.button(QDialogButtonBox.Cancel).setText("ยกเลิก")
    box.accepted.connect(dialog.accept)
    box.rejected.connect(dialog.reject)
    return box


# --------------------------------------------------------------------------
class VariantDialog(QDialog):
    """Pick brand / stall height / body length of a model; every row gets its Express code at once."""

    COLS = ["ลำดับ", "รายการในแบบ", "ข้าง", "ต่อคัน", "รหัส Express", "ชื่อใน Express", "คงเหลือ", "การจับคู่",
            "รหัสเดิม"]

    def __init__(self, state: AppState, model: ModelBOM, for_job: bool = False, parent=None):
        super().__init__(parent)
        self.state, self.model, self.for_job = state, model, for_job
        self.express = state.express_stock()
        self.rows: list[Resolved] = []
        self.add_to_current = False
        self.setWindowTitle(f"เลือกรุ่นย่อย – {model.name}")
        self.resize(1180, 680)
        lay = QVBoxLayout(self)
        cap = QLabel(model.title or model.name)
        cap.setObjectName("CardTitle")
        lay.addWidget(cap)
        grid = QGridLayout()
        self.brand = QComboBox()
        self.brand.addItems([AS_SHEET, *VARIANT_BRANDS])
        self.height = QComboBox()
        self.height.addItems([AS_SHEET, *VARIANT_HEIGHTS])
        self.length = QComboBox()
        self.length.addItems([AS_SHEET, *VARIANT_LENGTHS])
        self.sets = QSpinBox()
        self.sets.setRange(1, 999)
        self.sets.setSuffix(" คัน")
        for i, (label, w) in enumerate((("รุ่นรถ", self.brand), ("ความสูงคอก", self.height),
                                        ("ความยาวกระบะ", self.length), ("จำนวน", self.sets))):
            grid.addWidget(QLabel(label), 0, i * 2)
            grid.addWidget(w, 0, i * 2 + 1)
        if for_job:
            self.job_no = QLineEdit(state.partlist.info.so_no)
            self.job_no.setPlaceholderText("เลขที่ SO / งาน")
            self.customer = QLineEdit(state.partlist.info.customer)
            self.due = QDateEdit(QDate.currentDate().addDays(14))
            self.due.setCalendarPopup(True)
            self.due.setDisplayFormat("dd/MM/yyyy")
            self.use_stock = QCheckBox("ใช้ชิ้นส่วนที่มีในสต็อกก่อน (ผลิตเฉพาะส่วนที่ขาด)")
            self.use_stock.setChecked(True)
            for i, (label, w) in enumerate((("SO / งาน", self.job_no), ("ลูกค้า", self.customer),
                                            ("กำหนดส่ง", self.due))):
                grid.addWidget(QLabel(label), 1, i * 2)
                grid.addWidget(w, 1, i * 2 + 1)
            grid.addWidget(self.use_stock, 1, 6, 1, 2)
        lay.addLayout(grid)
        self.summary = QLabel()
        self.summary.setObjectName("Hint")
        self.summary.setWordWrap(True)
        lay.addWidget(self.summary)
        self.table = table(self.COLS, [45, 220, 45, 50, 320, 220, 75, 110])
        lay.addWidget(self.table, 1)
        box = _buttons(self, "สร้างงานผลิต" if for_job else "สร้าง Part List ใหม่")
        if not for_job:
            add = QPushButton("เพิ่มเข้า Part List ปัจจุบัน")
            add.clicked.connect(self._add)
            box.addButton(add, QDialogButtonBox.ActionRole)
        lay.addWidget(box)
        for combo in (self.brand, self.height, self.length):
            combo.currentIndexChanged.connect(self.refresh)
        self.refresh()

    def _add(self) -> None:
        self.add_to_current = True
        self.accept()

    def _choice(self, combo: QComboBox) -> str:
        return "" if combo.currentText() == AS_SHEET else combo.currentText()

    @property
    def variant_text(self) -> str:
        return " ".join(x for x in (self._choice(self.brand), self._choice(self.height), self._choice(self.length)) if x)

    def refresh(self) -> None:
        if self.express is None:
            self.rows = [Resolved(self.model.name, r.item_no, r.raw_code or ", ".join(r.codes), r.name, r.qty,
                                  r.qty_text, status="ยังไม่มีข้อมูล Express", remark=r.remark, image=r.image,
                                  size=r.size) for r in self.model.rows]
            self.summary.setText("ยังไม่ได้นำเข้า Express (รายงานรายละเอียดสินค้า STMASR0200) – ใช้รหัสตามแบบ "
                                 "· นำเข้าที่หน้า Express แล้วเปิดหน้าต่างนี้ใหม่เพื่อได้รหัส Express")
        else:
            self.rows = resolve_variant(self.model, self.express, self._choice(self.brand), self._choice(self.height),
                                        self._choice(self.length))
            st = summary({"x": self.rows})
            self.summary.setText("รหัสจาก Express: " + " · ".join(f"{k} {v}" for k, v in st.items())
                                 + " – แถวสีส้ม/แดง เลือกรหัสในช่อง รหัส Express ได้ (พิมพ์เองได้)")
        stock = self.state.stock
        for i in range(self.table.rowCount()):
            self.table.removeCellWidget(i, 4)
        values = []
        for r in self.rows:
            item = find_by_code(r.code, stock) if r.code else None
            values.append([r.item_no, r.name, r.side, r.qty, "", r.express_name,
                           f"{item.on_hand:g} {item.unit_name}" if item else "", r.status, r.old_code])
        fill(self.table, values, status_col=7)
        for i, r in enumerate(self.rows):
            combo = QComboBox()
            combo.setEditable(True)
            opts = row_options(r, self.express) if self.express else []
            if not r.code and r.old_code:
                combo.addItem(f"{r.old_code}  (รหัสในแบบ)", r.old_code.split(",")[0].strip())
            elif not r.code:
                combo.addItem("", "")
            for code, name in opts:
                combo.addItem(f"{code}  {name}", code)
            combo.setCurrentIndex(0)
            combo.lineEdit().setCursorPosition(0)
            combo.setToolTip(combo.currentText())
            combo.currentIndexChanged.connect(lambda _i, row=i, cb=combo: self._picked(row, cb))
            combo.lineEdit().editingFinished.connect(lambda row=i, cb=combo: self._typed(row, cb))
            self.table.setCellWidget(i, 4, combo)

    def _set_code(self, row: int, code: str) -> None:
        r = self.rows[row]
        item = find_by_code(code, self.express) if (code and self.express) else None
        r.code = item.code if item else code
        r.express_name = item.name if item else ""
        r.status = ST_MANUAL if code else ST_NONE
        self.table.item(row, 5).setText(r.express_name)
        st = self.table.item(row, 7)
        st.setText(r.status)
        st.setForeground(QBrush(theme.status_color("พร้อม" if code else ST_NONE)))

    def _picked(self, row: int, combo: QComboBox) -> None:
        self._set_code(row, combo.currentData() or "")

    def _typed(self, row: int, combo: QComboBox) -> None:
        text = combo.currentText().split("  ")[0].strip()
        if text != (combo.currentData() or ""):
            self._set_code(row, text)

    def parts(self) -> list[Part]:
        """Rows for ONE bed with the chosen codes."""
        return resolved_to_parts(self.model, self.rows, 1, self.express)


# --------------------------------------------------------------------------
class NewCodeDialog(QDialog):
    """ตั้งรหัสใหม่ตามกฎเดียวกับ Express and check it is not used yet."""

    def __init__(self, state: AppState, name: str = "", parent=None):
        super().__init__(parent)
        self.state = state
        self.stock = state.express_stock() or state.stock
        self.setWindowTitle("ตั้งรหัสสินค้าใหม่ (ตามกฎรหัส Express)")
        self.resize(720, 460)
        lay = QVBoxLayout(self)
        hint = QLabel("รูปแบบ: <b>RRS-&lt;รุ่น&gt;-&lt;เลขชิ้นส่วน 3 หลัก&gt;-&lt;ข้าง&gt;-&lt;ขนาด&gt;-&lt;รุ่นย่อย&gt;</b> "
                      "เช่น RRS-T-024-L-84-CHAMP · เลขชิ้นส่วนเดียวกันทุกรุ่นรถ (024 = บังอาย) · ไม่เกิน 20 ตัว "
                      "(รายงานข้อความ Express ตัดเหลือ 16)")
        hint.setWordWrap(True)
        hint.setObjectName("Hint")
        lay.addWidget(hint)
        grid = QGridLayout()
        self.name = QLineEdit(name)
        self.name.setPlaceholderText("ชื่อสินค้า เช่น บังอาย T90(ซ้าย)")
        self.brand = QComboBox()
        for k, v in code_rules.BRANDS.items():
            self.brand.addItem(f"{k} – {v}", k)
        self.side = QComboBox()
        self.side.addItem("ตามชื่อ / ไม่มีข้าง", "")
        self.side.addItem("L – ซ้าย", "L")
        self.side.addItem("R – ขวา", "R")
        self.sizes = QLineEdit()
        self.sizes.setPlaceholderText("เช่น 84 หรือ 209-2-50 (ว่าง = อ่านจากชื่อ)")
        self.variants = QLineEdit()
        self.variants.setPlaceholderText("เช่น CHAMP, PR, NEW (คั่นด้วย ,)")
        self.number = QLineEdit()
        self.number.setPlaceholderText("ว่าง = ใช้เลขเดิมของชิ้นส่วนชื่อนี้ หรือเลขถัดไป")
        for i, (label, w) in enumerate((("ชื่อสินค้า", self.name), ("รุ่นรถ", self.brand), ("ข้าง", self.side),
                                        ("ขนาด", self.sizes), ("รุ่นย่อย", self.variants),
                                        ("เลขชิ้นส่วน", self.number))):
            grid.addWidget(QLabel(label), i, 0)
            grid.addWidget(w, i, 1)
        lay.addLayout(grid)
        self.code = QLabel()
        self.code.setStyleSheet(f"font-size: 20px; font-weight: 700; color: {theme.NAVY};")
        self.code.setTextInteractionFlags(Qt.TextSelectableByMouse)
        lay.addWidget(self.code)
        self.info = QLabel()
        self.info.setWordWrap(True)
        lay.addWidget(self.info, 1)
        row = QHBoxLayout()
        copy = button("คัดลอกรหัส")
        copy.clicked.connect(lambda: QGuiApplication.clipboard().setText(self.result.code))
        row.addWidget(copy)
        row.addStretch(1)
        close = button("ปิด")
        close.clicked.connect(self.accept)
        row.addWidget(close)
        lay.addLayout(row)
        for w in (self.name, self.sizes, self.variants, self.number):
            w.textChanged.connect(self.refresh)
        for w in (self.brand, self.side):
            w.currentIndexChanged.connect(self.refresh)
        self.refresh()

    def refresh(self) -> None:
        sizes = [s for s in self.sizes.text().replace(",", " ").split() if s]
        variants = [v for v in self.variants.text().split(",") if v.strip()]
        self.result = code_rules.new_code(self.stock, self.name.text(), self.brand.currentData(),
                                          self.side.currentData(), sizes, variants, self.number.text().strip())
        self.code.setText(self.result.code)
        lines = [f"เลขชิ้นส่วน: {self.result.number_source}"] if self.result.number_source else []
        if self.result.exists:
            lines.append(f"<span style='color:#D64545'><b>มีรหัสนี้แล้ว</b>: {self.result.existing_name}</span>")
        else:
            lines.append("<span style='color:#2E9D5B'>ยังไม่มีรหัสนี้ใน Express – ใช้ได้</span>")
        lines += [f"<span style='color:#E08A1E'>{w}</span>" for w in self.result.warnings]
        parts = code_rules.parse_code(self.result.code)
        if parts:
            same = [i for i in self.stock.items if (p := code_rules.parse_code(code_rules.canonical(i.code)))
                    and p.number == parts.number][:8]
            if same:
                lines.append("รหัสอื่นที่ใช้เลข " + parts.number + ": " +
                             ", ".join(f"{i.code} ({i.name})" for i in same))
        self.info.setText("<br>".join(lines))


# --------------------------------------------------------------------------
class CompareDialog(QDialog):
    """เทียบ Rev.: two Part Lists / drawings / models."""

    CURRENT = "Part List ปัจจุบัน"
    FILE = "ไฟล์… (.rrspl / .dwg / .dxf / Excel / CSV)"

    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.setWindowTitle("เทียบ Rev. แบบ / Part List")
        self.resize(1100, 640)
        lay = QVBoxLayout(self)
        grid = QGridLayout()
        self.sources = []
        for i, label in enumerate(("เดิม (Rev. ก่อน)", "ใหม่ (Rev. ล่าสุด)")):
            combo = QComboBox()
            combo.addItem(self.FILE)
            combo.addItem(self.CURRENT)
            for m in state.models:
                combo.addItem(f"แบบกระบะ: {m.name}", m.name)
            path = QLineEdit()
            path.setPlaceholderText("เลือกไฟล์")
            browse = button("เลือก…")
            browse.clicked.connect(lambda _c=False, p=path: self._browse(p))
            grid.addWidget(QLabel(label), i, 0)
            grid.addWidget(combo, i, 1)
            grid.addWidget(path, i, 2)
            grid.addWidget(browse, i, 3)
            self.sources.append((combo, path))
        self.sources[1][0].setCurrentIndex(1)
        lay.addLayout(grid)
        row = QHBoxLayout()
        run = button("เทียบ", "accent")
        run.clicked.connect(self.run)
        row.addWidget(run)
        self.only_changes = QCheckBox("แสดงเฉพาะที่เปลี่ยน")
        self.only_changes.setChecked(True)
        self.only_changes.toggled.connect(self._show)
        row.addWidget(self.only_changes)
        row.addStretch(1)
        exp = button("ส่งออก Excel…")
        exp.clicked.connect(self.export)
        row.addWidget(exp)
        lay.addLayout(row)
        self.summary = QLabel("เลือกแบบเดิมและแบบใหม่ แล้วกด เทียบ")
        self.summary.setWordWrap(True)
        lay.addWidget(self.summary)
        self.table = table(revision.COMPARE_HEADERS, [110, 170, 260, 80, 80, 60])
        lay.addWidget(self.table, 1)
        self.changes: list[revision.Change] = []
        self.names = ("", "")
        self.info: list = []

    def _browse(self, edit: QLineEdit) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์", self.state.settings.get("last_dir"),
                                              "Part List / แบบ (*.rrspl *.dwg *.dxf *.xlsx *.xls *.csv)")
        if path:
            edit.setText(path)
            combo = next(c for c, p in self.sources if p is edit)
            combo.setCurrentIndex(0)

    def _load(self, combo: QComboBox, path: QLineEdit) -> tuple[PartList, str]:
        text = combo.currentText()
        if text == self.CURRENT:
            return self.state.partlist, self.CURRENT
        if combo.currentData():
            model = next(m for m in self.state.models if m.name == combo.currentData())
            return PartList(parts=model.to_parts()), text
        if not path.text():
            raise ValueError("ยังไม่ได้เลือกไฟล์")
        pl = revision.partlist_from_file(path.text(), self.state.settings.converter(), self.state.settings.densities)
        return pl, Path(path.text()).name

    def run(self) -> None:
        try:
            (old, a), (new, b) = (self._load(c, p) for c, p in self.sources)
        except Exception as exc:  # noqa: BLE001 - shown to the user
            self.actions.error("อ่านไม่ได้", str(exc))
            return
        self.changes = revision.compare_parts(old.parts, new.parts)
        self.info = revision.compare_info(old, new)
        self.names = (a, b)
        self._show()

    def _show(self) -> None:
        if not self.changes:
            return
        st = revision.summary(self.changes)
        info = " · ".join(f"{label}: {x or '-'} → {y or '-'}" for label, x, y in self.info)
        self.summary.setText(f"<b>{self.names[0]}</b> → <b>{self.names[1]}</b>: "
                             + " · ".join(f"{k} {v}" for k, v in st.items()) + (f"<br>{info}" if info else ""))
        fill(self.table, revision.change_rows(self.changes, not self.only_changes.isChecked()), status_col=0)

    def export(self) -> None:
        if not self.changes:
            return
        path = self.actions.save_path("เทียบ Rev.", "เทียบ Rev.xlsx", "Excel (*.xlsx)")
        if path:
            revision.export_compare(self.changes, path, *self.names, self.info)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

