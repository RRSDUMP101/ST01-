"""แท็บ ประกอบ 3D: ชิ้นส่วนแยกกลุ่ม · ภาพ 3 มิติหมุน/ซูมได้ · ขั้นตอนประกอบทีละขั้นพร้อมสาธิต (ชิ้นส่วนเลื่อนเข้าตำแหน่ง)."""

from __future__ import annotations

import tempfile
import time
from pathlib import Path
from struct import error as struct_error

from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QBrush, QColor, QDesktopServices, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QCheckBox, QComboBox, QFileDialog, QFormLayout, QHBoxLayout,
                               QInputDialog, QLabel, QLineEdit, QMenu, QMessageBox, QSpinBox,
                               QPlainTextEdit, QSlider, QSplitter, QTableWidgetItem, QVBoxLayout, QWidget)

from ...core import assembly3d as a3
from ...core import cad_import
from ...core import install_manual as im
from ...core import z3_model
from ..assembly_view import Assembly3DView
from ..part_popup import PartPopup, encode_photo
from ..state import AppState
from ..widgets import FlowLayout, button, fill, run_async, table

PART_HEADERS = ["แสดง", "ชิ้นส่วน", "กลุ่ม", "ขั้น", "ขนาด", "Part No."]
C_SHOW, C_NAME, C_GROUP, C_STEP, C_SIZE, C_PN = range(6)
BOM_HEADERS = ["#", "ชิ้นส่วน", "ขนาด", "Part No.", "จำนวน"]
MODEL_FILTER = ("โมเดล 3 มิติ (*.step *.stp *.igs *.iges *.z3 *.z3asm *.obj *.stl);;CAD: STEP / IGES (*.step *.stp *.igs *.iges);;"
                "ZW3D (*.z3 *.z3asm *.z3prt);;Mesh: OBJ / STL (*.obj *.stl)")
ALL_GROUPS = "ทุกกลุ่ม"
JOB_KEYS = ("product", "cab", "body_length", "body_width", "body_height", "cab_gap", "bolt_size", "bolt_grade",
            "rigid_subframe", "lamp_low", "lamp_high", "lamp_from_edge")


class _CadProgress(QObject):
    """Carries how far the CAD reader is from its worker thread to the window."""

    changed = Signal(str, float)  # stage, 0 … 1


