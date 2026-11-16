"""แท็บ ไฟล์ ZW3D: เปิดไฟล์ .Z3 / .Z3PRT / .Z3ASM โดยไม่ต้องมี ZW3D → โครงสร้างชุดประกอบ ใบรายการชิ้นส่วน ภาพตัวอย่าง
→ ส่งออก CSV / เพิ่มเข้า Part List."""

from __future__ import annotations

import csv
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QComboBox, QFileDialog, QHBoxLayout, QLabel, QSplitter, QTreeWidget, QTreeWidgetItem,
                               QVBoxLayout, QWidget)

from ...core import z3_reader as z3
from ...core.models import Part
from ..state import AppState
from ..widgets import button, empty_hint, fill, run_async, selected_rows, table

Z3_FILTER = "ไฟล์ ZW3D (*.Z3 *.Z3PRT *.Z3ASM *.z3 *.z3prt *.z3asm);;ทุกไฟล์ (*)"
BOM_HEADERS = ["#", "ชื่อชิ้นส่วน", "จำนวนรวม", "อยู่ในไฟล์", "หมายเหตุ"]
CSV_HEAD = ["ลำดับ", "ชื่อชิ้นส่วน", "จำนวนรวม", "อยู่ในไฟล์", "หมายเหตุ"]
NODE_TH = {"part": "ชิ้นส่วน", "assembly": "ชุดประกอบ", "missing_file": "ไม่พบไฟล์", "missing_object": "ไม่พบวัตถุ",
           "bad_file": "ไฟล์อ่านไม่ได้", "external": "ไฟล์อื่น", "cycle": "อ้างวนกลับ"}
PROCESS = "ตามแบบ ZW3D"


def read_file(path: str) -> tuple[z3.Z3File, z3.Bom | None, str]:
    """The file and its parts list (None with the reason when the file holds no 3D object or its tree cannot be built)."""
    f = z3.read_z3(path)
    if not any(o.kind in ("part", "assembly") for o in f.objects):
        return f, None, "ไฟล์นี้มีแต่แบบ 2 มิติ – ไม่มีใบรายการชิ้นส่วน"
    try:
        return f, z3.bom(f), ""
    except z3.Z3Error as e:
        return f, None, str(e)


