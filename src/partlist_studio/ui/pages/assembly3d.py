"""แท็บ ประกอบ 3D: ชิ้นส่วนแยกกลุ่ม · ภาพ 3 มิติหมุน/ซูมได้ · ขั้นตอนประกอบทีละขั้นพร้อมสาธิต (ชิ้นส่วนเลื่อนเข้าตำแหน่ง)."""

from __future__ import annotations

import tempfile
from pathlib import Path
from struct import error as struct_error

from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtWidgets import (QCheckBox, QComboBox, QFileDialog, QHBoxLayout, QLabel, QLineEdit, QMessageBox,
                               QPlainTextEdit, QSlider, QSplitter, QTableWidgetItem, QVBoxLayout, QWidget)

from ...core import assembly3d as a3
from ...core import install_manual as im
from ..assembly_view import Assembly3DView
from ..state import AppState
from ..widgets import button, fill, table

PART_HEADERS = ["แสดง", "ชิ้นส่วน", "กลุ่ม", "ขั้น", "ขนาด", "Part No."]
C_SHOW, C_NAME, C_GROUP, C_STEP, C_SIZE, C_PN = range(6)
BOM_HEADERS = ["#", "ชิ้นส่วน", "ขนาด", "Part No.", "จำนวน"]
MODEL_FILTER = "โมเดล 3 มิติ (*.obj *.stl)"
ALL_GROUPS = "ทุกกลุ่ม"
JOB_KEYS = ("product", "cab", "body_length", "body_width", "body_height", "cab_gap", "bolt_size", "bolt_grade",
            "rigid_subframe", "lamp_low", "lamp_high", "lamp_from_edge")


