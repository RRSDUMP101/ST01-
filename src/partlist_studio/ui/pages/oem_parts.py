"""แท็บ อะไหล่ Ford OEM: นำเข้าหน้าเว็บแผนภาพอะไหล่ที่บันทึกจาก Chrome (หรือไฟล์ JSON) → ดูตามแผนภาพ ค้นหา
→ เพิ่มเข้า Part List / ส่งออก Excel."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QComboBox, QFileDialog, QHBoxLayout, QInputDialog, QLabel, QLineEdit, QListWidget,
                               QListWidgetItem, QMessageBox, QSpinBox, QSplitter, QVBoxLayout, QWidget)

from ...core import oem_parts as oem
from ..state import AppState
from ..widgets import button, empty_hint, fill, selected_rows, table

HEADERS = ["แผนภาพ", "ตำแหน่ง", "Part Number", "รายละเอียด", "หมายเหตุ / รุ่นที่ใช้", "จำนวน", "MSRP", "ราคา", "ผู้ขาย"]
PAGE_FILTER = "หน้าเว็บที่บันทึก / ข้อความ (*.html *.htm *.mhtml *.txt);;ทุกไฟล์ (*)"
LAST_DIAGRAM = 29  # Headlamp Components of the 2026 F-350: diagrams 1 – 29
IMAGE_FILTER = "รูปภาพ (*.png *.jpg *.jpeg *.gif *.webp *.bmp)"
DEFAULT_VEHICLE = "2026 Ford F-350 Super Duty XL 7.3L V8 Gas"
DEFAULT_CATEGORY = "Headlamp Components"


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
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        self.diagrams = QListWidget()
        self.diagrams.currentRowChanged.connect(lambda _r: self.show_rows())
        self.diagrams.setMinimumHeight(120)
        ll.addWidget(self.diagrams, 1)
        self.picture = QLabel("เลือกแผนภาพเพื่อดูรูป")
        self.picture.setAlignment(Qt.AlignCenter)
        self.picture.setFixedHeight(290)
        self.picture.setStyleSheet("background:white; border:1px solid #DDE3EC;")
        ll.addWidget(self.picture)
        crow = QHBoxLayout()
        crow.addWidget(QLabel("หมายเลขในรูป"))
        self.callouts = QLineEdit()
        self.callouts.setPlaceholderText("เช่น 1-12")
        self.callouts.setToolTip("หมายเลขตำแหน่งที่พิมพ์อยู่ในรูปแผนภาพ – ใช้ตรวจว่าทุกหมายเลขมีอะไหล่ครบ")
        self.callouts.editingFinished.connect(self.set_callouts)
        crow.addWidget(self.callouts, 1)
        ll.addLayout(crow)
        self.callout_check = QLabel()
        self.callout_check.setWordWrap(True)
        ll.addWidget(self.callout_check)
        attach = button("แนบรูปแผนภาพ…", tooltip="เก็บรูปแผนภาพ (บันทึกรูปจากเว็บ หรือภาพหน้าจอ) ไว้กับแผนภาพที่เลือก")
        attach.clicked.connect(lambda: self.attach_image())
        ll.addWidget(attach)
        ll.addStretch(1)
        split.addWidget(left)
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
        split.setSizes([380, 820])
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
                self.diagrams.addItem(QListWidgetItem(self._item_text(a)))
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
        self.show_diagram()
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
        if old:  # pages saved in several rounds: the diagrams already imported stay, with their pictures
            have = {a.number for a in cat.assemblies}
            for a in cat.assemblies:
                if (prev := old.assembly(a.number)) is not None:
                    a.image_file, a.callouts = prev.image_file, prev.callouts or a.callouts
            cat.assemblies = sorted(cat.assemblies + [a for a in old.assemblies if a.number not in have],
                                    key=lambda a: a.number)
        self.library.save(cat)
        pictures = 0
        for path, page in zip(paths, pages):  # 'Webpage, Complete': the picture of the diagram is in its _files folder
            asm, _veh = oem.parse_page(page)
            img = oem.local_image(path, oem.diagram_image_src(page, asm.number)) if asm else None
            if img:
                self.library.attach_image(cat, asm.number, img)
                pictures += 1
        self.reload(cat.key)
        no_pn = sum(1 for _a, p in cat.rows() if not p.part_number)
        self.state.notify(f"นำเข้า {len(paths)} หน้า: {len(cat.assemblies)} แผนภาพ {cat.part_count} รายการ"
                          + (f" · รูปแผนภาพ {pictures}" if pictures else "")
                          + (f" · ไม่มี Part Number {no_pn} รายการ" if no_pn else ""))
        return cat

    # ---- the picture of a diagram ------------------------------------------
    def current_assembly(self) -> oem.Assembly | None:
        cat, r = self.catalog, self.diagrams.currentRow()
        return cat.assemblies[r - 1] if cat and 0 < r <= len(cat.assemblies) else None

    def show_diagram(self) -> None:
        asm = self.current_assembly()
        self.callouts.blockSignals(True)
        self.callouts.setText(asm.callouts if asm else "")
        self.callouts.setEnabled(asm is not None)
        self.callouts.blockSignals(False)
        img = self.library.image_path(asm) if asm else None
        pix = QPixmap(str(img)) if img else QPixmap()
        if not pix.isNull():
            self.picture.setPixmap(pix.scaled(max(360, self.picture.width() - 8), 280, Qt.KeepAspectRatio,
                                              Qt.SmoothTransformation))
        else:
            self.picture.setPixmap(QPixmap())
            self.picture.setText("ยังไม่มีรูป – กด แนบรูปแผนภาพ…" if asm else "เลือกแผนภาพเพื่อดูรูป")
        if asm and asm.callout_numbers():
            missing = asm.missing_callouts()
            self.callout_check.setText(f"⚠ หมายเลขในรูปที่ยังไม่มีอะไหล่: {', '.join(missing)}" if missing else
                                       f"✔ ครบทุกหมายเลข ({len(asm.callout_numbers())})")
            self.callout_check.setStyleSheet("color:#D64545;" if missing else "color:#2E9D5B;")
        else:
            self.callout_check.setText("")

    @staticmethod
    def _item_text(a: oem.Assembly) -> str:
        marks = ("  🖼" if a.image_file else "") + ("  ⚠" if a.missing_callouts() else "")
        return f"{a.number}. {a.title or 'แผนภาพ'}  ({len(a.parts)}){marks}"

    def set_callouts(self) -> None:
        cat, asm, r = self.catalog, self.current_assembly(), self.diagrams.currentRow()
        if cat and asm and asm.callouts != self.callouts.text().strip():
            asm.callouts = self.callouts.text().strip()
            self.library.save(cat)
            self.diagrams.item(r).setText(self._item_text(asm))
            self.show_diagram()

    def attach_image(self, path: str = "", number: int | None = None, title: str = "") -> oem.Assembly | None:
        """The picture of a diagram (saved from the site or a screenshot). With no diagram chosen, its number is asked;
        a diagram not imported yet is made, so the pictures can come before the pages."""
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "เลือกรูปแผนภาพ", "", IMAGE_FILTER)
        if not path:
            return None
        cat = self.catalog
        if cat is None:
            vehicle, ok = QInputDialog.getText(self, "แคตตาล็อกใหม่", "รุ่นรถ", text=DEFAULT_VEHICLE)
            if not ok:
                return None
            category, ok = QInputDialog.getText(self, "แคตตาล็อกใหม่", "หมวด", text=DEFAULT_CATEGORY)
            if not ok:
                return None
            cat = oem.OemCatalog(vehicle.strip(), category.strip(), "ford.oempartsonline.com")
        asm = self.current_assembly() if number is None else None
        if asm is None and number is None:
            free = oem.missing_numbers(cat, LAST_DIAGRAM)
            number, ok = QInputDialog.getInt(self, "แนบรูปแผนภาพ", "เลขแผนภาพ (Diagram N)", free[0] if free else 1, 1, 999)
            if not ok:
                return None
            if cat.assembly(number) is None and not title:
                title, _ok = QInputDialog.getText(self, "แนบรูปแผนภาพ", "ชื่อแผนภาพ เช่น Headlamp Assembly")
        n = asm.number if asm else number
        asm = self.library.attach_image(cat, n, path, title.strip())
        self.reload(cat.key)
        self.diagrams.setCurrentRow(1 + next(i for i, a in enumerate(self.catalog.assemblies) if a.number == n))
        self.state.notify(f"แนบรูปแผนภาพ {n} แล้ว")
        return asm

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