class Z3Tab(QWidget):
    def __init__(self, state: AppState, parent=None):
        super().__init__(parent)
        self.state = state
        self.file: z3.Z3File | None = None
        self.bom: z3.Bom | None = None
        self.lines: list[z3.BomLine] = []
        lay = QVBoxLayout(self)
        row = QHBoxLayout()
        open_btn = button("เปิดไฟล์ ZW3D (.Z3)…", "accent", "อ่านรายชื่อชิ้นส่วนและโครงสร้างชุดประกอบจากไฟล์ ZW3D โดยไม่ต้องเปิด ZW3D")
        open_btn.clicked.connect(lambda: self.open_file())
        row.addWidget(open_btn)
        self.title = QLabel("ยังไม่ได้เปิดไฟล์")
        self.title.setObjectName("CardTitle")
        row.addWidget(self.title, 1)
        lay.addLayout(row)
        info = QHBoxLayout()
        self.preview = QLabel()
        self.preview.setFixedSize(156, 156)
        self.preview.setAlignment(Qt.AlignCenter)
        self.preview.setStyleSheet("background:white; border:1px solid #DDE3EC;")
        info.addWidget(self.preview)
        self.summary = QLabel("อ่านได้: รายการวัตถุ (ชิ้นส่วน / ชุดประกอบ / แบบ 2 มิติ) ชื่อภาษาไทย โครงสร้างชุดประกอบพร้อมจำนวน "
                              "ภาพตัวอย่าง ชื่อเลเยอร์ · อ่านไม่ได้: รูปทรง 3 มิติ (ใช้ STEP / IGES ในแท็บ ประกอบ 3D) และชิ้นที่ถูกซ่อนใน ZW3D")
        self.summary.setWordWrap(True)
        self.summary.setTextFormat(Qt.RichText)
        self.summary.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        info.addWidget(self.summary, 1)
        lay.addLayout(info)

        split = QSplitter(Qt.Horizontal)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["โครงสร้างชุดประกอบ", "ชนิด", "ในชุดแม่", "รวม", "ไฟล์ / หมายเหตุ"])
        for col, width in enumerate((300, 80, 60, 50)):
            self.tree.setColumnWidth(col, width)
        split.addWidget(self.tree)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        row.addWidget(QLabel("ใบรายการ"))
        self.scope = QComboBox()
        self.scope.addItem("เฉพาะชิ้นของไฟล์นี้ (ตัวถังเอง)", "own")
        self.scope.addItem("รวมชิ้นจากไฟล์ที่อ้างถึง (แชสซี ไฟท้าย สลัก ฯลฯ)", "all")
        self.scope.currentIndexChanged.connect(lambda _i: self.show_lines())
        row.addWidget(self.scope, 1)
        rl.addLayout(row)
        self.table = table(BOM_HEADERS, [40, 260, 80, 200, 200])
        empty_hint(self.table, lambda: "เปิดไฟล์ ZW3D เพื่อดูใบรายการชิ้นส่วน" if self.file is None else "ไม่มีรายการ")
        rl.addWidget(self.table, 1)
        split.addWidget(right)
        split.setSizes([520, 620])
        lay.addWidget(split, 1)
        row = QHBoxLayout()
        self.count = QLabel()
        row.addWidget(self.count, 1)
        for text, slot, kind, tip in (
                ("ส่งออก CSV…", lambda: self.export_csv(), "", "ใบรายการที่แสดงเป็นไฟล์ CSV (เปิดด้วย Excel ได้)"),
                ("เพิ่มเข้า Part List", lambda: self.add_to_partlist(), "primary",
                 "รายการที่เลือก (ไม่เลือก = ทั้งหมดที่แสดง) เข้า Part List ของโปรแกรม")):
            b = button(text, kind, tip) if kind else button(text, tooltip=tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)

    # ---- open -------------------------------------------------------------
    def open_file(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "เลือกไฟล์ ZW3D", "", Z3_FILTER)
        if not path:
            return
        self.title.setText(f"กำลังอ่าน {Path(path).name} …")  # the 2.7 GB chassis file takes half a minute
        run_async(read_file, self._loaded, self._failed, path)

    def load(self, path: str) -> bool:
        """The same without the worker thread (tests, small files)."""
        try:
            self._loaded(read_file(path))
        except (z3.Z3Error, OSError) as e:
            self._failed(e)
            return False
        return True

    def _failed(self, error) -> None:
        self.file, self.bom, self.lines = None, None, []
        self.title.setText("อ่านไฟล์ไม่ได้")
        self.summary.setText(f"<span style='color:#D64545'><b>{error}</b></span>")
        self.preview.setPixmap(QPixmap())
        self.tree.clear()
        self.show_lines()

    def _loaded(self, result: tuple[z3.Z3File, z3.Bom | None, str]) -> None:
        self.file, self.bom, why = result
        f, b = self.file, self.bom
        self.title.setText(f.path.name)
        h = f.header
        saved = h.saved.strftime("%d/%m/%Y %H:%M") if h.saved else h.saved_text
        parts = [f"ผู้บันทึก <b>{h.author or '-'}</b> · บันทึกเมื่อ {saved} · ZW3D {h.zw3d_build} (รูปแบบ {h.format_version}) · "
                 f"ตรวจไฟล์ผ่าน {sum(c.ok for c in f.checks)} / {len(f.checks)} ข้อ",
                 f"วัตถุ <b>{len(f.objects)}</b>: ชิ้นส่วน {f.count('part')} · ชุดประกอบ {f.count('assembly')} · "
                 f"แบบ 2 มิติ {f.count('drawing')}"]
        if b and b.root:
            own = b.own()
            parts.append(f"ชุดประกอบบนสุด <b>{b.root.name}</b> · ลึก {b.depth} ชั้น · ใบรายการ {len(b.flat)} รายการ "
                         f"{b.total_parts} ชิ้น – ของไฟล์นี้เอง {len(own)} รายการ {sum(x.qty for x in own)} ชิ้น")
            if b.unused:
                parts.append(f"วัตถุ 3 มิติที่ไม่มีชุดประกอบใดใช้ {len(b.unused)} ตัว")
            if b.missing_files:
                parts.append("<span style='color:#E08A1E'>ไม่พบไฟล์ที่อ้างถึง: " + ", ".join(b.missing_files[:6])
                             + (" …" if len(b.missing_files) > 6 else "") + "</span>")
        elif why:
            parts.append(f"<span style='color:#E08A1E'>{why}</span>")
        warnings = [*f.warnings, *(b.warnings if b else [])]
        if warnings:
            parts.append("<span style='color:#E08A1E'>⚠ " + " · ".join(warnings[:4]) + (" …" if len(warnings) > 4 else "")
                         + "</span>")
        parts.append("<span style='color:#6B7A90'>ชิ้นที่ถูกซ่อนหรือปิดใช้งานใน ZW3D แยกไม่ได้ – นับรวมอยู่ในใบรายการ</span>")
        self.summary.setText("<br>".join(parts))
        pix = QPixmap()
        if f.preview_png:
            pix.loadFromData(f.preview_png)
        self.preview.setPixmap(pix.scaled(150, 150, Qt.KeepAspectRatio, Qt.SmoothTransformation) if not pix.isNull() else pix)
        self._fill_tree()
        self.scope.setCurrentIndex(0 if (b and b.own()) else 1)
        self.show_lines()
        self.state.notify(f"เปิด {f.path.name}: {len(f.objects)} วัตถุ" + (f" · ใบรายการ {len(b.flat)} รายการ" if b else ""))

    def _fill_tree(self) -> None:
        self.tree.clear()
        root = self.bom.root if self.bom else None
        if root is None:
            return

        def add(node: z3.BomNode, parent) -> None:
            item = QTreeWidgetItem(parent, [node.name, NODE_TH.get(node.kind, node.kind), str(node.qty), str(node.total),
                                            " · ".join(x for x in (node.file, node.note) if x)])
            for child in node.children:
                add(child, item)

        add(root, self.tree)
        self.tree.expandToDepth(0)

    def show_lines(self) -> None:
        b = self.bom
        self.lines = [] if b is None else (b.own() if self.scope.currentData() == "own" else list(b.flat))
        fill(self.table, [[n, x.name, x.qty, x.file, x.note] for n, x in enumerate(self.lines, 1)])
        self.count.setText(f"{len(self.lines)} รายการ {sum(x.qty for x in self.lines)} ชิ้น" if self.lines else "")

    # ---- out --------------------------------------------------------------
    def chosen(self) -> list[z3.BomLine]:
        picked = selected_rows(self.table)
        return [self.lines[r] for r in picked] if picked else list(self.lines)

    def export_csv(self, path: str = "") -> str:
        if not self.file or not self.lines:
            return ""
        if not path:
            path, _ = QFileDialog.getSaveFileName(self, "ส่งออกใบรายการ", f"{self.file.path.stem}_BOM.csv", "CSV (*.csv)")
        if path:
            with open(path, "w", newline="", encoding="utf-8-sig") as out:  # the BOM mark: Excel reads the Thai right
                w = csv.writer(out)
                w.writerow(CSV_HEAD)
                w.writerows([n, x.name, x.qty, x.file, x.note] for n, x in enumerate(self.lines, 1))
            self.state.notify(f"บันทึก {Path(path).name} แล้ว ({len(self.lines)} รายการ)")
        return path

    def add_to_partlist(self) -> int:
        lines = self.chosen()
        if not self.file or not lines:
            return 0
        pl = self.state.partlist
        start = len(pl.parts)
        for n, x in enumerate(lines, start=start + 1):
            remark = " · ".join(t for t in (f"จาก ZW3D: {x.file or self.file.path.name}", x.note) if t)
            pl.parts.append(Part(item_no=str(n), name=x.name, drawing_no=self.file.path.stem, qty=float(x.qty), unit="ชิ้น",
                                 process=PROCESS, status="รอตรวจ", remark=remark))
        self.state.mark_dirty()
        self.state.notify(f"เพิ่ม {len(lines)} รายการจาก {self.file.path.name} เข้า Part List แล้ว")
        return len(lines)
