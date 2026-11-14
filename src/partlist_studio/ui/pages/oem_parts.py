"""แท็บ อะไหล่ Ford OEM: นำเข้าหน้าเว็บแผนภาพอะไหล่ที่บันทึกจาก Chrome (หรือไฟล์ JSON) → ดูตามแผนภาพ ค้นหา
→ เพิ่มเข้า Part List / ส่งออก Excel."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QComboBox, QFileDialog, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
                               QMessageBox, QSpinBox, QSplitter, QVBoxLayout, QWidget)

from ...core import oem_parts as oem
from ..state import AppState
from ..widgets import button, empty_hint, fill, selected_rows, table

HEADERS = ["แผนภาพ", "ตำแหน่ง", "Part Number", "รายละเอียด", "หมายเหตุ / รุ่นที่ใช้", "จำนวน", "MSRP", "ราคา", "ผู้ขาย"]
PAGE_FILTER = "หน้าเว็บที่บันทึก / ข้อความ (*.html *.htm *.mhtml *.txt);;ทุกไฟล์ (*)"
LAST_DIAGRAM = 29  # Headlamp Components of the 2026 F-350: diagrams 1 – 29


class OemPartsTab(QWidget):
    def __init__(self, state: AppState, parent=None):
        super().__init__(parent)
        self.state = state
        self.library = oem.OemLibrary(state.data_dir() / "oem_catalogs")
        self.rows: list[tuple[oem.Assembly, oem.OemPart]] = []
        lay = QVBoxLayout(self)
        row = QHBoxLayout()
        self.catalogs = QComboBox()
        self.catalogs.setMinimumWidth(360)
        self.catalogs.currentIndexChanged.connect(self._catalog_changed)
        row.addWidget(QLabel("แคตตาล็อก"))
        row.addWidget(self.catalogs, 1)
        for text, slot, kind, tip in (
                ("นำเข้าหน้าเว็บที่บันทึก…", self.import_pages, "accent",
                 "เลือกไฟล์ที่บันทึกจาก Chrome (⌘S / Ctrl+S แบบ HTML) ได้หลายไฟล์พร้อมกัน – 1 ไฟล์ต่อ 1 แผนภาพ"),
                ("นำเข้า JSON…", self.import_json, "", "ไฟล์แคตตาล็อกอะไหล่รูปแบบ JSON"),
                ("ลบ", self.remove_catalog, "", "ลบแคตตาล็อกนี้ออกจากโปรแกรม")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)
        self.coverage = QLabel()
        self.coverage.setObjectName("Hint")
        self.coverage.setWordWrap(True)
        lay.addWidget(self.coverage)

        split = QSplitter(Qt.Horizontal)
        self.diagrams = QListWidget()
        self.diagrams.currentRowChanged.connect(lambda _r: self.show_rows())
        split.addWidget(self.diagrams)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        self.search = QLineEdit()
        self.search.setPlaceholderText("ค้นหา Part Number / ชื่อ / หมายเหตุ เช่น  bulb  หรือ  13008")
        self.search.textChanged.connect(lambda _t: self.show_rows())
        rl.addWidget(self.search)
        self.table = table(HEADERS, [60, 60, 130, 220, 260, 55, 80, 80, 110])
        empty_hint(self.table, lambda: "ยังไม่มีแคตตาล็อก – บันทึกหน้าแผนภาพอะไหล่จาก Chrome แล้วกด นำเข้าหน้าเว็บที่บันทึก…"
                   if not self.library.catalogs else "ไม่พบรายการ")
        rl.addWidget(self.table, 1)
        split.addWidget(right)
        split.setSizes([260, 900])
        lay.addWidget(split, 1)

        row = QHBoxLayout()
        self.sum = QLabel()
        row.addWidget(self.sum, 1)
        self.sets = QSpinBox()
        self.sets.setRange(1, 999)
        self.sets.setSuffix(" คัน")
        row.addWidget(QLabel("จำนวนรถ"))
        row.addWidget(self.sets)
        for text, slot, kind, tip in (
                ("เพิ่มเข้า Part List", self.add_to_partlist, "primary",
                 "รายการที่เลือก (ไม่เลือก = ทั้งหมดที่แสดง) × จำนวนรถ เข้าเป็นรายการสั่งซื้ออะไหล่แท้ใน Part List"),
                ("ส่งออก Excel", self.export, "", "รายการที่แสดงเป็น Excel")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)
        self.reload()

    # ---- catalogues -------------------------------------------------------
    @property
    def catalog(self) -> oem.OemCatalog | None:
        i = self.catalogs.currentIndex()
        return self.library.catalogs[i] if 0 <= i < len(self.library.catalogs) else None

    def reload(self, select_key: str = "") -> None:
        self.library.reload()
        self.catalogs.blockSignals(True)
        self.catalogs.clear()
        for c in self.library.catalogs:
            self.catalogs.addItem(f"{c.vehicle or '?'} – {c.category or '?'}  ({len(c.assemblies)} แผนภาพ · "
                                  f"{c.part_count} รายการ)", c.key)
        if select_key:
            self.catalogs.setCurrentIndex(max(0, self.catalogs.findData(select_key)))
        self.catalogs.blockSignals(False)
        self._catalog_changed()

    def _catalog_changed(self, *_args) -> None:
        cat = self.catalog
        self.diagrams.blockSignals(True)
        self.diagrams.clear()
        if cat:
            self.diagrams.addItem(QListWidgetItem(f"ทั้งหมด ({cat.part_count})"))
            for a in cat.assemblies:
                self.diagrams.addItem(QListWidgetItem(f"{a.number}. {a.title}  ({len(a.parts)})"))
            missing = oem.missing_numbers(cat, max(LAST_DIAGRAM, max((a.number for a in cat.assemblies), default=0)))
            self.coverage.setText(
                f"ที่มา {cat.source} · ดึงข้อมูล {cat.fetched_at} · Part Number ไม่ซ้ำ {len(cat.unique_numbers())} เบอร์ · "
                + (f"ยังขาดแผนภาพ: {', '.join(map(str, missing))}" if missing else "ครบทุกแผนภาพ"))
        else:
            self.coverage.setText("เว็บอะไหล่ป้องกันการดึงข้อมูลอัตโนมัติ: เปิดแต่ละแผนภาพใน Chrome แล้วบันทึกหน้า (⌘S / Ctrl+S "
                                  "เลือก Webpage, HTML Only) จากนั้นนำเข้าทุกไฟล์พร้อมกัน")
        self.diagrams.setCurrentRow(0)
        self.diagrams.blockSignals(False)
        self.show_rows()

    def show_rows(self) -> None:
        cat = self.catalog
        if not cat:
            self.rows = []
        else:
            rows = cat.search(self.search.text())
            r = self.diagrams.currentRow()
            if r > 0:
                number = cat.assemblies[r - 1].number
                rows = [(a, p) for a, p in rows if a.number == number]
            self.rows = rows
        fill(self.table, [[a.number, p.callout, p.part_number, p.description, p.notes, oem.qty_of(p.qty),
                           p.msrp, p.price, p.seller] for a, p in self.rows])
        total = sum(oem.money(p.price or p.msrp) * oem.qty_of(p.qty) for _a, p in self.rows)
        self.sum.setText(f"{len(self.rows)} รายการ · ราคารวม (ราคาขาย × จำนวน) ${total:,.2f}")

    # ---- import -----------------------------------------------------------
    def import_pages(self, paths: list[str] | None = None) -> oem.OemCatalog | None:
        if paths is None:
            paths, _ = QFileDialog.getOpenFileNames(self, "เลือกหน้าแผนภาพที่บันทึกจาก Chrome", "", PAGE_FILTER)
        if not paths:
            return None
        pages = [Path(p).read_text(encoding="utf-8", errors="replace") for p in paths]
        cat = oem.catalog_from_pages(pages)
        if not cat.assemblies:
            QMessageBox.warning(self, "นำเข้าหน้าเว็บ", "ไม่พบแผนภาพในไฟล์ที่เลือก (หา 'Diagram N: …' ไม่เจอ) – "
                                "บันทึกหน้าแบบ Webpage, HTML Only หรือ Webpage, Complete แล้วลองใหม่")
            return None
        old = next((c for c in self.library.catalogs if c.key == cat.key), None)
        if old:  # pages saved in several rounds: the diagrams already imported stay
            have = {a.number for a in cat.assemblies}
            cat.assemblies = sorted(cat.assemblies + [a for a in old.assemblies if a.number not in have],
                                    key=lambda a: a.number)
        self.library.folder.mkdir(parents=True, exist_ok=True)
        cat.save(self.library.folder / f"{cat.key}.json")
        self.reload(cat.key)
        no_pn = sum(1 for _a, p in cat.rows() if not p.part_number)
        self.state.notify(f"นำเข้า {len(paths)} หน้า: {len(cat.assemblies)} แผนภาพ {cat.part_count} รายการ"
                          + (f" · ไม่มี Part Number {no_pn} รายการ" if no_pn else ""))
        return cat

    def import_json(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์แคตตาล็อกอะไหล่", "", "JSON (*.json)")
        if not path:
            return
        try:
            cat = self.library.add(path)
        except (OSError, ValueError) as e:
            QMessageBox.warning(self, "นำเข้า JSON", f"อ่านไฟล์ไม่ได้: {e}")
            return
        self.reload(cat.key)
        self.state.notify(f"นำเข้า {cat.vehicle} – {cat.category}: {len(cat.assemblies)} แผนภาพ {cat.part_count} รายการ")

    def remove_catalog(self) -> None:
        cat = self.catalog
        if cat and QMessageBox.question(self, "ลบแคตตาล็อก", f"ลบ {cat.vehicle} – {cat.category} ?") == QMessageBox.Yes:
            self.library.remove(cat)
            self.reload()

    # ---- out --------------------------------------------------------------
    def chosen(self) -> list[tuple[oem.Assembly, oem.OemPart]]:
        picked = selected_rows(self.table)
        return [self.rows[r] for r in picked] if picked else list(self.rows)

    def add_to_partlist(self) -> int:
        cat, rows = self.catalog, self.chosen()
        if not cat or not rows:
            return 0
        pl = self.state.partlist
        start = len(pl.parts)
        parts = [oem.to_part(a, p, cat.vehicle, self.sets.value()) for a, p in rows]
        for i, part in enumerate(parts, start=start + 1):
            part.item_no = str(i)
        pl.parts.extend(parts)
        self.state.mark_dirty()
        self.state.notify(f"เพิ่มอะไหล่แท้ Ford {len(parts)} รายการ × {self.sets.value()} คัน เข้า Part List แล้ว")
        return len(parts)

    def export(self, path: str = "") -> str:
        cat = self.catalog
        if not cat:
            return ""
        if not path:
            path, _ = QFileDialog.getSaveFileName(self, "ส่งออกอะไหล่ Ford", f"{cat.key}.xlsx", "Excel (*.xlsx)")
        if path:
            n = oem.export_xlsx(cat, self.rows, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({n} รายการ)")
        return path