class AssemblyTab(QWidget):
    def __init__(self, state: AppState, get_job, parent=None):
        super().__init__(parent)
        self.state, self.get_job = state, get_job
        self.model: a3.AssemblyModel | None = None
        self.step = 0  # 0 = the whole assembly · 1 … = that step
        self._key = None
        self._loading = False
        self._playing = False

        lay = QVBoxLayout(self)
        row = QHBoxLayout()
        self.title = QLabel()
        self.title.setObjectName("CardTitle")
        row.addWidget(self.title, 1)
        for text, slot, kind, tip in (
                ("สร้างจากงานนี้", lambda: self.rebuild(force=True), "", "โมเดลตัวอย่างจากขนาดในแท็บ ข้อมูลงาน"),
                ("นำเข้าโมเดล (OBJ / STL)…", lambda: self.import_files(), "accent",
                 "โมเดลจริงจาก CAD: ส่งออกเป็น OBJ (ทั้งชุด – 1 object ต่อ 1 ชิ้น) หรือ STL (1 ไฟล์ต่อ 1 ชิ้น)"),
                ("เปิด…", lambda: self.open_model(), "", "เปิดไฟล์คู่มือประกอบ (.rrsasm)"),
                ("บันทึก…", lambda: self.save_model(), "", "บันทึกโมเดล + ขั้นตอน (.rrsasm)"),
                ("คู่มือประกอบ PDF", lambda: self.export_pdf(), "primary", "ภาพ 3 มิติทุกขั้น + ตารางชิ้นส่วน + จุดตรวจ")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)
        self.note = QLabel()
        self.note.setObjectName("Hint")
        self.note.setWordWrap(True)
        lay.addWidget(self.note)

        split = QSplitter(Qt.Horizontal)
        split.addWidget(self._parts_panel())
        split.addWidget(self._view_panel())
        split.addWidget(self._step_panel())
        split.setSizes([300, 640, 360])
        split.setStretchFactor(1, 1)
        lay.addWidget(split, 1)
        self._play_timer = QTimer(self)
        self._play_timer.setSingleShot(True)
        self._play_timer.timeout.connect(self._play_next)
        self.rebuild(force=True)

    # ---- panels -----------------------------------------------------------
    def _parts_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        row.addWidget(QLabel("กลุ่ม"))
        self.groups = QComboBox()
        self.groups.setToolTip("เลือกกลุ่มเพื่อดูเฉพาะชิ้นส่วนของกลุ่มนั้น")
        self.groups.currentIndexChanged.connect(self._group_changed)
        row.addWidget(self.groups, 1)
        lay.addLayout(row)
        self.parts = table(PART_HEADERS, [44, 150, 90, 40, 110, 80], editable=True)
        self.parts.itemChanged.connect(self._part_edited)
        self.parts.itemSelectionChanged.connect(self._part_row_selected)
        lay.addWidget(self.parts, 1)
        self.part_info = QLabel("คลิกชิ้นส่วนในภาพหรือในตารางเพื่อดูรายละเอียด · ดับเบิลคลิกในภาพเพื่อซูมเข้า")
        self.part_info.setObjectName("Hint")
        self.part_info.setWordWrap(True)
        lay.addWidget(self.part_info)
        return w

    def _view_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        self.view = Assembly3DView()
        self.view.part_clicked.connect(self._part_clicked)
        self.view.animation_done.connect(self._animation_done)
        bar = QHBoxLayout()
        for text, name in (("ISO", "iso"), ("ISO 2", "iso2"), ("บน", "top"), ("หน้า", "front"), ("ท้าย", "rear"), ("ข้าง", "side")):
            b = button(text, tooltip=f"มุมมอง {text}")
            b.clicked.connect(lambda _c=False, n=name: self.view.set_view(n))
            bar.addWidget(b)
        for text, slot, tip in (("พอดีจอ", lambda: self.view.fit(), "แสดงทั้งหมดให้พอดีจอ (F)"),
                                ("ซูมขั้นนี้", self.zoom_step, "ซูมเข้าที่ชิ้นส่วนของขั้นปัจจุบัน"),
                                ("+", lambda: self.view.zoom_by(1.3), "ซูมเข้า"), ("−", lambda: self.view.zoom_by(1 / 1.3), "ซูมออก"),
                                ("Y↔Z", self.swap_up, "โมเดลที่นำเข้านอนตะแคง: สลับแกนตั้ง (CAD บางตัวใช้ Y เป็นแกนตั้ง)")):
            b = button(text, tooltip=tip)
            b.clicked.connect(slot)
            bar.addWidget(b)
        bar.addStretch(1)
        lay.addLayout(bar)
        lay.addWidget(self.view, 1)
        bar = QHBoxLayout()
        bar.addWidget(QLabel("แยกชิ้น"))
        self.explode = QSlider(Qt.Horizontal)
        self.explode.setRange(0, 100)
        self.explode.setToolTip("เลื่อนเพื่อแยกชิ้นส่วนออกจากกัน (exploded view) – 0 = ประกอบแล้ว")
        self.explode.valueChanged.connect(lambda v: self.view.set_explode(v / 100))
        bar.addWidget(self.explode, 1)
        self.labels = QCheckBox("หมายเลข")
        self.labels.setChecked(True)
        self.labels.toggled.connect(self._options_changed)
        self.ghost = QCheckBox("ชิ้นที่ยังไม่ประกอบ (จาง)")
        self.ghost.toggled.connect(self._options_changed)
        self.vehicle = QCheckBox("รถ (อ้างอิง)")
        self.vehicle.setChecked(True)
        self.vehicle.toggled.connect(self._options_changed)
        for c in (self.labels, self.ghost, self.vehicle):
            bar.addWidget(c)
        lay.addLayout(bar)
        hint = QLabel("ลากซ้าย = หมุน · ลากขวา / Shift+ลาก = เลื่อน · ล้อเมาส์ = ซูม · ดับเบิลคลิกชิ้น = ซูมเข้า")
        hint.setObjectName("Hint")
        lay.addWidget(hint)
        return w

    def _step_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        self.step_no = QLabel()
        self.step_no.setObjectName("PageTitle")
        lay.addWidget(self.step_no)
        self.step_title = QLineEdit()
        self.step_title.setPlaceholderText("ชื่อขั้นตอน")
        self.step_title.editingFinished.connect(self._step_text_edited)
        lay.addWidget(self.step_title)
        self.step_detail = QPlainTextEdit()
        self.step_detail.setPlaceholderText("วิธีประกอบ / ตำแหน่ง")
        self.step_detail.setMaximumHeight(120)
        self.step_detail.textChanged.connect(self._step_text_edited)
        lay.addWidget(self.step_detail)
        self.step_info = QLabel()
        self.step_info.setWordWrap(True)
        self.step_info.setTextFormat(Qt.RichText)
        lay.addWidget(self.step_info)
        self.bom = table(BOM_HEADERS, [30, 150, 100, 70, 50])
        lay.addWidget(self.bom, 1)
        self.done = QCheckBox("ประกอบขั้นนี้เสร็จ และตรวจแล้ว")
        self.done.toggled.connect(self._done_toggled)
        lay.addWidget(self.done)
        row = QHBoxLayout()
        for text, slot, kind, tip in (("ภาพรวม", lambda: self.go(0), "", "ทุกชิ้นส่วน"),
                                      ("◀ ก่อนหน้า", lambda: self.go(self.step - 1), "", "ขั้นก่อนหน้า"),
                                      ("ถัดไป ▶", lambda: self.go(self.step + 1), "primary", "ขั้นถัดไป (ชิ้นส่วนเลื่อนเข้าตำแหน่ง)")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)
        row = QHBoxLayout()
        self.play_btn = button("▶ เล่นสาธิตทั้งหมด", "accent", "เล่นการประกอบทุกขั้นต่อเนื่อง")
        self.play_btn.clicked.connect(self.toggle_play)
        replay = button("↻ เล่นขั้นนี้ซ้ำ", tooltip="ดูชิ้นส่วนของขั้นนี้เลื่อนเข้าตำแหน่งอีกครั้ง")
        replay.clicked.connect(lambda: self.go(self.step))
        row.addWidget(self.play_btn)
        row.addWidget(replay)
        lay.addLayout(row)
        self.progress = QLabel()
        self.progress.setObjectName("Hint")
        lay.addWidget(self.progress)
        return w

    # ---- model ------------------------------------------------------------
    def job_changed(self) -> None:
        """The job was edited: a model built from the job follows it; an imported or edited one stays."""
        self.rebuild(force=False)

    def rebuild(self, force: bool = False) -> None:
        job = self.get_job()
        key = tuple(getattr(job, k) for k in JOB_KEYS)
        if not force and (self.model is not None and self.model.source != "auto" or key == self._key):
            self._show_step()  # the done marks may have changed (a job opened)
            return
        self._key = key
        self.set_model(a3.build_for_job(job), keep_step=not force)

    def set_model(self, model: a3.AssemblyModel | None, keep_step: bool = False) -> None:
        self.stop_play()
        self.model = model
        self.step = min(self.step, len(model.steps)) if (model and keep_step) else 0
        self.view.hidden_groups, self.view.hidden_parts = set(), set()
        self.view.set_model(model, keep_view=keep_step and model is not None)
        self.title.setText(model.name if model else "ยังไม่มีโมเดล 3 มิติสำหรับผลิตภัณฑ์นี้")
        problems = model.problems() if model else []
        self.note.setText(" · ".join(x for x in ((model.note if model else
                          "หางลากยังไม่มีโมเดลตัวอย่าง – นำเข้าโมเดลจริงจาก CAD (OBJ / STL)"), *problems) if x))
        self._fill_groups()
        self._fill_parts()
        self._options_changed()
        self.view.set_step(self.step or None, animate=False)
        self._show_step()

    def _fill_groups(self) -> None:
        self.groups.blockSignals(True)
        self.groups.clear()
        self.groups.addItem(ALL_GROUPS)
        for g in (self.model.groups() if self.model else []):
            if g != a3.REF_GROUP:
                self.groups.addItem(f"{g}  ({sum(1 for p in self.model.parts if p.group == g)})", g)
        self.groups.blockSignals(False)

    def _fill_parts(self) -> None:
        parts = [p for p in (self.model.parts if self.model else []) if p.step > 0]
        self._loading = True
        fill(self.parts, [["", p.name, p.group, p.step, p.size, p.part_no] for p in parts], data=[p.id for p in parts])
        for r, p in enumerate(parts):
            show = self.parts.item(r, C_SHOW)
            show.setFlags((show.flags() | Qt.ItemIsUserCheckable) & ~Qt.ItemIsEditable)
            show.setCheckState(Qt.Unchecked if p.id in self.view.hidden_parts else Qt.Checked)
            size = self.parts.item(r, C_SIZE)
            size.setFlags(size.flags() & ~Qt.ItemIsEditable)
        self._loading = False

    def _part_at(self, row: int) -> a3.Part3D | None:
        item = self.parts.item(row, 0)
        return self.model.part(item.data(Qt.UserRole)) if (item and self.model) else None

    def _part_edited(self, item: QTableWidgetItem) -> None:
        if self._loading or not self.model:
            return
        part = self._part_at(item.row())
        if part is None:
            return
        col, text = item.column(), item.text().strip()
        if col == C_SHOW:
            (self.view.hidden_parts.discard if item.checkState() == Qt.Checked else self.view.hidden_parts.add)(part.id)
            self.view.update()
            return
        if col == C_NAME and text:
            part.name = text
        elif col == C_GROUP and text:
            part.group = text
            self._fill_groups()
        elif col == C_PN:
            part.part_no = text
        elif col == C_STEP:
            try:
                part.step = max(1, int(float(text)))
            except ValueError:
                part.step = max(1, part.step)
            while len(self.model.steps) < part.step:
                self.model.steps.append(a3.Step(f"ขั้นที่ {len(self.model.steps) + 1}"))
            self._loading = True
            item.setText(str(part.step))
            self._loading = False
        self.model.source = "file"  # edited by hand: the job no longer rebuilds it
        self.note.setText(" · ".join(x for x in (self.model.note, *self.model.problems()) if x))
        self._show_step()
        self.view.update()

    def _part_row_selected(self) -> None:
        rows = {i.row() for i in self.parts.selectedIndexes()}
        part = self._part_at(min(rows)) if rows else None
        if part and self.view.selected != part.id:
            self.view.selected = part.id
            self.view.update()
            self._describe(part)

    def _part_clicked(self, part_id: str) -> None:
        part = self.model.part(part_id) if self.model else None
        self._describe(part)
        if part is None:
            return
        for r in range(self.parts.rowCount()):
            if self.parts.item(r, 0).data(Qt.UserRole) == part_id:
                self.parts.blockSignals(True)
                self.parts.selectRow(r)
                self.parts.blockSignals(False)
                break

    def _describe(self, part: a3.Part3D | None) -> None:
        if part is None:
            self.part_info.setText("คลิกชิ้นส่วนในภาพหรือในตารางเพื่อดูรายละเอียด · ดับเบิลคลิกในภาพเพื่อซูมเข้า")
            return
        lo, hi = part.bounds()
        where = f"ตำแหน่ง X {lo[0]:.0f}–{hi[0]:.0f} · Y {lo[1]:.0f}–{hi[1]:.0f} · Z {lo[2]:.0f}–{hi[2]:.0f} มม."
        step = f"ขั้นที่ {part.step}" if part.step else "ของรถ (อ้างอิง)"
        self.part_info.setText(" · ".join(x for x in (f"<b>{part.name}</b>", part.size, part.part_no, f"กลุ่ม {part.group}",
                                                      step, where, part.note) if x))

    def _group_changed(self) -> None:
        group = self.groups.currentData()
        if not self.model:
            return
        self.view.hidden_groups = {g for g in self.model.groups() if group and g not in (group, a3.REF_GROUP)}
        self._options_changed()
        self.view.fit([p for p in self.model.parts if p.group == group] if group else None)

    def _options_changed(self) -> None:
        self.view.show_labels = self.labels.isChecked()
        self.view.ghost_later = self.ghost.isChecked()
        if self.vehicle.isChecked():
            self.view.hidden_groups.discard(a3.REF_GROUP)
        else:
            self.view.hidden_groups.add(a3.REF_GROUP)
        self.view.update()

    # ---- steps ------------------------------------------------------------
    def go(self, step: int, animate: bool = True) -> None:
        if not self.model:
            return
        self.step = min(max(step, 0), len(self.model.steps))
        self.view.set_step(self.step or None, animate=animate)
        self._show_step()

    def zoom_step(self) -> None:
        if self.model and self.step:
            self.view.zoom_to([p.id for p in self.model.parts_of_step(self.step)])

    def _record_key(self, step: int) -> str:
        return f"asm:{step}"

    def done_steps(self) -> set[int]:
        job = self.get_job()
        return {n for n in range(1, len(self.model.steps) + 1) if job.record.get(self._record_key(n), {}).get("done")} \
            if self.model else set()

    def _show_step(self) -> None:
        model, n = self.model, self.step
        self._loading = True
        total = len(model.steps) if model else 0
        step = model.steps[n - 1] if (model and 0 < n <= total) else None
        self.step_no.setText(f"ขั้นที่ {n} / {total}" if step else f"ภาพรวม – {total} ขั้นตอน")
        self.step_title.setEnabled(step is not None)
        self.step_detail.setEnabled(step is not None)
        self.step_title.setText(step.title if step else "ชิ้นส่วนทั้งหมด")
        self.step_detail.setPlainText(step.detail if step else "กด ถัดไป ▶ เพื่อเริ่มขั้นที่ 1 หรือ ▶ เล่นสาธิตทั้งหมด · "
                                      "เลื่อนแถบ แยกชิ้น เพื่อดูชิ้นส่วนแยกออกจากกัน")
        info = []
        if step:
            info += [f"<b>แรงขัน:</b> {step.torque}"] if step.torque else []
            info += [f"<b>เครื่องมือ:</b> {step.tools}"] if step.tools else []
            info += [f"<b>จุดตรวจ:</b> {step.check}"] if step.check else []
            info += [f"<span style='color:#D64545'><b>⚠ {step.warning}</b></span>"] if step.warning else []
            info += [f"<span style='color:#6B7A90'>BEMM {step.ref}</span>"] if step.ref else []
        self.step_info.setText("<br>".join(info))
        lines = model.bom(n if step else None) if model else []
        fill(self.bom, [[b.no, b.name, b.size, b.part_no, b.qty] for b in lines])
        done = self.done_steps()
        self.done.setEnabled(step is not None)
        self.done.setChecked(n in done)
        self.progress.setText(f"ประกอบแล้ว {len(done)} / {total} ขั้น" if model else "")
        self._loading = False

    def _step_text_edited(self) -> None:
        if self._loading or not self.model or not 0 < self.step <= len(self.model.steps):
            return
        step = self.model.steps[self.step - 1]
        title, detail = self.step_title.text().strip(), self.step_detail.toPlainText().strip()
        if (title, detail) != (step.title, step.detail):
            step.title, step.detail = title or step.title, detail
            self.model.source = "file"

    def _done_toggled(self, checked: bool) -> None:
        if self._loading or not self.step:
            return
        im.mark(self.get_job(), self._record_key(self.step), done=checked, by=getattr(self.state.actor, "name", ""))
        self.progress.setText(f"ประกอบแล้ว {len(self.done_steps())} / {len(self.model.steps)} ขั้น")

    # ---- demonstration ----------------------------------------------------
    def toggle_play(self) -> None:
        if self._playing:
            self.stop_play()
        elif self.model and self.model.steps:
            self._playing = True
            self.play_btn.setText("■ หยุด")
            self.go(1 if self.step >= len(self.model.steps) or self.step == 0 else self.step + 1)

    def stop_play(self) -> None:
        self._playing = False
        self._play_timer.stop()
        self.play_btn.setText("▶ เล่นสาธิตทั้งหมด")

    def _animation_done(self) -> None:
        if self._playing:
            self._play_timer.start(1100)

    def _play_next(self) -> None:
        if not self._playing or not self.model:
            return
        if self.step >= len(self.model.steps):
            self.stop_play()
        else:
            self.go(self.step + 1)

    # ---- files ------------------------------------------------------------
    def import_files(self, paths: list[str] | None = None) -> a3.AssemblyModel | None:
        if paths is None:
            paths, _ = QFileDialog.getOpenFileNames(self, "เลือกโมเดล 3 มิติจาก CAD", "", MODEL_FILTER)
        if not paths:
            return None
        try:
            model = a3.model_from_files(paths)
        except (OSError, ValueError, IndexError, struct_error) as e:
            QMessageBox.warning(self, "นำเข้าโมเดล", f"อ่านไฟล์ไม่ได้: {e}")
            return None
        self.set_model(model)
        self.state.notify(f"นำเข้า {len(model.parts)} ชิ้น {a3.face_count(model):,} หน้า · {len(model.steps)} กลุ่ม/ขั้น – "
                          "แก้ชื่อ กลุ่ม และขั้นในตารางได้")
        return model

    def swap_up(self) -> None:
        if self.model:
            a3.swap_up_axis(self.model)
            self.view.set_model(self.model)

    def open_model(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "เปิดคู่มือประกอบ", "", "คู่มือประกอบ 3 มิติ (*.rrsasm *.json)")
        if not path:
            return
        try:
            model = a3.AssemblyModel.load(path)
        except (OSError, ValueError, TypeError) as e:
            QMessageBox.warning(self, "เปิดคู่มือประกอบ", f"อ่านไฟล์ไม่ได้: {e}")
            return
        model.source = "file"
        self.set_model(model)
        self.state.notify(f"เปิด {Path(path).name} แล้ว")

    def save_model(self, path: str = "") -> str:
        if not self.model:
            return ""
        if not path:
            path, _ = QFileDialog.getSaveFileName(self, "บันทึกคู่มือประกอบ", f"{self.get_job().job_no or 'ประกอบ'}.rrsasm",
                                                  "คู่มือประกอบ 3 มิติ (*.rrsasm)")
        if path:
            self.model.save(path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")
        return path

    def export_pdf(self, path: str = "") -> str:
        """Every step drawn with its parts a little before their place (the dashed line shows the way in)."""
        if not self.model or not self.model.steps:
            return ""
        if not path:
            path, _ = QFileDialog.getSaveFileName(self, "คู่มือประกอบ 3 มิติ", f"คู่มือประกอบ_{self.get_job().job_no or 'Ford'}.pdf",
                                                  "PDF (*.pdf);;HTML (*.html)")
        if not path:
            return ""
        from .install import write_pdf

        self.stop_play()
        keep = (self.step, self.view.yaw, self.view.pitch, self.view.zoom, self.view.target.copy(), self.view.explode)
        folder = Path(tempfile.mkdtemp(prefix="rrs_asm_")) if path.lower().endswith(".pdf") else Path(path).with_suffix("")
        folder.mkdir(parents=True, exist_ok=True)
        images = {}
        self.view.explode = 0.0
        for n in range(1, len(self.model.steps) + 1):
            self.view.set_step(n, animate=False)
            self.view._anim = 0.55
            file = folder / f"step_{n:02d}.png"
            self.view.render_image(1280, 800, fit=True, margin=0.7).save(str(file))
            images[n] = QUrl.fromLocalFile(str(file)).toString() if path.lower().endswith(".pdf") else f"{folder.name}/{file.name}"
        self.view._anim = 0.0
        self.step, self.view.yaw, self.view.pitch, self.view.zoom, self.view.target, self.view.explode = keep
        self.view.set_step(self.step or None, animate=False)
        doc = a3.render_steps_html(self.model, images, self.get_job().job_no, self.done_steps())
        if path.lower().endswith(".pdf"):
            write_pdf(path, doc)
        else:
            Path(path).write_text(doc, encoding="utf-8")
        self.state.notify(f"บันทึก {Path(path).name} แล้ว ({len(images)} ขั้นตอน)")
        return path

