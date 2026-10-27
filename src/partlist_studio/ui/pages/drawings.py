"""แบบ 2D - drawing register (ทะเบียนแบบ) of the DWG/DXF files used in this job."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (QAbstractItemView, QComboBox, QHBoxLayout, QHeaderView, QLabel, QSplitter,
                               QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget)

from ...core import dwg_io
from ..state import AppState
from ..widgets import Card, DrawingPreview, PageHeader, button, empty_hint, run_async

REG_COLUMNS = ["ไฟล์", "เลขที่แบบ", "ชื่อแบบ", "Rev.", "วัสดุ", "หนา", "รายการ", "จำนวนชิ้น", "นำเข้าเมื่อ", "สถานะแบบ"]
DRAWING_STATUSES = ["รอตรวจ", "อนุมัติแล้ว", "แก้ไข", "ยกเลิก"]


class DrawingsPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state = state
        self.actions = actions
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        header = PageHeader("แบบ 2D (ZWCAD DWG/DXF)",
                            "ทะเบียนแบบของงาน – อ่าน Title Block, ตาราง BOM และรูปคลี่ชิ้นงานจากแบบ "
                            "เพื่อสร้าง Part List ให้สโตร์และฝ่ายผลิตใช้ข้อมูลชุดเดียวกัน")
        b = header.add_action(button("นำเข้าแบบ DWG/DXF", "primary",
                                     "เลือกไฟล์ DWG/DXF (หลายไฟล์ได้) หรือลากไฟล์มาวางบนหน้าต่าง"))
        b.clicked.connect(lambda: actions.import_drawings())
        rev = header.add_action(button("เทียบ Rev.", tooltip="เทียบแบบ/Part List 2 Rev.: เพิ่ม ตัด จำนวน ขนาด วัสดุ รูปคลี่"))
        rev.clicked.connect(lambda: self.actions.window.compare_revisions())
        b = header.add_action(button("ส่งออกทะเบียนแบบ", tooltip="ทะเบียนแบบของงานนี้เป็น Excel"))
        b.clicked.connect(actions.export_drawing_register)
        lay.addWidget(header)

        split = QSplitter(Qt.Vertical)
        self.table = QTableWidget(0, len(REG_COLUMNS))
        self.table.setHorizontalHeaderLabels(REG_COLUMNS)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        hh = self.table.horizontalHeader()
        hh.setSectionResizeMode(QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(2, QHeaderView.Stretch)
        hh.setSectionResizeMode(len(REG_COLUMNS) - 1, QHeaderView.Fixed)
        self.table.setColumnWidth(len(REG_COLUMNS) - 1, 130)
        self.table.verticalHeader().setDefaultSectionSize(32)
        self.table.setMinimumHeight(150)  # header + 3 rows even on a 768 px screen
        self.table.itemSelectionChanged.connect(self._selected)
        empty_hint(self.table, "ยังไม่มีแบบในงานนี้ – กด นำเข้าแบบ DWG/DXF หรือลากไฟล์ .dwg / .dxf มาวางบนหน้าต่าง")
        split.addWidget(self.table)

        bottom = Card("ตัวอย่างแบบ")
        self.caption = QLabel("เลือกแบบในตารางเพื่อแสดงตัวอย่าง (สีส้ม = รูปคลี่ชิ้นงาน, สีฟ้า = รู/ช่องเจาะ)")
        self.caption.setObjectName("Hint")
        bottom.body.addWidget(self.caption)
        self.preview = DrawingPreview()
        bottom.body.addWidget(self.preview, 1)
        row = QHBoxLayout()
        self.reload_btn = button("อ่านแบบนี้อีกครั้ง", tooltip="อ่านไฟล์แบบที่เลือกใหม่ (เมื่อแก้แบบใน ZWCAD แล้ว)")
        self.reload_btn.clicked.connect(self._reload)
        self.add_btn = button("เพิ่มรายการจากแบบนี้…", tooltip="เปิดหน้าต่างนำเข้าของแบบนี้อีกครั้ง เลือกชิ้นส่วนที่จะเพิ่ม")
        self.add_btn.clicked.connect(self._add_again)
        self.remove_btn = button("ลบออกจากทะเบียน", tooltip="เอาแบบที่เลือกออกจากทะเบียนแบบ (รายการใน Part List ยังอยู่)")
        self.remove_btn.clicked.connect(self._remove)
        row.addWidget(self.reload_btn)
        row.addWidget(self.add_btn)
        row.addStretch(1)
        row.addWidget(self.remove_btn)
        bottom.body.addLayout(row)
        split.addWidget(bottom)
        split.setStretchFactor(0, 2)
        split.setStretchFactor(1, 3)
        split.setChildrenCollapsible(False)
        split.setSizes([260, 460])
        lay.addWidget(split, 1)

        state.partlist_changed.connect(self.refresh)
        self.refresh()

    def refresh(self) -> None:
        drawings = self.state.partlist.drawings
        current = self.table.currentRow()
        self.table.setRowCount(len(drawings))
        for r, d in enumerate(drawings):
            values = [d.file_name, d.drawing_no, d.title, d.revision, d.material, d.thickness, str(d.part_count),
                      str(d.pieces) if d.pieces else "", d.imported]
            for c, text in enumerate(values):
                item = QTableWidgetItem(text)
                if c == 0:
                    item.setToolTip(d.path)
                self.table.setItem(r, c, item)
            combo = self.table.cellWidget(r, len(REG_COLUMNS) - 1)
            if not isinstance(combo, QComboBox):  # made once per row, then kept (a new one each time would leave the
                combo = QComboBox()  # old one on the screen until Qt deletes it)
                combo.addItems(DRAWING_STATUSES)
                combo.setToolTip("สถานะของแบบ: รอตรวจ / อนุมัติแล้ว / แก้ไข / ยกเลิก")
                combo.currentTextChanged.connect(lambda s, row=r: self._status(row, s))
                self.table.setCellWidget(r, len(REG_COLUMNS) - 1, combo)
            combo.blockSignals(True)
            combo.setCurrentText(d.status)
            combo.blockSignals(False)
        if drawings and current < 0:
            self.table.selectRow(len(drawings) - 1)
        elif 0 <= current < len(drawings):
            self.table.selectRow(current)
        has = bool(drawings)
        for b in (self.reload_btn, self.add_btn, self.remove_btn):
            b.setEnabled(has)
        if not has:
            self.preview.show_drawing(None)

    def _status(self, row: int, status: str) -> None:
        drawings = self.state.partlist.drawings
        record = drawings[row] if 0 <= row < len(drawings) else None
        if record is not None and record.status != status:
            record.status = status
            # deferred: refresh() rebuilds the combo boxes, including the one emitting this signal
            QTimer.singleShot(0, self.state.mark_dirty)

    def _record(self):
        row = self.table.currentRow()
        drawings = self.state.partlist.drawings
        return drawings[row] if 0 <= row < len(drawings) else None

    def _selected(self) -> None:
        record = self._record()
        if record is None:
            return
        data = self.state.drawing_cache.get(record.path)
        if data is not None:
            self._show(data)
        elif Path(record.path).is_file():
            self._read(record.path)
        else:
            self.preview.show_drawing(None)
            self.caption.setText(f"ไม่พบไฟล์ {record.path} (ย้ายหรือเปลี่ยนชื่อ?)")

    def _read(self, path: str) -> None:
        settings = self.state.settings

        def done(data):
            self.state.drawing_cache[path] = data
            self._show(data)

        run_async(dwg_io.read_drawing, done, lambda e: self.caption.setText(f"อ่านแบบไม่ได้: {e}"),
                  path, settings.converter(), settings.get("dwg/cut_layer"))

    def _show(self, data) -> None:
        outers = data.outer_profiles
        bits = [data.file_name]
        if data.bom:
            bits.append(f"BOM {len(data.bom.data_rows)} แถว")
        if outers:
            bits.append(f"รูปคลี่ {len(outers)} ชิ้น · ระยะตัดรวม {sum(p.cut_length for p in outers):,.0f} mm")
        if data.blocks:
            bits.append(f"บล็อกมาตรฐาน {sum(data.blocks.values())} ตัว")
        self.caption.setText("   ·   ".join(bits))
        self.preview.show_drawing(data)

    def _reload(self) -> None:
        record = self._record()
        if record:
            self.state.drawing_cache.pop(record.path, None)
            self._read(record.path)

    def _add_again(self) -> None:
        record = self._record()
        if record:
            self.actions.import_drawings([record.path])

    def _remove(self) -> None:
        record = self._record()
        if record:
            self.state.partlist.drawings.remove(record)
            self.state.mark_dirty()
