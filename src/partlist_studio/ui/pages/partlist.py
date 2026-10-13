"""Part List - the editable part table."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QAbstractItemView, QComboBox, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMenu,
                               QTableView, QVBoxLayout, QWidget)

from ...core.models import COLUMN_KEYS, STATUSES, Part
from ..state import AppState
from ..table_models import ChoiceDelegate, PartFilterProxy, PartTableModel
from ..widgets import PageHeader, button

COLUMN_WIDTHS = {"item_no": 50, "part_no": 120, "drawing_no": 110, "name": 200, "material": 90, "spec": 130,
                 "qty": 60, "unit": 60, "weight": 95, "stock_code": 130, "process": 100, "status": 90}


class PartListPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state = state
        self.actions = actions
        self._editing = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)

        header = PageHeader("Part List", "รายการชิ้นส่วน วัสดุ จำนวน หน่วย กระบวนการ และสถานะความพร้อม "
                                         "– แก้ไขในตารางได้โดยตรง (ดับเบิลคลิก)")
        imp = header.add_action(button("นำเข้า ▾", "primary"))
        imp_menu = QMenu(imp)
        imp_menu.addAction("แบบ 2D ZWCAD (DWG/DXF)…", lambda: actions.import_drawings())
        imp_menu.addAction("ตาราง BOM จาก ZWCAD / Excel / CSV…", actions.import_table)
        imp_menu.addAction("จากแบบกระบะมาตรฐาน (หน้า แบบกระบะ)…", lambda: self.window().go("models"))
        imp.setMenu(imp_menu)
        exp = header.add_action(button("ส่งออก ▾"))
        exp_menu = QMenu(exp)
        exp_menu.addAction("ตาราง Part List สำหรับ ZWCAD (DXF)…", actions.export_cad_dxf)
        exp_menu.addAction("ตาราง Part List สำหรับ ZWCAD (DWG)…", actions.export_cad_dwg)
        exp_menu.addAction("BOM สำหรับ ZWCAD Data Link (CSV/Excel)…", actions.export_cad_table)
        exp_menu.addSeparator()
        exp_menu.addAction("Part List ภาษาไทย สำหรับสโตร์/ฝ่ายผลิต (Excel)…", actions.export_excel_report)
        exp_menu.addAction("Part List รูปแบบบริษัท (Parts List All Model พร้อมรูป)…", actions.export_company_bom)
        exp.setMenu(exp_menu)
        lay.addWidget(header)

        tools = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("ค้นหา รหัส / ชื่อ / วัสดุ / เลขที่แบบ …")
        self.search.setClearButtonEnabled(True)
        self.search.setMaximumWidth(340)
        tools.addWidget(self.search)
        self.status_filter = QComboBox()
        self.status_filter.addItems(["ทุกสถานะ"] + STATUSES)
        tools.addWidget(self.status_filter)
        tools.addStretch(1)
        for text, slot in (("+ เพิ่มแถว", self.add_row), ("ลบแถวที่เลือก", self.remove_rows),
                           ("เรียงลำดับใหม่", self.renumber)):
            b = button(text)
            b.clicked.connect(slot)
            tools.addWidget(b)
        lay.addLayout(tools)

        self.model = PartTableModel(state.partlist, self)
        self.proxy = PartFilterProxy(self)
        self.proxy.setSourceModel(self.model)
        self.view = QTableView()
        self.view.setModel(self.proxy)
        self.view.setItemDelegate(ChoiceDelegate(self.view))
        self.view.setSortingEnabled(True)
        self.view.sortByColumn(-1, Qt.AscendingOrder)
        self.view.setAlternatingRowColors(True)
        self.view.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.view.setEditTriggers(QAbstractItemView.DoubleClicked | QAbstractItemView.EditKeyPressed |
                                  QAbstractItemView.AnyKeyPressed)
        self.view.verticalHeader().setDefaultSectionSize(30)
        self.view.verticalHeader().setVisible(False)
        hh = self.view.horizontalHeader()
        hh.setStretchLastSection(True)
        hh.setSectionResizeMode(QHeaderView.Interactive)
        for i, key in enumerate(COLUMN_KEYS):
            if key in COLUMN_WIDTHS:
                self.view.setColumnWidth(i, COLUMN_WIDTHS[key])
        lay.addWidget(self.view, 1)

        self.footer = QLabel()
        self.footer.setObjectName("Hint")
        lay.addWidget(self.footer)

        self.search.textChanged.connect(self.proxy.setFilterFixedString)
        self.status_filter.currentTextChanged.connect(
            lambda s: self.proxy.set_status("" if s == "ทุกสถานะ" else s))
        self.model.dataChanged.connect(self._edited)
        state.partlist_changed.connect(self._external_change)
        state.partlist_replaced.connect(lambda: self.model.set_partlist(self.state.partlist))
        self._update_footer()

    # ---------------------------------------------------------------------
    def _edited(self, *args) -> None:
        self._editing = True
        try:
            self.state.mark_dirty()
        finally:
            self._editing = False

    def _external_change(self) -> None:
        if not self._editing:
            self.model.refresh()
        self._update_footer()

    def _update_footer(self) -> None:
        pl = self.state.partlist
        issues = self.model.issues()
        errors = sum(1 for _r, level, _m in issues if level == "error")
        warns = len(issues) - errors
        text = (f"{len(pl.parts)} รายการ · จำนวนรวม {pl.total_qty:,.0f} ชิ้น/คัน · "
                f"น้ำหนักรวม {pl.total_weight:,.2f} kg/คัน")
        if errors or warns:
            text += f"   ·   ⚠ ต้องแก้ {errors} · ควรตรวจ {warns} (แถวสีแดง/เหลือง – ชี้เมาส์เพื่อดูสาเหตุ)"
        self.footer.setText(text)

    def _selected_rows(self) -> list[int]:
        return sorted({self.proxy.mapToSource(i).row() for i in self.view.selectionModel().selectedRows()})

    def add_row(self) -> None:
        rows = self._selected_rows()
        row = rows[-1] + 1 if rows else len(self.state.partlist.parts)
        self.model.insert_parts(row, [Part(item_no=str(len(self.state.partlist.parts) + 1))])
        self.state.mark_dirty()
        index = self.proxy.mapFromSource(self.model.index(row, COLUMN_KEYS.index("part_no")))
        self.view.scrollTo(index)
        self.view.setCurrentIndex(index)
        self.view.edit(index)

    def remove_rows(self) -> None:
        rows = self._selected_rows()
        if rows:
            self.model.remove_rows(rows)
            self.state.mark_dirty()

    def renumber(self) -> None:
        self.state.partlist.renumber()
        self.state.mark_dirty()
