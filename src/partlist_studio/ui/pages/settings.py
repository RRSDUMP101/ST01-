"""ตั้งค่า - DWG converter, cutting layer and material densities."""

from __future__ import annotations

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QFileDialog, QFormLayout, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from ...core.dwg_io import DEFAULT_DENSITIES, find_converter
from ...core.models import to_number
from ..state import AppState
from ..widgets import Card, PageHeader, button

ODA_URL = "https://www.opendesign.com/guestfiles/oda_file_converter"


class SettingsPage(QWidget):
    def __init__(self, state: AppState, parent=None):
        super().__init__(parent)
        self.state = state
        s = state.settings
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(14)
        lay.addWidget(PageHeader("ตั้งค่า", "การอ่านแบบ DWG และค่าที่ใช้คำนวณน้ำหนักชิ้นงานจากรูปคลี่"))

        conv = Card("โปรแกรมแปลง DWG → DXF")
        text = QLabel("ไฟล์ DWG เป็นรูปแบบปิด จึงต้องใช้ <b>ODA File Converter</b> (ฟรี มีทั้ง Windows และ macOS) "
                      "แปลงเป็น DXF ก่อนอ่าน · ถ้าไม่ติดตั้ง ให้ใช้ ZWCAD สั่ง <i>Save As → DXF</i> แทน "
                      "· ใช้ LibreDWG <i>dwg2dxf</i> ได้เช่นกัน")
        text.setWordWrap(True)
        conv.body.addWidget(text)
        row = QHBoxLayout()
        self.conv_path = QLineEdit(s.get("dwg/converter_path"))
        self.conv_path.setPlaceholderText("ว่างไว้ = ค้นหาอัตโนมัติในตำแหน่งติดตั้งมาตรฐาน")
        self.conv_path.editingFinished.connect(self._save_conv)
        row.addWidget(self.conv_path, 1)
        b = button("เลือก…")
        b.clicked.connect(self._browse)
        row.addWidget(b)
        b = button("ค้นหาอัตโนมัติ")
        b.clicked.connect(self._auto)
        row.addWidget(b)
        b = button("ดาวน์โหลด ODA File Converter")
        b.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(ODA_URL)))
        row.addWidget(b)
        conv.body.addLayout(row)
        self.conv_status = QLabel()
        conv.body.addWidget(self.conv_status)
        lay.addWidget(conv)

        cut = Card("การอ่านรูปคลี่ชิ้นงาน")
        form = QFormLayout()
        self.cut_layer = QLineEdit(s.get("dwg/cut_layer"))
        self.cut_layer.setPlaceholderText("ว่างไว้ = อัตโนมัติ (ข้ามเลเยอร์ DIM, TEXT, FRAME, TITLE, CENTER …)")
        self.cut_layer.editingFinished.connect(lambda: s.set("dwg/cut_layer", self.cut_layer.text().strip()))
        form.addRow("เลเยอร์เส้นตัด (Layer)", self.cut_layer)
        cut.body.addLayout(form)
        hint = QLabel("แนะนำให้ฝ่ายเขียนแบบวาดรูปคลี่บนเลเยอร์เดียวกันเสมอ เช่น <b>CUT</b> และใช้ Title Block ที่มี "
                      "Attribute: DWG_NO, TITLE, MATERIAL, THK, QTY, REV เพื่อให้อ่านค่าได้ครบ")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        cut.body.addWidget(hint)
        lay.addWidget(cut)

        dens = Card("ความหนาแน่นวัสดุ (kg/dm³) สำหรับคำนวณน้ำหนัก = พื้นที่สุทธิ × ความหนา × ความหนาแน่น")
        self.table = QTableWidget(0, 2)
        self.table.setHorizontalHeaderLabels(["วัสดุ (ขึ้นต้นด้วย)", "kg/dm³"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setMinimumHeight(220)
        self.table.itemChanged.connect(self._save_densities)
        dens.body.addWidget(self.table)
        row = QHBoxLayout()
        for text, slot in (("+ เพิ่มวัสดุ", self._add_density), ("ลบที่เลือก", self._remove_density),
                           ("คืนค่าเริ่มต้น", self._reset_densities)):
            b = button(text)
            b.clicked.connect(slot)
            row.addWidget(b)
        row.addStretch(1)
        dens.body.addLayout(row)
        lay.addWidget(dens, 1)

        self._load_densities(s.densities)
        self._update_status()

    # ---- converter --------------------------------------------------------
    def _save_conv(self) -> None:
        self.state.settings.set("dwg/converter_path", self.conv_path.text().strip())
        self._update_status()

    def _browse(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "เลือก ODAFileConverter หรือ dwg2dxf")
        if path:
            self.conv_path.setText(path)
            self._save_conv()

    def _auto(self) -> None:
        conv = find_converter("")
        self.conv_path.setText(conv.exe if conv else "")
        self._save_conv()

    def _update_status(self) -> None:
        conv = self.state.settings.converter()
        if conv:
            self.conv_status.setText(f"✔ พร้อมใช้: {conv.label}")
            self.conv_status.setStyleSheet("color:#2E9D5B;")
        else:
            self.conv_status.setText("✖ ยังไม่พบโปรแกรมแปลง – นำเข้าได้เฉพาะไฟล์ DXF")
            self.conv_status.setStyleSheet("color:#D64545;")

    # ---- densities --------------------------------------------------------
    def _load_densities(self, densities: dict[str, float]) -> None:
        self.table.blockSignals(True)
        self.table.setRowCount(0)
        for name, value in densities.items():
            r = self.table.rowCount()
            self.table.insertRow(r)
            self.table.setItem(r, 0, QTableWidgetItem(name))
            self.table.setItem(r, 1, QTableWidgetItem(f"{value:g}"))
        self.table.blockSignals(False)

    def _save_densities(self, *args) -> None:
        out = {}
        for r in range(self.table.rowCount()):
            name, value = self.table.item(r, 0), self.table.item(r, 1)
            if name and name.text().strip() and value:
                number = to_number(value.text())
                if number:
                    out[name.text().strip().upper()] = float(number)
        self.state.settings.densities = out

    def _add_density(self) -> None:
        r = self.table.rowCount()
        self.table.insertRow(r)
        self.table.setItem(r, 0, QTableWidgetItem("NEW"))
        self.table.setItem(r, 1, QTableWidgetItem("7.85"))

    def _remove_density(self) -> None:
        for r in sorted({i.row() for i in self.table.selectedIndexes()}, reverse=True):
            self.table.removeRow(r)
        self._save_densities()

    def _reset_densities(self) -> None:
        self._load_densities(dict(DEFAULT_DENSITIES))
        self._save_densities()
