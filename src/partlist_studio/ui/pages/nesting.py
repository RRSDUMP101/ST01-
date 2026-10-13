"""วางแผนตัดเหล็ก - nesting of the flat patterns of the Part List on the sheets in stock."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import QBrush, QColor, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import (QCheckBox, QDoubleSpinBox, QGraphicsScene, QGraphicsView, QHBoxLayout, QLabel, QMenu,
                               QSpinBox, QSplitter, QVBoxLayout, QWidget)

from ...core import nesting
from ..state import AppState
from ..widgets import Card, PageHeader, button, fill, selected_rows, table


class SheetView(QGraphicsView):
    """The sheets of one material/thickness side by side with the parts placed on them."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setScene(QGraphicsScene(self))
        self.setRenderHint(QPainter.Antialiasing)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setBackgroundBrush(QColor("#0F1B2B"))
        self.setMinimumHeight(260)

    def show_group(self, group: nesting.NestGroup | None) -> None:
        scene = self.scene()
        scene.clear()
        if group is None:
            return
        sheet_pen = QPen(QColor("#9FB3CC"))
        sheet_pen.setCosmetic(True)
        part_pen = QPen(QColor("#F28C28"))
        part_pen.setCosmetic(True)
        hole_pen = QPen(QColor("#4FC3F7"))
        hole_pen.setCosmetic(True)
        x0 = 0.0
        for n, s in enumerate(group.sheets, start=1):
            scene.addRect(x0, -s.height, s.width, s.height, sheet_pen, QBrush(QColor("#16283E")))
            label = scene.addSimpleText(f"{n}. {s.size}")
            label.setBrush(QColor("#E6EDF6"))
            label.setScale(s.width / 700)
            label.setPos(x0, 20)
            for pl in s.placements:
                p = group.parts[pl.part]
                loops = p.outline or [[(0, 0), (p.width, 0), (p.width, p.height), (0, p.height)]]
                for k, loop in enumerate(loops):
                    pts = [nesting.place_point(pt, p, pl, x0, 0) for pt in loop]
                    poly = QPolygonF([QPointF(x, -y) for x, y in pts])
                    scene.addPolygon(poly, part_pen if k == 0 else hole_pen,
                                     QBrush(QColor(242, 140, 40, 60)) if k == 0 else QBrush(Qt.NoBrush))
            x0 += s.width + 150
        self.fitInView(scene.itemsBoundingRect(), Qt.KeepAspectRatio)

    def wheelEvent(self, event):  # noqa: N802
        factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
        self.scale(factor, factor)

    def mouseDoubleClickEvent(self, event):  # noqa: N802
        self.fitInView(self.scene().itemsBoundingRect(), Qt.KeepAspectRatio)