class AssemblyTab(QWidget):
    def __init__(self, state: AppState, get_job, parent=None):
        super().__init__(parent)
        self.state, self.get_job = state, get_job
        self.model: a3.AssemblyModel | None = None
        self.step = 0  # 0 = the whole assembly · 1 … = that step
        self._key = None
        self._loading = False
        self._playing = False
        self._cad_busy = ""  # the STEP / IGES file a worker is reading ('' = none)
        self._cad_stage, self._cad_started = ("", 0.0), 0.0
        self._cad_progress = _CadProgress(self)
        self._cad_progress.changed.connect(self._cad_progressed)
        self._cad_timer = QTimer(self)  # the minutes go on in the note while one long stage is at work
        self._cad_timer.setInterval(1000)
        self._cad_timer.timeout.connect(self._show_cad_progress)

        lay = QVBoxLayout(self)
        row = QHBoxLayout()
        self.title = QLabel()
        self.title.setObjectName("CardTitle")
        row.addWidget(self.title, 1)
        for text, slot, kind, tip in (
                ("สร้างจากงานนี้", lambda: self.rebuild(force=True), "", "โมเดลตัวอย่างจากขนาดในแท็บ ข้อมูลงาน"),
                ("นำเข้าโมเดล (STEP / IGES / ZW3D / OBJ / STL)…", lambda: self.import_files(), "accent",
                 "โมเดลจริงจาก CAD: STEP หรือ IGES ทั้งชุดประกอบ (ต้องติดตั้ง cadquery-ocp) · ไฟล์ ZW3D .Z3 (ชิ้นเป็นกล่องตามตำแหน่ง"
                 " + คำเตือนของแบบ) · หรือ OBJ (1 object ต่อ 1 ชิ้น) · หรือ STL (1 ไฟล์ต่อ 1 ชิ้น)"),
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
        self.parts.setSelectionMode(QAbstractItemView.ExtendedSelection)
        lay.addWidget(self.parts, 1)
        row = QHBoxLayout()
        self.chosen = QLabel("เลือก 0 ชิ้น")
        self.chosen.setToolTip("เลือกหลายชิ้น: Shift / Ctrl + คลิกในตาราง หรือ Ctrl + คลิกชิ้นในภาพ")
        row.addWidget(self.chosen, 1)
        for text, slot, tip in (("ย้ายมาขั้นนี้", lambda: self.move_selected_to_step(), "ชิ้นที่เลือกทั้งหมดมาอยู่ในขั้นที่กำลังแสดง"),
                                ("ตั้งกลุ่ม…", lambda: self.set_group_selected(), "ตั้งชื่อกลุ่มของชิ้นที่เลือกทั้งหมด")):
            b = button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)
        row = QHBoxLayout()
        row.addWidget(QLabel("ทิศแยกชิ้น"))
        self.explode_dir = QComboBox()
        self.explode_dir.addItems(list(a3.EXPLODE_DIRECTIONS))
        self.explode_dir.setSizeAdjustPolicy(QComboBox.AdjustToMinimumContentsLengthWithIcon)
        self.explode_dir.setMinimumContentsLength(9)
        self.explode_dir.setToolTip("ทิศที่ชิ้นรออยู่ก่อนประกอบ = ทิศตรงข้ามกับที่ชิ้นเลื่อนเข้าตำแหน่งในการสาธิต")
        self.explode_dist = QSpinBox()
        self.explode_dist.setRange(20, 5000)
        self.explode_dist.setSingleStep(50)
        self.explode_dist.setValue(400)
        self.explode_dist.setSuffix(" มม.")
        apply = button("ตั้ง", tooltip="ตั้งทิศและระยะแยกชิ้นของชิ้นที่เลือก")
        apply.clicked.connect(lambda: self.set_explode_selected())
        for w2 in (self.explode_dir, self.explode_dist, apply):
            row.addWidget(w2)
        lay.addLayout(row)
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
        self.view.part_double_clicked.connect(lambda _id: self.popup.put_away())  # the view zooms: show it
        self.view.animation_done.connect(self._animation_done)
        self.popup = PartPopup(self.view)  # the detail card of the part that was tapped
        self.popup.saved.connect(self._popup_saved)
        self.popup.go_step.connect(self._popup_go)
        self.popup.zoom.connect(lambda part_id: self.view.zoom_to([part_id]))
        self.popup.play.connect(self.play_part)
        self.popup.attach_photo.connect(lambda part_id: self.attach_photo(part_id))
        self.popup.remove_photo.connect(lambda part_id: self.attach_photo(part_id, remove=True))
        self.popup.open_drawing.connect(lambda part_id, change: self.open_drawing(part_id, change=change))
        bar_box = QWidget()
        bar = FlowLayout(bar_box, h_spacing=6)  # wraps on a narrow window instead of making the page wider
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
        lay.addWidget(bar_box)
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
        lay.addLayout(bar)
        opt_box = QWidget()
        opts = FlowLayout(opt_box, h_spacing=12)
        self.detail_on = QCheckBox("รายละเอียดเมื่อแตะชิ้น")
        self.detail_on.setChecked(True)
        self.detail_on.setToolTip("คลิก / แตะชิ้นส่วนในภาพ → การ์ดรายละเอียด: รูป สเปก จุดตรวจ ปุ่มไปขั้นประกอบ\n"
                                  "Ctrl + คลิก = เลือกหลายชิ้นโดยไม่เปิดการ์ด")
        self.detail_on.toggled.connect(lambda on: None if on else self.popup.put_away())
        for c in (self.labels, self.ghost, self.vehicle, self.detail_on):
            opts.addWidget(c)
        lay.addWidget(opt_box)
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
        self.media_btn = button("วิดีโอ / รูปงานจริง…", tooltip="วิดีโอหรือรูปถ่ายงานประกอบจริงของขั้นนี้ – แนบครั้งเดียวแล้วเปิดดูได้ทุกครั้ง\n"
                                "(ไฟล์อยู่ที่เดิม คู่มือประกอบเก็บเฉพาะที่อยู่ไฟล์ · รูปถ่ายออกในคู่มือ PDF)")
        self.media_btn.clicked.connect(self._media_menu)
        lay.addWidget(self.media_btn)
        self.edit_btn = button("✎ แก้ไขขั้นตอน", tooltip="แก้แรงขัน เครื่องมือ จุดตรวจ คำเตือน · เพิ่ม ลบ เลื่อนลำดับขั้น")
        self.edit_btn.setCheckable(True)
        self.edit_btn.toggled.connect(self._edit_toggled)
        lay.addWidget(self.edit_btn)
        self.editor = QWidget()
        form = QFormLayout(self.editor)
        form.setContentsMargins(0, 0, 0, 0)
        self.step_fields: dict[str, QLineEdit] = {}
        for key, label in (("torque", "แรงขัน"), ("tools", "เครื่องมือ"), ("check", "จุดตรวจ"), ("warning", "คำเตือน"),
                           ("ref", "อ้างอิง BEMM")):
            edit = QLineEdit()
            edit.editingFinished.connect(self._step_fields_edited)
            self.step_fields[key] = edit
            form.addRow(label, edit)
        self.items_edit = QLineEdit()
        self.items_edit.setPlaceholderText("ชื่อ × จำนวน; ชื่อ × จำนวน – เช่น หัวลาก Ø50 × 1; โซ่นิรภัย × 2")
        self.items_edit.setToolTip("ชิ้นที่ซื้อสำเร็จและไม่มีแบบ CAD ของขั้นนี้ – ออกในตารางของขั้นและในคู่มือประกอบ PDF\n"
                                   "คั่นรายการด้วย ; · ไม่ใส่ × จำนวน = ยังไม่รู้จำนวน")
        self.items_edit.editingFinished.connect(self._items_edited)
        form.addRow("ชิ้นซื้อสำเร็จ", self.items_edit)
        row_box = QWidget()
        row = FlowLayout(row_box, h_spacing=6)
        for text, slot, tip in (("+ ก่อน", lambda: self.add_step(False), "เพิ่มขั้นว่างก่อนขั้นนี้"),
                                ("+ หลัง", lambda: self.add_step(True), "เพิ่มขั้นว่างหลังขั้นนี้"),
                                ("▲", lambda: self.shift_step(-1), "เลื่อนขั้นนี้ขึ้น (ทำก่อน)"),
                                ("▼", lambda: self.shift_step(1), "เลื่อนขั้นนี้ลง (ทำทีหลัง)"),
                                ("ลบขั้น", lambda: self.delete_step(), "ลบขั้นนี้ – ชิ้นส่วนย้ายไปขั้นก่อนหน้า"),
                                ("ลำดับ 13 ขั้น", lambda: self.use_tray_sequence(),
                                 "แทนขั้นทั้งหมดด้วยลำดับประกอบกระบะพื้นเรียบ 13 ขั้นของ RRS – จัดชิ้นเข้าขั้นตามชื่อชิ้นและกลุ่ม"),
                                ("รับกลุ่มจากไฟล์อื่น", lambda: self.adopt_levels(),
                                 ("ชุดประกอบเดียวกันจากอีกไฟล์ (เช่น IGES ที่มีเลเยอร์ของผู้ออกแบบ): ชิ้นที่อยู่ตำแหน่งเดียวกัน"
                                  "รับกลุ่มจากไฟล์นั้น แล้วจัดเข้าลำดับ 13 ขั้น"))):
            b = button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        form.addRow(row_box)
        self.editor.setVisible(False)
        lay.addWidget(self.editor)
        self.bom = table(BOM_HEADERS, [30, 150, 100, 70, 50])
        self.bom.cellClicked.connect(self._step_list_clicked)
        self.view.focus_changed.connect(self._fill_step_list)  # a crowded step: the list follows the picture
        self._list_fill = 0
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
        self.part_btn = button("▶ เล่นชิ้นที่เลือก", tooltip="ดูเฉพาะชิ้นที่เลือก (ในภาพหรือในตาราง) เลื่อนเข้าตำแหน่ง: เส้นประและ"
                               "ลูกศร = ทิศที่ชิ้นเข้า · วงกลม = ตำแหน่งติดตั้ง · กดอีกครั้ง = เล่นซ้ำ")
        self.part_btn.clicked.connect(lambda: self.play_part())
        lay.addLayout(row)
        lay.addWidget(self.part_btn)  # on a row of its own: the panel must not get wider
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
        self.popup.put_away()
        self.model = model
        self.step = min(self.step, len(model.steps)) if (model and keep_step) else 0
        self.view.hidden_groups, self.view.hidden_parts = set(), set()
        self.view.set_model(model, keep_view=keep_step and model is not None)
        self.title.setText(model.name if model else "ยังไม่มีโมเดล 3 มิติสำหรับผลิตภัณฑ์นี้")
        problems = model.problems() if model else []
        self._show_note((model.note if model else
                         "หางลากยังไม่มีโมเดลตัวอย่าง – นำเข้าแบบจริงจาก CAD (ไฟล์ ZW3D .Z3 ของหาง หรือ STEP / IGES / OBJ / STL)"), problems)
        self._fill_groups()
        self._fill_parts()
        self._options_changed()
        self.view.set_step(self.step or None, animate=False)
        self._show_step()

    def _show_note(self, note: str, problems: list[str]) -> None:
        """The note of the model in a line or two: the log of a CAD import is long and would push the picture down.
        What is wrong with the steps always shows; the whole note is the tooltip."""
        parts = [x for x in note.split(" · ") if x]
        short = " · ".join(parts[:2])
        if len(short) > 230:
            short = short[:228].rstrip() + "…"
        more = "  … (ชี้เมาส์เพื่อดูบันทึกการนำเข้าทั้งหมด)" if (len(parts) > 2 or len(short) < len(" · ".join(parts[:2]))) else ""
        self.note.setText(" · ".join(x for x in (short + more, *problems) if x))
        self.note.setToolTip("<qt>" + "<br>".join(parts) + "</qt>" if more else "")

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
        self.popup.put_away()  # the card would keep the old name, step and Part No.
        if col == C_NAME and text:
            a3.rename_part(self.model, part, text)  # its photo goes with the name
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
        self._show_note(self.model.note, self.model.problems())
        self._show_step()
        self.view.update()

    def selected_parts(self) -> list[a3.Part3D]:
        rows = sorted({i.row() for i in self.parts.selectedIndexes()})
        return [p for p in (self._part_at(r) for r in rows) if p is not None]

    def _part_row_selected(self) -> None:
        chosen = self.selected_parts()
        self.chosen.setText(f"เลือก {len(chosen)} ชิ้น")
        self.view.marked = {p.id for p in chosen}
        part = chosen[0] if chosen else None
        if part and self.view.selected not in self.view.marked:
            self.view.selected = part.id
            self._describe(part)
        self.view.update()

    def hideEvent(self, event) -> None:  # noqa: N802
        self.popup.put_away()  # the card floats over the window: it must not stay over another page
        super().hideEvent(event)

    def _part_clicked(self, part_id: str) -> None:
        part = self.model.part(part_id) if self.model else None
        self._describe(part)
        if part is None:
            self.popup.put_away()  # a tap beside the model puts the card away
            return
        more = bool(QApplication.keyboardModifiers() & Qt.ControlModifier)  # Ctrl + click: one more part
        for r in range(self.parts.rowCount()):
            if self.parts.item(r, 0).data(Qt.UserRole) == part_id:
                self.select_part_row(r, more)
                break
        if more or not self.detail_on.isChecked():
            self.popup.put_away()
        else:
            self.show_part_card(part)

    # ---- the detail card of a part ----------------------------------------------
    def show_part_card(self, part: a3.Part3D, media: int | None = None, keep_edits: bool = False) -> None:
        self.popup.show_part(self.model, part, self.get_job(), self.view.last_click.toPoint(), media, keep_edits)

    def _popup_saved(self, part_id: str, part_no: str, note: str, all_same: bool) -> None:
        part = self.model.part(part_id) if self.model else None
        if part is None:
            return
        new_no, new_note = self.popup.changed()  # only what was changed in the card: the other field of the
        if not (new_no or new_note):             # other parts of that name may differ on purpose
            return
        parts = [p for p in self.model.parts if p.name == part.name and p.size == part.size] if all_same else [part]
        for p in parts:
            if new_no:
                p.part_no = part_no
            if new_note:
                p.note = note
        self._edited()
        self._describe(part)
        self.state.notify(f"บันทึกรายละเอียดของ {part.name} แล้ว" + (f" ({len(parts)} ชิ้น)" if len(parts) > 1 else ""))

    def _popup_go(self, step: int) -> None:
        self.popup.put_away()
        self.go(step)

    def attach_photo(self, part_id: str, path: str = "", remove: bool = False) -> bool:
        """A photo of the real part for its card (kept in the model file, for every part of that name)."""
        part = self.model.part(part_id) if self.model else None
        if part is None:
            return False
        if remove:
            if self.model.photos.pop(part.name, None) is None:
                return False
        else:
            if not path:
                path, _ = QFileDialog.getOpenFileName(self, f"รูปจริงของ {part.name}", "", "รูปภาพ (*.jpg *.jpeg *.png *.bmp *.webp)")
            if not path:
                return False
            data = encode_photo(path)
            if not data:
                QMessageBox.warning(self, "แนบรูปจริง", f"เปิดรูป {Path(path).name} ไม่ได้ – ใช้ไฟล์ JPG หรือ PNG")
                return False
            self.model.photos[part.name] = data
        shown = not self.popup.isHidden() and self.popup.part_id == part_id
        self._edited(keep_card=shown)
        if shown:
            self.show_part_card(part, media=1, keep_edits=True)  # what was typed in the card stays
        self.state.notify(f"{'ลบ' if remove else 'แนบ'}รูปจริงของ {part.name} แล้ว – กด บันทึก… เพื่อเก็บลงไฟล์คู่มือประกอบ")
        return True

    def open_drawing(self, part_id: str, path: str = "", change: bool = False) -> bool:
        """The 2D drawing of a part: the PDF (or picture) exported from the CAD program is attached once per drawing –
        every part shown in that drawing then opens it. The file stays where it is; the model keeps its path."""
        part = self.model.part(part_id) if self.model else None
        if part is None or not part.drawing:
            return False
        name, have = part.drawing, self.model.drawing_files.get(part.drawing, "")
        if change or not have or not Path(have).is_file():
            if not path:
                path, _ = QFileDialog.getOpenFileName(self, f"ไฟล์ของแบบ {name} (ส่งออกจาก ZW3D)", "",
                                                      "แบบ 2 มิติ (*.pdf *.png *.jpg *.jpeg *.dwg *.dxf)")
            if not path:
                return False
            self.model.drawing_files[name] = str(Path(path).resolve())
            self.model.source = "file"
            if not self.popup.isHidden() and self.popup.part_id == part_id:
                self.show_part_card(part, keep_edits=True)
            self.state.notify(f"แนบไฟล์ของแบบ {name} แล้ว – ทุกชิ้นในแบบนี้เปิดไฟล์นี้ · กด บันทึก… เพื่อเก็บลงคู่มือประกอบ")
            if change:
                return True
            have = self.model.drawing_files[name]
        QDesktopServices.openUrl(QUrl.fromLocalFile(have))
        return True

    def select_part_row(self, row: int, more: bool = False) -> None:
        model = self.parts.selectionModel()
        index = self.parts.model().index(row, 0)
        model.select(index, (model.SelectionFlag.Toggle if more else model.SelectionFlag.ClearAndSelect)
                     | model.SelectionFlag.Rows)
        self.parts.scrollToItem(self.parts.item(row, 0))

    # ---- the chosen parts ---------------------------------------------------
    def _edited(self, keep_rows: bool = True, keep_card: bool = False) -> None:
        """The model was changed by hand: it stops following the job, and the table and the picture show it.
        An open detail card would show what the part was before: it is put away."""
        if not keep_card:
            self.popup.put_away()
        ids = {p.id for p in self.selected_parts()} if keep_rows else set()
        self.model.source = "file"
        self._fill_groups()
        self._fill_parts()
        selection = self.parts.selectionModel()
        selection.clearSelection()  # the rows were written again: choose the same parts once more
        for r in range(self.parts.rowCount()):
            if self.parts.item(r, 0).data(Qt.UserRole) in ids:
                selection.select(self.parts.model().index(r, 0), selection.SelectionFlag.Select | selection.SelectionFlag.Rows)
        self._show_note(self.model.note, self.model.problems())
        self.view.set_step(self.step or None, animate=False)
        self._show_step()

    def move_selected_to_step(self, step: int | None = None) -> int:
        parts, step = self.selected_parts(), self.step if step is None else step
        if not self.model or not parts:
            self.state.notify("เลือกชิ้นส่วนในตารางก่อน (Shift / Ctrl + คลิก เพื่อเลือกหลายชิ้น)")
            return 0
        if not 1 <= step <= len(self.model.steps):
            self.state.notify("ไปที่ขั้นที่ต้องการก่อน (ถัดไป ▶) แล้วกด ย้ายมาขั้นนี้")
            return 0
        for p in parts:
            p.step = step
        self._edited()
        self.state.notify(f"ย้าย {len(parts)} ชิ้นมาขั้นที่ {step} “{self.model.steps[step - 1].title}”")
        return len(parts)

    def set_group_selected(self, name: str | None = None) -> int:
        parts = self.selected_parts()
        if not self.model or not parts:
            self.state.notify("เลือกชิ้นส่วนในตารางก่อน")
            return 0
        if name is None:
            name, ok = QInputDialog.getItem(self, "ตั้งกลุ่ม", f"กลุ่มของ {len(parts)} ชิ้นที่เลือก",
                                            [g for g in self.model.groups() if g != a3.REF_GROUP], 0, True)
            if not ok:
                return 0
        name = name.strip()
        if not name or name == a3.REF_GROUP:
            return 0
        for p in parts:
            p.group = name
        self._edited()
        self.state.notify(f"ตั้งกลุ่ม “{name}” ให้ {len(parts)} ชิ้น")
        return len(parts)

    def set_explode_selected(self) -> int:
        parts = self.selected_parts()
        if not self.model or not parts:
            self.state.notify("เลือกชิ้นส่วนในตารางก่อน")
            return 0
        a3.set_explode(parts, self.explode_dir.currentText(), float(self.explode_dist.value()))
        self.model.source = "file"
        if self.explode.value() < 50:  # show what was set
            self.explode.setValue(100)
        self.view.update()
        self.state.notify(f"ตั้งทิศแยกชิ้น {self.explode_dir.currentText()} {self.explode_dist.value()} มม. ให้ {len(parts)} ชิ้น")
        return len(parts)

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
        self.popup.put_away()  # the part of the card may not be in the picture of this step
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
        self.step_no.setText(f"ขั้นที่ {n} / {total}" + (f" · {step.phase}" if step.phase else "") if step
                             else f"ภาพรวม – {total} ขั้นตอน")
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
            info += [f"<b>ชิ้นซื้อสำเร็จ:</b> {len(step.items)} รายการ (ในตารางด้านล่าง)"] if step.items else []
            info += ["<span style='color:#6B7A90'>ขั้นนี้เป็นงาน / การตรวจ – ไม่มีชิ้นส่วนใหม่</span>"] if step.no_parts else []
        self.step_info.setText("<br>".join(info))
        self.step_info.setVisible(not self.edit_btn.isChecked())
        self.editor.setEnabled(step is not None)
        for key, edit in self.step_fields.items():
            edit.setText(getattr(step, key) if step else "")
        self.items_edit.setText(a3.items_text(step.items) if step else "")
        self.media_btn.setEnabled(step is not None)
        self.media_btn.setText(f"วิดีโอ / รูปงานจริง ({len(step.media)})…" if step and step.media else "แนบวิดีโอ / รูปงานจริง…")
        self._fill_step_list()
        done = self.done_steps()
        self.done.setEnabled(step is not None)
        self.done.setChecked(n in done)
        self.progress.setText(f"ประกอบแล้ว {len(done)} / {total} ขั้น" if model else "")
        self._loading = False

    # ---- the parts of the step ---------------------------------------------
    def _fill_step_list(self) -> None:
        """The list of the step. A crowded step: one row per group with the colour and the words of its callout in
        the picture; the group that is looked at is open and shows its lines. Any other step: its lines, as always."""
        t, view, model = self.bom, self.view, self.model
        plan = view.plan() if (model and self.step) else None
        t.blockSignals(True)
        t.clearSpans()
        t.clearSelection()
        if plan is None:
            lines = model.bom(self.step or None) if model else []
            fill(t, [[b.no, b.name, b.size, b.part_no, b.qty] for b in lines] + self._bought_rows())
            for r in range(t.rowCount()):
                t.setRowHeight(r, t.verticalHeader().defaultSectionSize())
            t.blockSignals(False)
            return
        rows = []
        for g in plan.groups:
            rows.append(("g", g))
            if g in view.focus:
                rows += [("l", b) for b in plan.of_group[g]]
        t.setRowCount(len(rows))
        top = picked = None
        for r, (kind, value) in enumerate(rows):
            if kind == "g":
                is_open = value in view.focus
                head = QTableWidgetItem(f"{'▾' if is_open else '▸'}  {value}  ×{plan.pieces[value]}   ·   "
                                        f"{len(plan.of_group[value])} รายการ  {plan.span(value)}")
                colour = QColor(plan.colour[value])
                head.setIcon(self._swatch(colour))
                head.setData(Qt.UserRole, ("g", value))
                colour.setAlpha(60 if is_open else 26)
                head.setBackground(QBrush(colour))
                font = head.font()
                font.setBold(True)
                head.setFont(font)
                head.setFlags(head.flags() & ~Qt.ItemIsEditable)
                t.setItem(r, 0, head)
                t.setSpan(r, 0, 1, t.columnCount())
                t.setRowHeight(r, 36)  # for a finger
                if is_open and top is None:
                    top = r
            else:
                for c, v in enumerate([value.no, value.name, value.size, value.part_no, value.qty]):
                    item = QTableWidgetItem(str(v))
                    if isinstance(v, int):
                        item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                    if c == 0:
                        item.setData(Qt.UserRole, ("l", value.no))
                    t.setItem(r, c, item)
                t.setRowHeight(r, 30)
                if value.no == view.picked_line:
                    t.selectRow(r)
                    picked = r
        for values in self._bought_rows():  # bought-in items under the groups, as in a plain step
            r = t.rowCount()
            t.setRowCount(r + 1)
            for c, v in enumerate(values):
                t.setItem(r, c, QTableWidgetItem(str(v)))
        t.blockSignals(False)
        self._list_fill = fill_no = self._list_fill + 1

        def scroll() -> None:  # once the table has taken its new rows in (rows, not items: it may be filled again first)
            if self._list_fill != fill_no:
                return
            if top is not None:  # the open group at the top: its lines can be read without scrolling
                t.scrollToItem(t.item(top, 0), QAbstractItemView.PositionAtTop)
            if picked is not None:
                t.scrollToItem(t.item(picked, 0), QAbstractItemView.EnsureVisible)

        QTimer.singleShot(0, scroll)

    def _bought_rows(self) -> list[list]:
        """The rows of the step's bought-in items (no CAD shape): 'ซ' in the number column, 'ระบุ' for an unknown count."""
        if not self.model or not 0 < self.step <= len(self.model.steps):
            return []
        return [["ซ", i["name"], "ซื้อสำเร็จ (ไม่มีแบบ CAD)", "", i.get("qty") or "ระบุ"]
                for i in self.model.steps[self.step - 1].items]

    @staticmethod
    def _swatch(colour: QColor) -> QIcon:
        pixmap = QPixmap(14, 14)
        pixmap.fill(Qt.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setPen(Qt.NoPen)
        painter.setBrush(colour)
        painter.drawRoundedRect(0, 0, 14, 14, 3, 3)
        painter.end()
        return QIcon(pixmap)

    def _step_list_clicked(self, row: int, _column: int = 0) -> None:
        """A crowded step: a tap on a group opens it (its numbers in the picture; once more: all groups again), a tap
        on a line picks it in the picture."""
        item = self.bom.item(row, 0)
        kind, value = (item.data(Qt.UserRole) or ("", None)) if item else ("", None)
        plan = self.view.plan()
        if plan is None or not kind:
            return
        if kind == "g":
            self.view.set_focus(set() if self.view.focus == {value} else {value})
        else:
            self.view.set_focus({next(b.group for b in plan.lines if b.no == value)}, value)

    def _step_text_edited(self) -> None:
        if self._loading or not self.model or not 0 < self.step <= len(self.model.steps):
            return
        step = self.model.steps[self.step - 1]
        title, detail = self.step_title.text().strip(), self.step_detail.toPlainText().strip()
        if (title, detail) != (step.title, step.detail):
            step.title, step.detail = title or step.title, detail
            self.model.source = "file"

    def _edit_toggled(self, on: bool) -> None:
        self.editor.setVisible(on)
        self.step_info.setVisible(not on)
        if on and self.model and self.step == 0 and self.model.steps:
            self.go(1, animate=False)

    def _step_fields_edited(self) -> None:
        if self._loading or not self.model or not 0 < self.step <= len(self.model.steps):
            return
        step, changed = self.model.steps[self.step - 1], False
        for key, edit in self.step_fields.items():
            if getattr(step, key) != edit.text().strip():
                setattr(step, key, edit.text().strip())
                changed = True
        if changed:
            self.model.source = "file"
            self._show_step()

    def _media_menu(self) -> None:
        """The videos and photos of the step: open one, attach more, or take them away."""
        if not self.model or not 0 < self.step <= len(self.model.steps):
            return
        step = self.model.steps[self.step - 1]
        if not step.media:
            self.attach_step_media()
            return
        menu = QMenu(self)
        for i, path in enumerate(step.media):
            gone = "" if Path(path).is_file() else "  (ไม่พบไฟล์)"
            menu.addAction(("🖼 " if a3.is_photo(path) else "▶ ") + Path(path).name + gone).triggered.connect(
                lambda _c=False, i=i: self.open_step_media(i))
        menu.addSeparator()
        menu.addAction("แนบเพิ่ม…").triggered.connect(lambda: self.attach_step_media())
        menu.addAction("เอาออกทั้งหมด").triggered.connect(lambda: self.attach_step_media(clear=True))
        menu.exec(self.media_btn.mapToGlobal(self.media_btn.rect().bottomLeft()))

    def attach_step_media(self, paths: list[str] | None = None, clear: bool = False) -> int:
        """Videos / photos of the real work for the step on show. Returns how many the step has after."""
        if not self.model or not 0 < self.step <= len(self.model.steps):
            return 0
        step = self.model.steps[self.step - 1]
        if clear:
            step.media = []
        else:
            if paths is None:
                paths, _ = QFileDialog.getOpenFileNames(self, f"วิดีโอ / รูปงานจริงของขั้นที่ {self.step}", "", a3.MEDIA_FILTER)
            if not paths:
                return len(step.media)
            for path in (str(Path(x).resolve()) for x in paths):
                if path not in step.media:
                    step.media.append(path)
        self.model.source = "file"
        self._show_step()
        self.state.notify(f"ขั้นที่ {self.step} มีวิดีโอ / รูปงานจริง {len(step.media)} ไฟล์ – กด บันทึก… เพื่อเก็บลงคู่มือประกอบ")
        return len(step.media)

    def open_step_media(self, index: int) -> bool:
        if not self.model or not 0 < self.step <= len(self.model.steps):
            return False
        media = self.model.steps[self.step - 1].media
        if not 0 <= index < len(media) or not Path(media[index]).is_file():
            QMessageBox.warning(self, "วิดีโอ / รูปงานจริง", "ไม่พบไฟล์ – ย้ายหรือลบไปแล้ว แนบใหม่ได้ที่ปุ่มเดิม")
            return False
        QDesktopServices.openUrl(QUrl.fromLocalFile(media[index]))
        return True

    def _items_edited(self) -> None:
        if self._loading or not self.model or not 0 < self.step <= len(self.model.steps):
            return
        step = self.model.steps[self.step - 1]
        items = a3.parse_items(self.items_edit.text())
        if items != step.items:
            step.items = items
            self.model.source = "file"
            self._show_step()

    def _remap_done(self, moved: dict) -> None:
        """The done marks are kept by step number: they follow their steps when the order changes."""
        record = self.get_job().record
        old = {int(k[4:]): record.pop(k) for k in [k for k in record if k.startswith("asm:") and k[4:].isdigit()]}
        for n, mark in old.items():
            new = moved.get(n, n)
            if new is not None:
                record[self._record_key(new)] = mark

    def add_step(self, after: bool) -> int:
        if not self.model:
            return 0
        at = (self.step + 1 if after else max(self.step, 1)) if self.step else len(self.model.steps) + 1
        self._remap_done(a3.insert_step(self.model, at))
        self.step = at
        self._edited(keep_rows=True)
        self.step_title.setFocus()
        self.step_title.selectAll()
        return at

    def delete_step(self, ask: bool = True) -> bool:
        if not self.model or not 0 < self.step <= len(self.model.steps):
            return False
        if len(self.model.steps) < 2:
            self.state.notify("ต้องมีอย่างน้อย 1 ขั้น")
            return False
        n, parts = self.step, len(self.model.parts_of_step(self.step))
        heir = n - 1 if n > 1 else 2
        if ask and QMessageBox.question(self, "ลบขั้น", f"ลบขั้นที่ {n} “{self.model.steps[n - 1].title}” ?\n"
                                        f"ชิ้นส่วน {parts} ชิ้นจะย้ายไปขั้นที่ {heir}") != QMessageBox.Yes:
            return False
        self._remap_done(a3.remove_step(self.model, n))
        self.step = max(1, n - 1)
        self._edited()
        return True

    def shift_step(self, delta: int) -> bool:
        if not self.model:
            return False
        moved = a3.move_step(self.model, self.step, delta)
        if not moved:
            return False
        self._remap_done(moved)
        self.step += delta
        self._edited()
        return True

    def use_tray_sequence(self, ask: bool = True, levels: dict[str, str] | None = None) -> dict[str, int]:
        """The 13 steps of a flat tray in place of the steps of the model; the parts go to them by their names, their
        groups and (`levels`, from another file of the same assembly) the designer's levels. A model from a file also
        gets the groups the technician reads and names without misspellings and '_Mirror'."""
        if not self.model:
            return {}
        if ask and QMessageBox.question(
                self, "ลำดับ 13 ขั้น", "แทนขั้นทั้งหมดของโมเดลนี้ด้วยลำดับประกอบกระบะพื้นเรียบ 13 ขั้นของ RRS?\n\n"
                "• งานบนจิ๊ก 4 ขั้น → ยกขึ้นรถ 2 ขั้น → งานบนรถ 7 ขั้น – แก้ได้หลังจากนี้\n"
                "• ชิ้นส่วนถูกจัดเข้าขั้นตามชื่อชิ้นและชื่อกลุ่ม ทิศแยกชิ้นถูกตั้งใหม่ เครื่องหมาย “ประกอบเสร็จ” ถูกล้าง\n"
                "• โมเดลที่นำเข้าจากไฟล์: ชื่อที่สะกดผิดถูกแก้ “_Mirror” เปลี่ยนเป็น ซ้าย / ขวา ตามตำแหน่งจริง "
                "(ชื่อในไฟล์เก็บไว้ในหมายเหตุของชิ้น)\n"
                f"• ชิ้นที่ชื่อไม่บอกว่าเป็นอะไรไปรวมที่ขั้น 4 ในกลุ่ม “{a3.UNSORTED_GROUP}”\n") != QMessageBox.Yes:
            return {}
        unsorted = len(a3.tray_unsorted(self.model, levels))
        imported = any(p.shape == "mesh" for p in self.model.parts)
        where = a3.apply_tray_sequence(self.model, self.get_job(), levels=levels, tidy=imported)
        self._remap_done({n: None for n in range(1, 200)})
        self.step = 0
        self._edited(keep_rows=False)
        self.state.notify("ใช้ลำดับ 13 ขั้นแล้ว" + (f" · ยังไม่ได้จัด {unsorted} ชิ้น อยู่ที่ขั้น 4" if unsorted else ""))
        return where

    def adopt_levels(self, path: str = "") -> bool:
        """The same assembly from another file gives its groups to the parts that lie where its parts lie – the
        IGES of a tray has the designer's levels, the STEP has the names – and the 13 steps are put on again."""
        if not self.model:
            return False
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "รับกลุ่มจากไฟล์อื่น (ชุดประกอบเดียวกัน)", "",
                                                  "โมเดลชุดเดียวกัน (*.rrsasm *.json *.igs *.iges *.stp *.step)")
        if not path:
            return False
        if Path(path).suffix.lower() not in (".rrsasm", ".json"):
            return self.import_cad(path, use=lambda other: self._adopt(other, Path(path).name))
        try:
            other = a3.AssemblyModel.load(path)
        except (OSError, ValueError, TypeError) as e:
            QMessageBox.warning(self, "รับกลุ่มจากไฟล์อื่น", f"อ่านไฟล์ไม่ได้: {e}")
            return False
        return self._adopt(other, Path(path).name)

    def _adopt(self, other: a3.AssemblyModel, name: str) -> bool:
        levels = a3.adopt_groups(self.model, other)
        if not levels:
            QMessageBox.warning(self, "รับกลุ่มจากไฟล์อื่น", f"ไม่พบชิ้นของ {name} ที่อยู่ตำแหน่งเดียวกับชิ้นในโมเดลนี้\n\n"
                                "ต้องเป็นชุดประกอบเดียวกัน ส่งออกจากไฟล์เดียวกัน พิกัดและหน่วยเดียวกัน")
            return False
        total = len([p for p in self.model.parts if p.group != a3.REF_GROUP])
        unsorted = len(a3.tray_unsorted(self.model, levels))
        self.use_tray_sequence(ask=False, levels=levels)
        self.state.notify(f"รับกลุ่มจาก {name}: ตรงกัน {len(levels)} จาก {total} ชิ้น · จัดเข้าลำดับ 13 ขั้นแล้ว"
                          + (f" · ยังไม่ได้จัด {unsorted} ชิ้น (ขั้น 4)" if unsorted else ""))
        return True

    def _done_toggled(self, checked: bool) -> None:
        if self._loading or not self.step:
            return
        im.mark(self.get_job(), self._record_key(self.step), done=checked, by=getattr(self.state.actor, "name", ""))
        self.progress.setText(f"ประกอบแล้ว {len(self.done_steps())} / {len(self.model.steps)} ขั้น")

    # ---- demonstration ----------------------------------------------------
    def play_part(self, part_id: str = "") -> bool:
        """Show how one part is fitted - the one given, else the one selected in the picture or in the table: it
        travels to its place in the big picture, with its way (the direction) and its place marked. Again: once more."""
        if not self.model:
            return False
        chosen = self.selected_parts()
        part = self.model.part(part_id or self.view.selected) or (chosen[0] if chosen else None)
        if part is None:
            self.state.notify("เลือกชิ้นส่วนก่อน – คลิกชิ้นในภาพหรือแถวในตาราง แล้วกด เล่นชิ้นที่เลือก")
            return False
        if part.step == 0:
            self.state.notify(f"{part.name} เป็นชิ้นของรถ (อ้างอิง) – ไม่ต้องประกอบ")
            return False
        self.stop_play()
        if not self.view.play_part(part.id):
            return False
        self._card_out_of_the_way()
        travel = self.view.travel_of(part)
        self.state.notify(f"เล่น {part.name}: {self.view.way_in(travel)} {float((travel ** 2).sum()) ** 0.5:,.0f} มม. "
                          f"→ ตำแหน่งติดตั้ง (ขั้นที่ {part.step})")
        return True

    def _card_out_of_the_way(self) -> None:
        """The detail card must not lie over the way of the part that is played: it moves beside the way - over the
        panels next to the picture when the picture itself has no room (unless the user put the card somewhere
        himself)."""
        popup, view = self.popup, self.view
        if popup.isHidden() or popup.is_pinned() or not view._solo:
            return
        view.repaint()  # the way is drawn: where is it?
        if view.way is None:
            return
        _id, a, b, _m = view.way
        host = popup.parentWidget()
        origin = view.mapTo(host, view.rect().topLeft()) if host is not view else view.rect().topLeft()
        x0, x1 = sorted((a.x() + origin.x(), b.x() + origin.x()))
        y0, y1 = sorted((a.y() + origin.y(), b.y() + origin.y()))
        x0, y0, x1, y1 = x0 - 60, y0 - 60, x1 + 60, y1 + 60  # the part itself is wider than the line of its way
        card = popup.geometry()
        cw, ch = card.width(), card.height()
        max_x, max_y = max(8, host.width() - cw - 8), max(8, host.height() - ch - 8)

        def over(x: float, y: float) -> float:
            return max(0.0, min(x + cw, x1) - max(x, x0)) * max(0.0, min(y + ch, y1) - max(y, y0))

        if not over(card.left(), card.top()):
            return
        top = min(max(card.top(), 8), max_y)
        # at the edge of the picture when that is clear of the way, else farther out, over the panel beside it
        right = max(x1 + 8, origin.x() + view.width() - cw - 8)
        left = min(x0 - cw - 8, origin.x() + 8)
        spots = [(min(max(right, 8), max_x), top), (min(max(left, 8), max_x), top),
                 (min(max(card.left(), 8), max_x), min(max(y1 + 8, 8), max_y)),
                 (min(max(card.left(), 8), max_x), min(max(y0 - ch - 8, 8), max_y))]
        x, y = min(spots, key=lambda spot: over(*spot))  # beside the way; the first one when several are clear
        popup.move(int(x), int(y))

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
        z3 = [p for p in paths if z3_model.is_z3_file(p)]
        if z3:  # read on a worker: the model is set when it is done
            self.import_z3(z3[0], ignored=len(paths) - 1)
            return None
        cad = [p for p in paths if cad_import.is_cad_file(p)]
        if cad:  # read on a worker: the model is set when it is done
            self.import_cad(cad[0], ignored=len(paths) - 1)
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

    def import_z3(self, path: str, ignored: int = 0) -> bool:
        """A ZW3D file: its parts as boxes where the file places them, the design's faults in the note. Read on a
        worker thread (a big assembly takes a few seconds)."""
        if self._cad_busy:
            self.state.notify(f"กำลังนำเข้า {self._cad_busy} อยู่ – รอให้เสร็จก่อน")
            return False
        name, note = Path(path).name, self.note.text()
        self._cad_busy = name
        self.note.setText(f"กำลังอ่านไฟล์ ZW3D {name} …")
        if ignored:
            self.state.notify(f"นำเข้าไฟล์ CAD ได้ครั้งละ 1 ไฟล์ – ใช้ {name} (อีก {ignored} ไฟล์ไม่ได้นำเข้า)")

        def done(got) -> None:
            self._cad_busy = ""
            model, check = got
            self.set_model(model)
            warn = len(check.lines())
            self.state.notify(f"เปิด {name}: {len(model.parts)} ชิ้น (กล่องตามตำแหน่งในแบบ) · {len(model.steps)} ขั้น"
                              + (f" · คำเตือนของแบบ {warn} ข้อ – ชี้เมาส์ที่บันทึกใต้ชื่อโมเดลเพื่อดู" if warn else ""))

        def failed(message: str) -> None:
            self._cad_busy = ""
            self.note.setText(note)
            QMessageBox.warning(self, "นำเข้าโมเดล", f"เปิด {name} ไม่ได้\n\n{message}")

        run_async(z3_model.model_from_z3, done, failed, path)
        return True

    def import_cad(self, path: str, ignored: int = 0, use=None) -> bool:
        """STEP / IGES: read by OpenCascade behind a worker thread (in a child process, see `read_cad_isolated`),
        so that a file of hundreds of MB does not freeze the window; the note shows how far it is. With `use` the
        model that was read goes to that function and the model on the page stays."""
        if self._cad_busy:
            self.state.notify(f"กำลังนำเข้า {self._cad_busy} อยู่ – รอให้เสร็จก่อน")
            return False
        if not cad_import.have_ocp():
            QMessageBox.warning(self, "นำเข้าโมเดล", cad_import.INSTALL_HINT)
            return False
        name, note = Path(path).name, self.note.text()
        self._cad_busy, self._cad_stage, self._cad_started = name, ("เริ่มอ่านไฟล์", 0.0), time.monotonic()
        self._show_cad_progress()
        self._cad_timer.start()
        if ignored:
            self.state.notify(f"นำเข้าไฟล์ CAD ได้ครั้งละ 1 ไฟล์ – ใช้ {name} (อีก {ignored} ไฟล์ไม่ได้นำเข้า)")

        def finish() -> None:
            self._cad_busy = ""
            self._cad_timer.stop()

        def done(model: a3.AssemblyModel) -> None:
            finish()
            if use is not None:
                self.note.setText(note)
                use(model)
                return
            fits = a3.tray_sequence_fits(model)
            unsorted = 0
            if fits >= 4:  # the names are those of the parts of a flat tray: start from the 13 steps
                unsorted = len(a3.tray_unsorted(model))
                a3.apply_tray_sequence(model, self.get_job(), tidy=True)
            self.set_model(model)
            self.state.notify(f"นำเข้า {name}: {len(model.parts)} ชิ้น {a3.face_count(model):,} หน้า · {len(model.steps)} ขั้น"
                              + (" (ลำดับกระบะพื้นเรียบ 13 ขั้น จัดตามชื่อชิ้นและกลุ่ม" if fits >= 4 else "")
                              + (f" · ยังไม่ได้จัด {unsorted} ชิ้น อยู่ที่ขั้น 4" if unsorted else "") + (")" if fits >= 4 else "")
                              + " – แก้ชื่อ กลุ่ม และขั้นในตารางได้")

        def failed(message: str) -> None:
            finish()
            self.note.setText(note)
            QMessageBox.warning(self, "นำเข้าโมเดล", f"นำเข้า {name} ไม่ได้\n\n{message}")

        run_async(cad_import.read_cad_isolated, done, failed, path, progress=self._cad_progress.changed.emit)
        return True

    def _cad_progressed(self, stage: str, fraction: float) -> None:
        self._cad_stage = (stage, fraction)
        self._show_cad_progress()

    def _show_cad_progress(self) -> None:
        if not self._cad_busy:
            return
        stage, fraction = self._cad_stage
        spent = int(time.monotonic() - self._cad_started)
        self.note.setText(f"กำลังนำเข้า {self._cad_busy} – {stage} {fraction:.0%} · ผ่านไป {spent // 60}:{spent % 60:02d} นาที "
                          "(ไฟล์ใหญ่ใช้เวลาหลายนาที ระหว่างนี้ใช้งานหน้าต่างอื่นต่อได้)")

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
        looked_at = (set(self.view.focus), self.view.picked_line)
        folder = Path(tempfile.mkdtemp(prefix="rrs_asm_")) if path.lower().endswith(".pdf") else Path(path).with_suffix("")
        folder.mkdir(parents=True, exist_ok=True)
        images = {}
        self.view.explode = 0.0
        def picture(name: str) -> str:
            file = folder / name
            self.view.render_image(1280, 800, fit=True, margin=0.7).save(str(file))
            return QUrl.fromLocalFile(str(file)).toString() if path.lower().endswith(".pdf") else f"{folder.name}/{file.name}"

        for n in range(1, len(self.model.steps) + 1):
            self.view.set_step(n, animate=False)
            plan = self.view.plan()
            if plan is None:
                self.view._anim = 0.55
                images[n] = picture(f"step_{n:02d}.png")
                continue
            # a crowded step: all groups with their callouts, then its groups with their numbers - every part IN its
            # place (for forty small brackets the place is what the picture has to say)
            self.view._anim = 0.0
            pictures = [(picture(f"step_{n:02d}.png"), [])]
            for i, groups in enumerate(a3.pdf_pictures(plan), 1):
                self.view.focus = set(groups)
                pictures.append((picture(f"step_{n:02d}_{i}.png"), groups))
            self.view.focus = set()
            images[n] = pictures
        self.view._anim = 0.0
        self.step, self.view.yaw, self.view.pitch, self.view.zoom, self.view.target, self.view.explode = keep
        self.view.set_step(self.step or None, animate=False)
        self.view.set_focus(*looked_at, tell=False)
        doc = a3.render_steps_html(self.model, images, self.get_job().job_no, self.done_steps())
        if path.lower().endswith(".pdf"):
            write_pdf(path, doc)
        else:
            Path(path).write_text(doc, encoding="utf-8")
        self.state.notify(f"บันทึก {Path(path).name} แล้ว ({len(images)} ขั้นตอน)")
        return path

