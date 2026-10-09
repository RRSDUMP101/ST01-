"""Render screenshots of every page with the sample data (used for docs/screenshots).

    QT_QPA_PLATFORM=offscreen python tools/screenshots.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from PySide6.QtWidgets import QApplication  # noqa: E402


def main() -> int:
    app = QApplication(sys.argv)
    app.setOrganizationName("RRS-screenshots")
    app.setApplicationName("PartListStudio-screenshots")
    from partlist_studio.core import dwg_io
    from partlist_studio.core.stock import StockList, check_requirements
    from partlist_studio.ui import theme
    from partlist_studio.ui.dialogs import ColumnMappingDialog, DrawingImportDialog
    from partlist_studio.core.partlist_io import prepare_import
    from partlist_studio.ui.main_window import MainWindow

    app.setStyle("Fusion")
    app.setFont(theme.app_font())
    app.setStyleSheet(theme.STYLE_SHEET)
    app.primaryScreen()

    out = ROOT / "docs" / "screenshots"
    out.mkdir(parents=True, exist_ok=True)
    samples = ROOT / "samples"

    w = MainWindow()
    w.state.settings.q.clear()
    state = w.state
    info = state.partlist.info
    info.so_no, info.customer, info.vehicle_model = "SO6910-015", "บจก. ขนส่งตัวอย่าง", "ISUZU FRR 6 ล้อ"
    info.job_type, info.prepared_by, info.build_qty = "ตู้แห้ง + ประตูท้าย", "แอม (วางแผนการผลิต)", 3

    drawings = [dwg_io.read_drawing(samples / n) for n in
                ("RRS-AS-100_tailgate_assembly.dxf", "RRS-TB-001_side_panel.dxf")]
    for data in drawings:
        cands = dwg_io.drawing_to_candidates(data)
        parts = [c.part for c in cands if c.selected]
        if data.bom:
            parts = [p for p in parts if p.part_no != "RRS-TB-001"]  # detailed from its own drawing below
        state.partlist.parts.extend(parts)
        state.partlist.drawings.append(dwg_io.drawing_record(data, len(parts)))
        state.drawing_cache[data.path] = data
    for p in state.partlist.parts:
        if p.part_no == "RRS-TB-002":  # mirror part of RRS-TB-001, weight typed in by planning
            p.weight, p.process, p.remark = 1.097, "ตัด/พับ", "กลับด้านจาก RRS-TB-001"
    info.drawing_no, info.revision = "RRS-AS-100", "B"
    state.partlist.renumber()
    state.stock = StockList.from_file(samples / "store_stock.csv")
    state.stock.source = "store_stock.csv (ส่งออกจาก Express)"
    state.stock_changed.emit()
    state.requirements = check_requirements(state.partlist, state.stock)
    state.mark_dirty()
    state.requirements_changed.emit()

    w.resize(1440, 860)
    w.show()

    def shot(widget, name):
        for _ in range(5):
            app.processEvents()
        widget.grab().save(str(out / name))
        print("saved", name)

    for i, (key, _label) in enumerate([("dashboard", ""), ("drawings", ""), ("parts", ""), ("stock", ""),
                                       ("sheets", ""), ("settings", "")]):
        w.go(key)
        if key == "drawings":
            w.pages["drawings"].table.selectRow(1)
        if key == "stock":
            w.pages["stock"].tabs.setCurrentIndex(1)
        shot(w, f"{i + 1}_{key}.png")
    w.pages["stock"].tabs.setCurrentIndex(0)
    shot(w, "4b_stock_master.png")

    dialog = DrawingImportDialog(drawings, dwg_io.DEFAULT_DENSITIES, w)
    dialog.show()
    dialog.files.setCurrentRow(1)
    shot(dialog, "7_dwg_import_dialog.png")
    dialog.files.setCurrentRow(0)
    shot(dialog, "7b_dwg_import_bom.png")
    dialog.close()

    mapping = ColumnMappingDialog(prepare_import(samples / "zwcad_tableexport_bom.csv"), "zwcad_tableexport_bom.csv", w)
    mapping.show()
    shot(mapping, "8_column_mapping.png")
    mapping.close()
    state.dirty = False
    w.state.settings.q.clear()
    return 0


if __name__ == "__main__":
    sys.exit(main())