class NestingPage(QWidget):
    def __init__(self, state: AppState, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self.groups: list[nesting.NestGroup] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 16)
        lay.setSpacing(12)
        header = PageHeader("วางแผนตัดแผ่นเหล็ก (จากรูปคลี่ในแบบ DWG)",
                            "วางรูปคลี่ของ Part List × จำนวนคัน ลงแผ่นเหล็กที่มีในสต็อก (ขนาดแผ่นอ่านจากชื่อสินค้า) "
                            "→ จำนวนแผ่นที่ต้องใช้จริง และ % เศษ เทียบกับการคิดจากน้ำหนัก")
        run = header.add_action(button("คำนวณแผนตัด", "accent"))
        run.clicked.connect(self.run)
        exp = header.add_action(button("ส่งออก ▾"))
        menu = QMenu(exp)
        menu.addAction("แผนตัด (Excel)…", self.export_excel)
        menu.addAction("แผนวางชิ้นงาน (DXF สำหรับ ZWCAD)…", self.export_dxf)
        exp.setMenu(menu)
        lay.addWidget(header)

        params = Card("ค่าที่ใช้วาง")
        row = QHBoxLayout()
        s = state.settings
        self.gap = QDoubleSpinBox()
        self.gap.setRange(0, 100)
        self.gap.setValue(float(s.get("nest/gap", "10") or 10))
        self.gap.setSuffix(" มม.")
        self.margin = QDoubleSpinBox()
        self.margin.setRange(0, 200)
        self.margin.setValue(float(s.get("nest/margin", "10") or 10))
        self.margin.setSuffix(" มม.")
        self.rotate = QCheckBox("หมุน 90° ได้")
        self.rotate.setChecked(s.get("nest/rotate", "1") != "0")
        self.default_thk = QDoubleSpinBox()
        self.default_thk.setRange(0, 50)
        self.default_thk.setDecimals(1)
        self.default_thk.setValue(float(s.get("nest/default_thk", "0") or 0))
        self.default_thk.setSuffix(" มม.")
        self.default_thk.setSpecialValueText("ไม่ใช้")
        self.sets = QSpinBox()
        self.sets.setRange(1, 999)
        self.sets.setSuffix(" คัน")
        for label, w in (("ระยะห่างชิ้นงาน", self.gap), ("ขอบแผ่น", self.margin), ("", self.rotate),
                         ("ความหนา (เมื่อแบบไม่ระบุ)", self.default_thk), ("จำนวนผลิต", self.sets)):
            if label:
                row.addWidget(QLabel(label))
            row.addWidget(w)
        row.addStretch(1)
        params.body.addLayout(row)
        self.summary = QLabel("กด คำนวณแผนตัด – ใช้ชิ้นส่วนใน Part List ที่มีความหนาและขนาดรูปคลี่ (จากการนำเข้าแบบ DWG/DXF)")
        self.summary.setObjectName("Hint")
        self.summary.setWordWrap(True)
        params.body.addWidget(self.summary)
        lay.addWidget(params)

        split = QSplitter(Qt.Vertical)
        self.table = table(nesting.PLAN_HEADERS, [120, 70, 260, 110, 110, 80, 90, 70, 80, 60, 90, 300])
        self.table.itemSelectionChanged.connect(self._selected)
        split.addWidget(self.table)
        self.view = SheetView()
        split.addWidget(self.view)
        split.setSizes([260, 420])
        lay.addWidget(split, 1)
        state.partlist_changed.connect(lambda: self.sets.setValue(max(1, state.partlist.info.build_qty)))
        self.sets.setValue(max(1, state.partlist.info.build_qty))

    def params(self) -> nesting.NestParams:
        s = self.state.settings
        s.set("nest/gap", self.gap.value())
        s.set("nest/margin", self.margin.value())
        s.set("nest/rotate", "1" if self.rotate.isChecked() else "0")
        s.set("nest/default_thk", self.default_thk.value())
        return nesting.NestParams(self.gap.value(), self.margin.value(), self.rotate.isChecked())

    def run(self) -> None:
        parts, skipped = nesting.nest_parts_from(self.state.partlist, self.sets.value(), self.default_thk.value())
        if not parts:
            self.actions.error("ไม่มีชิ้นงานที่วางได้",
                               "ชิ้นส่วนต้องมีความหนา (เช่น t2.5) และขนาดรูปคลี่ – นำเข้าแบบ DWG/DXF ในหน้า แบบ 2D "
                               "หรือใส่ความหนาเมื่อแบบไม่ระบุ")
            return
        self.groups = nesting.plan(parts, self.state.stock, self.params(), self.state.settings.densities)
        rows = nesting.plan_rows(self.groups)
        self._row_group = []
        for g in self.groups:
            self._row_group += [g] * max(1, len(g.sheet_counts()))
        fill(self.table, rows)
        sheets = sum(len(g.sheets) for g in self.groups)
        by_weight = sum(g.by_weight for g in self.groups)
        area = sum(g.sheet_area for g in self.groups)
        used = sum(g.parts_area for g in self.groups)
        big = sum(len(g.too_big) for g in self.groups)
        self.summary.setText(
            f"<b>{sheets} แผ่น</b> ({len(self.groups)} ความหนา) · ใช้เนื้อเหล็ก {used / area:.0%} · เศษ {1 - used / area:.0%} "
            f"· คิดจากน้ำหนักได้ {by_weight:.1f} แผ่น (ไม่รวมเศษ)" + (f" · ชิ้นใหญ่เกินแผ่น {big}" if big else "")
            + (f" · ไม่ได้วาง {len(skipped)} รายการ (ไม่มีความหนา/ขนาด หรือ ซื้อสำเร็จ)" if skipped else ""))
        if rows:
            self.table.selectRow(0)
        self.state.notify(f"แผนตัด {sheets} แผ่น")

    def _selected(self) -> None:
        rows = selected_rows(self.table)
        if rows and rows[0] < len(getattr(self, "_row_group", [])):
            self.view.show_group(self._row_group[rows[0]])

    def export_excel(self) -> None:
        if not self.groups:
            self.run()
        if not self.groups:
            return
        path = self.actions.save_path("แผนตัดแผ่นเหล็ก", self.actions.default_name(".xlsx", "แผนตัดเหล็ก"), "Excel (*.xlsx)")
        if path:
            info = self.state.partlist.info
            nesting.export_plan(self.groups, path, self.params(),
                                f"แผนตัดแผ่นเหล็ก {info.so_no} {info.job_type} × {self.sets.value()} คัน")
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def export_dxf(self) -> None:
        if not self.groups:
            self.run()
        if not self.groups:
            return
        path = self.actions.save_path("แผนวางชิ้นงาน (DXF)", self.actions.default_name(".dxf", "แผนตัดเหล็ก"), "DXF (*.dxf)")
        if path:
            nesting.export_dxf(self.groups, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว – เปิดใน ZWCAD ได้")
