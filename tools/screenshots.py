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

    import tempfile

    from partlist_studio.ui.state import AppState

    data_dir = tempfile.mkdtemp(prefix="pls_shots_")
    w = MainWindow(AppState(data_dir=data_dir))
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
        state.partlist.drawings.append(dwg_io.drawing_record(data, len(parts), parts))
        state.drawing_cache[data.path] = data
    for p in state.partlist.parts:
        if p.part_no == "RRS-TB-002":  # mirror part of RRS-TB-001, weight typed in by planning
            p.weight, p.process, p.remark = 1.097, "ตัด/พับ", "กลับด้านจาก RRS-TB-001"
    info.drawing_no, info.revision = "RRS-AS-100", "B"
    state.partlist.renumber()
    from partlist_studio.core.company_files import read_company_workbook
    from partlist_studio.core.express import read_express_file

    book = read_company_workbook(samples / "company_parts_list_all_model_sample.xlsx", state.image_dir() / "sample")
    state.set_models(book.models)
    state.add_stock_source("store_stock.csv", StockList.from_file(samples / "store_stock.csv"))
    for sheet, stock in book.stocks.items():
        state.add_stock_source(f"Parts List All Model / {sheet}", stock)
    w.pages["stock"].read_stock_file(str(samples / "company_stock_count_sample.xlsx"))
    express, _ = read_express_file(samples / "express_item_list.csv")
    state.add_stock_source("Express: express_item_list.csv", express)
    state.xref.merge(w.pages["express"]._suggestions())
    state.set_xref(state.xref)
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
    w.go("models")
    shot(w, "9_models.png")
    w.go("express")
    w.pages["express"].check_codes()
    shot(w, "10_express.png")
    w.pages["express"].tabs.setCurrentIndex(1)
    shot(w, "10b_express_xref.png")

    dialog = DrawingImportDialog(drawings, dwg_io.DEFAULT_DENSITIES, w)
    dialog.show()
    dialog.files.setCurrentRow(1)
    shot(dialog, "7_dwg_import_dialog.png")
    dialog.files.setCurrentRow(0)
    shot(dialog, "7b_dwg_import_bom.png")
    dialog.close()
    labelled = dwg_io.read_drawing(samples / "RRS-T-SET_frame_parts.dxf")
    dialog = DrawingImportDialog([labelled], dwg_io.DEFAULT_DENSITIES, w, default_thickness=2.0)
    dialog.show()
    dialog.table.item(1, dialog._col("thickness")).setText("4.5")  # one row set by hand
    dialog.table.selectRow(1)
    shot(dialog, "7c_dwg_code_name_thickness.png")
    dialog.close()

    mapping = ColumnMappingDialog(prepare_import(samples / "zwcad_tableexport_bom.csv"), "zwcad_tableexport_bom.csv", w)
    mapping.show()
    shot(mapping, "8_column_mapping.png")
    mapping.close()

    # ---- work flow: variant, production job, documents, nesting, Min/Max, code rules, Rev. compare
    from partlist_studio.core import production
    from partlist_studio.core.company_files import ModelBOM, ModelRow
    from partlist_studio.ui.work_dialogs import CompareDialog, NewCodeDialog, VariantDialog

    detail, _ = read_express_file(samples / "express_item_detail_STMASR0200.txt")
    for k, item in enumerate(detail.items):
        item.on_hand = (k * 5) % 9
    state.add_stock_source("Express: STMASR0200.txt", detail)
    model = ModelBOM("กระบะคอกสูง3ราว", "รายการชิ้นส่วนประกอบกระบะ Toyota (คอกสูง 3 ราว)", [
        ModelRow("1", "RRS-T-023", ["RRS-T-023"], "เสาหลัง 80", "", "1+1", 2),
        ModelRow("2", "RRS-T-024", ["RRS-T-024"], "บังอาย", "", "1+1", 2),
        ModelRow("3", "RRS-019", ["RRS-019"], "ฝาข้าง", "", "2", 2),
        ModelRow("4", "RRS-A-033", ["RRS-A-033"], "ตะขอเกี่ยวฝาท้าย", "", "6", 6),
        ModelRow("5", "RRS-A-127", ["RRS-A-127"], "ปะกับ", "", "2", 2)])
    state.set_models([model] + state.models)
    variant = VariantDialog(state, model, for_job=True, parent=w)
    variant.brand.setCurrentText("Toyota Champ")
    variant.height.setCurrentIndex(1)
    variant.job_no.setText("SO6910-015")
    variant.resize(1240, 520)
    variant.show()
    shot(variant, "11_variant_dialog.png")
    job = production.job_from_parts("SO6910-015", variant.parts(), 3, state.stock, model=model.name, title=model.title,
                                    customer="บจก. ขนส่งตัวอย่าง", variant=variant.variant_text, due="2026-10-30")
    variant.close()
    job.record(job.parts[0], "ตัด", 3)
    job.record(job.parts[0], "พับ", 2)
    job.record(job.parts[1], production.DONE, 0)
    job.record(job.parts[2], "ตัด", 1)
    state.jobs = [job]
    state.save_jobs()
    w.go("production")
    shot(w, "12_production.png")
    w.pages["production"].make_documents()
    shot(w, "13_movements.png")
    w.go("nesting")
    w.pages["nesting"].source.setCurrentIndex(w.pages["nesting"].source.findData("partlist"))
    w.pages["nesting"].tabs.setCurrentIndex(0)
    w.pages["nesting"].run()
    shot(w, "14_nesting.png")
    # ---- laser: flat patterns from the frame-set drawing, a job that needs them, programs, queue, library
    from partlist_studio.core import laser as laser_mod

    frame = dwg_io.read_drawing(samples / "RRS-T-SET_frame_parts.dxf")
    frame_parts = [c.part for c in dwg_io.drawing_to_candidates(frame)]
    state.flats.add_parts(frame_parts, "RRS-T-SET", "A", "RRS-T-SET_frame_parts.dxf")
    state.save_laser()
    laser_job = production.job_from_parts("SO6910-016", frame_parts, 2, None, False, model="ชุดเฟรมกระบะ",
                                          title="ชุดเฟรมกระบะ (แบบ RRS-T-SET)", customer="บจก. ขนส่งตัวอย่าง",
                                          due="2026-10-28")
    state.jobs = [job, laser_job]
    state.save_jobs()
    cut_page = w.pages["nesting"]
    cut_page.source.setCurrentIndex(cut_page.source.findData("jobs"))
    cut_page.tabs.setCurrentIndex(0)
    cut_page.run()
    cut_page.table.selectRow(2)
    shot(w, "14b_laser_plan_jobs.png")
    cut_page.tabs.setCurrentIndex(1)
    shot(w, "14c_laser_checks.png")
    cut_page.make_programs()
    progs = state.cut_queue.open_programs()
    laser_mod.apply_cut(progs[0], progs[0].repeat, state.jobs, state.ledger, "ช่างเลเซอร์")
    progs[1].status = laser_mod.ST_CUTTING
    state.save_laser()
    cut_page.show_done.setChecked(True)
    t3 = next(p for p in state.cut_queue.programs if p.thickness == 3)
    cut_page.programs.selectRow(cut_page._programs.index(t3))
    shot(w, "14d_laser_queue.png")
    cut_page.tabs.setCurrentIndex(3)
    cut_page.flats.selectRow(0)
    shot(w, "14e_flat_library.png")
    w.go("stock")
    w.pages["stock"].tabs.setCurrentIndex(2)
    w.pages["stock"].replenish.run()
    shot(w, "15_minmax.png")
    w.go("express")
    w.pages["express"].audit_codes()
    shot(w, "16_code_audit.png")
    code = NewCodeDialog(state, "บังอาย T90(ซ้าย)", w)
    code.brand.setCurrentIndex(2)
    code.show()
    shot(code, "16b_new_code.png")
    code.close()
    old_path = Path(data_dir) / "rev_A.rrspl"
    state.partlist.save(old_path)
    state.partlist.parts[0].qty += 1
    state.partlist.parts[1].material = "SUS304"
    compare = CompareDialog(state, w.actions, w)
    compare.sources[0][1].setText(str(old_path))
    compare.run()
    compare.resize(1100, 420)
    compare.show()
    shot(compare, "17_compare_rev.png")
    compare.close()
    state.dirty = False
    w.state.settings.q.clear()
    return 0


if __name__ == "__main__":
    sys.exit(main())
