"""แบบกระบะ - library of model BOMs from "Parts List All Model" (with pictures)."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import (QAbstractItemView, QFileDialog, QHBoxLayout, QHeaderView, QInputDialog,
                               QLabel, QListWidget, QListWidgetItem, QMenu, QMessageBox, QSplitter, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from ...core.company_files import export_models, models_from_partlist, read_company_workbook
from ...core.production import job_from_parts
from ...core.stock import find_by_code
from ..state import AppState
from ..table_models import thumbnail
from ..widgets import PageHeader, button, run_async
from ..work_dialogs import VariantDialog

COLS = ["ภาพ", "ลำดับ", "รหัส", "รายการ", "ขนาด", "จำนวนที่ใช้", "ยอดคงเหลือ", "หมายเหตุ"]


class ModelsPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state = state
        self.actions = actions
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        header = PageHeader("แบบกระบะ (Part List มาตรฐาน)",
                            "Part List ของแต่ละแบบกระบะ/เฟรม จากไฟล์ \"Parts List All Model\" พร้อมรูปประกอบ "
                            "– เลือกแบบแล้วสร้าง Part List ของงาน หรือบันทึก Part List ที่ทำเสร็จเป็นแบบใหม่")
        b = header.add_action(button("นำเข้าไฟล์ Parts List All Model", "primary"))
        b.clicked.connect(self.import_workbook)
        exp = header.add_action(button("ส่งออก ▾"))
        menu = QMenu(exp)
        menu.addAction("แบบที่เลือก (รูปแบบเดียวกับไฟล์บริษัท พร้อมรูป)…", lambda: self._export(selected=True))
        menu.addAction("ทุกแบบ (รูปแบบเดียวกับไฟล์บริษัท พร้อมรูป)…", lambda: self._export(selected=False))
        exp.setMenu(menu)
        lay.addWidget(header)

        split = QSplitter(Qt.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 8, 0)
        self.list = QListWidget()
        self.list.setObjectName("Plain")
        self.list.currentRowChanged.connect(self._show)
        ll.addWidget(self.list, 1)
        row = QHBoxLayout()
        save = button("บันทึก Part List ปัจจุบันเป็นแบบ")
        save.clicked.connect(self._save_current)
        rm = button("ลบแบบ")
        rm.clicked.connect(self._remove)
        row.addWidget(save)
        row.addWidget(rm)
        ll.addLayout(row)
        split.addWidget(left)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        self.caption = QLabel()
        self.caption.setObjectName("CardTitle")
        self.caption.setWordWrap(True)
        rl.addWidget(self.caption)
        self.table = QTableWidget(0, len(COLS))
        self.table.setHorizontalHeaderLabels(COLS)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.verticalHeader().setVisible(False)
        self.table.verticalHeader().setDefaultSectionSize(64)
        self.table.setIconSize(QSize(110, 60))
        self.table.setAlternatingRowColors(True)
        hh = self.table.horizontalHeader()
        hh.setSectionResizeMode(QHeaderView.Interactive)
        hh.setStretchLastSection(True)
        for i, w in enumerate([120, 50, 170, 240, 80, 90, 90]):
            self.table.setColumnWidth(i, w)
        rl.addWidget(self.table, 1)
        use = QHBoxLayout()
        hint = QLabel("เลือกรุ่นรถ / ความสูงคอก / ความยาวกระบะ แล้วได้รหัส Express ของทุกแถวทันที")
        hint.setObjectName("Hint")
        use.addWidget(hint)
        use.addStretch(1)
        job = button("สร้างงานผลิต (SO) จากแบบนี้…")
        job.clicked.connect(self._new_job)
        new = button("สร้าง Part List จากแบบนี้…", "primary")
        new.clicked.connect(self._use)
        use.addWidget(job)
        use.addWidget(new)
        rl.addLayout(use)
        split.addWidget(right)
        split.setSizes([260, 1000])
        lay.addWidget(split, 1)

        state.models_changed.connect(self.refresh)
        state.stock_changed.connect(lambda: self._show(self.list.currentRow()))
        self.refresh()

    # ---------------------------------------------------------------------
    def refresh(self) -> None:
        current = self.list.currentRow()
        self.list.blockSignals(True)
        self.list.clear()
        for m in self.state.models:
            item = QListWidgetItem(f"{m.name}  ·  {len(m.rows)} รายการ")
            item.setSizeHint(QSize(200, 34))
            item.setToolTip(m.title)
            self.list.addItem(item)
        self.list.blockSignals(False)
        if self.state.models:
            self.list.setCurrentRow(min(max(current, 0), len(self.state.models) - 1))
        else:
            self._show(-1)

    def _model(self):
        row = self.list.currentRow()
        return self.state.models[row] if 0 <= row < len(self.state.models) else None

    def _show(self, row: int) -> None:
        model = self.state.models[row] if 0 <= row < len(self.state.models) else None
        self.table.setRowCount(0)
        if model is None:
            self.caption.setText("ยังไม่มีแบบ – นำเข้าไฟล์ \"7. รายการชิ้นส่วนประกอบกระบะ Parts List All Model.xlsx\"")
            return
        self.caption.setText(model.title or model.name)
        stock = self.state.stock
        self.table.setRowCount(len(model.rows))
        for r, mr in enumerate(model.rows):
            pic = QTableWidgetItem()
            pix = thumbnail(mr.image, 60)
            if pix:
                pic.setIcon(pix)
                pic.setToolTip(f"<img src='{mr.image}' width='420'>")
            self.table.setItem(r, 0, pic)
            found = [find_by_code(c, stock) for c in mr.codes]
            found = [f for f in found if f]
            balance = ", ".join(f"{f.on_hand:g} {f.unit_name}" for f in found) if found else (
                "ไม่พบในสต็อก" if mr.codes and stock.items else "")
            values = [mr.item_no, mr.raw_code or ", ".join(mr.codes), mr.name, mr.size,
                      mr.qty_text or f"{mr.qty:g}", balance, mr.remark]
            for c, text in enumerate(values, start=1):
                item = QTableWidgetItem(text)
                if c == 2 and mr.codes and mr.raw_code and mr.codes != [mr.raw_code]:
                    item.setToolTip("อ่านเป็นรหัส: " + ", ".join(mr.codes))
                self.table.setItem(r, c, item)

    def import_workbook(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์ Parts List All Model", self.state.settings.get("last_dir"),
                                                  "Excel (*.xlsx *.xlsm *.xls)")
        if not path:
            return
        self.state.settings.set("last_dir", str(Path(path).parent))
        image_dir = self.state.image_dir() / Path(path).stem

        def done(book):
            if book.models:
                self.state.set_models(book.models)
            for sheet, stock in book.stocks.items():
                self.state.add_stock_source(f"{Path(path).stem} / {sheet}", stock)
            bits = [f"แบบ {len(book.models)} แบบ"] + [f"{s} {len(v.items)} รายการ" for s, v in book.stocks.items()]
            self.state.notify("นำเข้า: " + " · ".join(bits))
            if not book.models and not book.stocks:
                self.actions.error("ไม่พบข้อมูล", "ไม่พบแท็บที่มีหัวตาราง ลำดับ / รหัส / รายการ / จำนวนที่ใช้")

        run_async(read_company_workbook, done, lambda e: self.actions.error("อ่านไฟล์ไม่ได้", e), path, image_dir)

    def _use(self) -> None:
        """Part List from the model: variant dialog -> Express codes -> × beds."""
        model = self._model()
        if model is None:
            return
        dialog = VariantDialog(self.state, model, parent=self)
        if not dialog.exec():
            return
        sets = dialog.sets.value()
        parts = dialog.parts()  # quantities per bed; the number of beds is the job's build_qty
        pl = self.state.partlist
        if not dialog.add_to_current:
            if pl.parts and QMessageBox.question(self, "สร้าง Part List ใหม่",
                                                 f"แทนที่ Part List เดิม {len(pl.parts)} รายการ?") != QMessageBox.Yes:
                return
            pl.parts = parts
            pl.info.job_type = " ".join(x for x in (model.name, dialog.variant_text) if x)
            pl.info.build_qty = sets
            if dialog.variant_text:
                pl.info.vehicle_model = pl.info.vehicle_model or dialog.variant_text
        else:
            pl.parts.extend(parts)
        pl.renumber()
        self.state.mark_dirty()
        self.state.notify(f"เพิ่ม {len(parts)} รายการจากแบบ {model.name} (จำนวนผลิต {pl.info.build_qty} คัน)"
                          + (f" ({dialog.variant_text})" if dialog.variant_text else ""))

    def _new_job(self) -> None:
        model = self._model()
        if model is None:
            return
        dialog = VariantDialog(self.state, model, for_job=True, parent=self)
        if not dialog.exec():
            return
        job_no = dialog.job_no.text().strip() or f"JOB-{len(self.state.jobs) + 1:03d}"
        if any(j.job_no == job_no for j in self.state.jobs):
            self.actions.error("เลขที่งานซ้ำ", f"มีงาน {job_no} แล้ว")
            return
        job = job_from_parts(job_no, dialog.parts(), dialog.sets.value(), self.state.stock,
                             dialog.use_stock.isChecked(), self.state.jobs, model=model.name, title=model.title, body=model.name,
                             customer=dialog.customer.text().strip(), variant=dialog.variant_text,
                             due=dialog.due.date().toString("yyyy-MM-dd"))
        self.state.jobs.append(job)
        self.state.save_jobs()
        self.state.notify(f"เปิดงาน {job_no}: {model.name} × {dialog.sets.value()} คัน · "
                          f"ต้องผลิต {sum(1 for p in job.parts if p.to_make > 0)} รายการ")
        self.actions.go("production")

    def _save_current(self) -> None:
        if not self.state.partlist.parts:
            self.actions.error("ยังไม่มี Part List", "สร้างหรือนำเข้า Part List ก่อน")
            return
        default = self.state.partlist.info.job_type or self.state.partlist.info.drawing_no
        name, ok = QInputDialog.getText(self, "บันทึกเป็นแบบ", "ชื่อแบบ:", text=default)
        if ok and name.strip():
            self.state.set_models([models_from_partlist(self.state.partlist, name.strip())])

    def _remove(self) -> None:
        model = self._model()
        if model and QMessageBox.question(self, "ลบแบบ", f"ลบแบบ {model.name}?") == QMessageBox.Yes:
            self.state.models.remove(model)
            self.state.save_library()
            self.state.models_changed.emit()

    def _export(self, selected: bool) -> None:
        models = [self._model()] if selected else self.state.models
        models = [m for m in models if m]
        if not models:
            return
        name = f"{models[0].name}.xlsx" if selected else "รายการชิ้นส่วนประกอบกระบะ Parts List All Model.xlsx"
        path = self.actions.save_path("ส่งออกแบบกระบะ", name, "Excel (*.xlsx)")
        if path:
            export_models(models, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({len(models)} แบบ)")
