"""GUI smoke tests (run headless with QT_QPA_PLATFORM=offscreen)."""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
QtWidgets = pytest.importorskip("PySide6.QtWidgets")

from conftest import SAMPLES  # noqa: E402


@pytest.fixture(scope="module")
def app():
    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    application.setOrganizationName("RRS-tests")
    application.setApplicationName("PartListStudio-tests")
    yield application


@pytest.fixture
def window(app, tmp_path):
    from PySide6.QtCore import QSettings

    from partlist_studio.ui import theme
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    QSettings().clear()
    app.setStyleSheet(theme.STYLE_SHEET)
    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    w.show()
    yield w
    w.state.dirty = False
    w.close()
    QSettings().clear()


def test_all_pages_open(window, app):
    from partlist_studio.ui.main_window import NAV

    for key, _label in NAV:
        window.go(key)
        app.processEvents()
        assert window.stack.currentWidget() is window.pages[key] and window.current_page() == key
    headers = [window.nav.item(r) for r in range(window.nav.count()) if not window.nav.item(r).data(0x0100)]
    assert headers and all(not (h.flags() & h.flags().ItemIsSelectable) for h in headers)  # group titles


def test_work_path_and_next_step(window, app, monkeypatch):
    from partlist_studio.core import dwg_io, production
    from partlist_studio.ui import workflow

    state = window.state
    assert workflow.next_action(state).action == "import_drawings"  # nothing yet: start with a drawing
    data = dwg_io.read_drawing(SAMPLES / "RRS-T-SET_frame_parts.dxf")
    parts = [c.part for c in dwg_io.drawing_to_candidates(data)]
    state.partlist.parts = parts
    state.flats.add_parts(parts)
    state.mark_dirty()
    nxt = workflow.next_action(state)
    assert (nxt.key, nxt.action) == ("production", "new_job")  # a Part List without a job: open the job
    state.jobs.append(production.job_from_parts("SO-W1", parts, 1, None, False))
    state.save_jobs()
    nxt = workflow.next_action(state)
    assert nxt.key == "nesting" and nxt.tab == 0 and str(workflow.pieces_to_plan(state)) in nxt.text
    steps = {s.key: s for s in workflow.workflow_steps(state)}
    assert [s.num for s in steps.values()] == [1, 2, 3, 4, 5, 6] and steps["nesting"].waiting
    window.go("parts")
    app.processEvents()
    window.refresh_steps()
    assert window.steps.isVisible() and window.steps.buttons["parts"].property("step") == "current"
    assert window.steps.buttons["nesting"].property("step") == "wait" and "วางแผนตัด" in window.steps.next_btn.text()
    window.run_next()  # opens the laser plan
    assert window.current_page() == "nesting" and window.pages["nesting"].tabs.currentIndex() == 0
    window.go("dashboard")
    app.processEvents()
    assert not window.steps.isVisible() and "วางแผนตัด" in window.pages["dashboard"].next_btn.text()


def test_partlist_flow(window, app):
    from partlist_studio.core import dwg_io
    from partlist_studio.core.stock import StockList

    state = window.state
    data = dwg_io.read_drawing(SAMPLES / "RRS-AS-100_tailgate_assembly.dxf")
    state.partlist.parts.extend(c.part for c in dwg_io.drawing_to_candidates(data))
    state.partlist.drawings.append(dwg_io.drawing_record(data, 5))
    state.mark_dirty()
    page = window.pages["parts"]
    assert page.model.rowCount() == 5
    assert "*" in window.windowTitle()

    page.search.setText("บานพับ")
    assert page.proxy.rowCount() == 1
    page.search.clear()

    from partlist_studio.core.models import COLUMN_KEYS

    idx = page.model.index(0, COLUMN_KEYS.index("qty"))
    assert page.model.setData(idx, "7")
    assert state.partlist.parts[0].qty == 7

    window.pages["stock"].set_stock(StockList.from_file(SAMPLES / "store_stock.csv"))
    window.pages["stock"].run_check()
    assert window.pages["stock"].req_model.rowCount() > 0
    window.pages["stock"].apply_status()
    assert any(p.status == "ขาด" for p in state.partlist.parts)
    assert window.pages["drawings"].table.rowCount() == 1


def test_drawing_dialog_selection(app):
    from partlist_studio.core import dwg_io
    from partlist_studio.ui.dialogs import DrawingImportDialog

    drawings = [dwg_io.read_drawing(SAMPLES / "RRS-TB-001_side_panel.dxf"),
                dwg_io.read_drawing(SAMPLES / "RRS-AS-100_tailgate_assembly.dxf")]
    dialog = DrawingImportDialog(drawings, dwg_io.DEFAULT_DENSITIES)
    dialog.files.setCurrentRow(1)
    dialog.table.item(0, 0).setCheckState(dialog.table.item(0, 0).checkState().__class__.Unchecked)
    dialog.files.setCurrentRow(0)
    dialog.accept()
    selected = dict((d.file_name, parts) for d, parts in dialog.selected_parts())
    assert len(selected["RRS-TB-001_side_panel.dxf"]) == 1
    assert len(selected["RRS-AS-100_tailgate_assembly.dxf"]) == 4  # 5 BOM rows, first unticked


def test_drawing_dialog_thickness(app):
    from partlist_studio.core import dwg_io
    from partlist_studio.ui.dialogs import DrawingImportDialog

    data = dwg_io.read_drawing(SAMPLES / "RRS-T-SET_frame_parts.dxf")
    dialog = DrawingImportDialog([data], dwg_io.DEFAULT_DENSITIES)
    cands = dialog.candidates[0]
    col = dialog._col("thickness")
    assert [c.part.part_no for c in cands] == [f"RRS-T-00{i}" for i in range(1, 6)]
    assert dialog.table.item(0, dialog._col("name")).text() == "เฟรมบน"
    assert dialog.table.item(0, col).text() == "3"
    qcol, qsrc = dialog._col("qty"), dialog._col("_qty_source")
    assert dialog.table.item(0, qcol).text() == "16"
    assert dialog.table.item(0, qsrc).text() == dwg_io.QTY_FROM_PART
    assert dialog.table.item(3, qsrc).text() == dwg_io.QTY_DEFAULT
    dialog.table.item(3, qcol).setText("6")  # typed in the table
    assert cands[3].part.qty == 6 and cands[3].qty_source == dwg_io.QTY_MANUAL
    assert dialog.table.item(3, qsrc).text() == dwg_io.QTY_MANUAL
    w = cands[0].part.weight
    dialog.table.item(0, col).setText("6")  # typed in the table
    assert cands[0].part.thickness == 6 and cands[0].thickness_source == dwg_io.THK_MANUAL
    assert cands[0].part.weight == pytest.approx(w * 2, abs=2e-3)
    assert dialog.table.item(0, dialog._col("spec")).text() == "t6 x 150 x 60"
    # one value for every part; the row typed by hand keeps its value
    dialog.thk_value.setValue(2.5)
    dialog.thk_mode.setCurrentIndex(dialog.thk_mode.findData("fixed"))
    assert [c.part.thickness for c in cands] == [6, 2.5, 2.5, 2.5, 2.5]
    dialog.table.selectRow(1)
    dialog.thk_value.setValue(5)
    dialog._apply_selected()
    assert cands[1].part.thickness == 5
    dialog.table.clearSelection()
    dialog._reset_selected()  # nothing selected: the whole drawing back to what it says
    assert [c.part.thickness for c in cands] == [3, 3.2, 4, 2, 2.3]
    dialog.thk_mode.setCurrentIndex(dialog.thk_mode.findData("drawing"))
    dialog.accept()
    [(_d, parts)] = dialog.selected_parts()
    assert [p.thickness for p in parts] == [3, 3.2, 4, 2, 2.3]
    assert [p.qty for p in parts] == [16, 2, 4, 6, 1]
    assert dialog.thickness_mode == "drawing" and dialog.default_thickness == 5


def test_drawing_dialog_material(app):
    from partlist_studio.core import dwg_io
    from partlist_studio.ui.dialogs import DrawingImportDialog

    data = dwg_io.read_drawing(SAMPLES / "RRS-T-SET_frame_parts.dxf")
    dialog = DrawingImportDialog([data], dwg_io.DEFAULT_DENSITIES)
    cands = dialog.candidates[0]
    col, src = dialog._col("material"), dialog._col("_mat_source")
    assert [dialog.table.item(r, col).text() for r in range(5)] == ["Steel", "Stainless", "SS400", "SS400", "SS400"]
    assert [dialog.table.item(r, src).text() for r in range(3)] == [dwg_io.MAT_FROM_PART, dwg_io.MAT_FROM_PART,
                                                                    dwg_io.MAT_FROM_TITLE]
    assert dialog.table.itemDelegateForColumn(col) is dialog._mat_delegate
    w = cands[0].part.weight
    dialog.table.item(0, col).setText("Aluminium")  # picked in the table
    assert cands[0].part.material == "Aluminium" and cands[0].material_source == dwg_io.MAT_MANUAL
    assert cands[0].part.weight == pytest.approx(w * 2.70 / 7.85, rel=0.02)
    assert dialog.table.item(0, src).text() == dwg_io.MAT_MANUAL
    dialog.table.selectRow(3)
    dialog.mat_value.setCurrentText("SUS304")
    dialog._apply_material()  # the bar: the chosen rows only
    assert [c.part.material for c in cands] == ["Aluminium", "Stainless", "SS400", "SUS304", "SS400"]
    dialog.table.selectRow(0)
    dialog._reset_material()
    assert cands[0].part.material == "Steel" and cands[0].material_source == dwg_io.MAT_AS_DRAWN
    assert cands[0].part.weight == pytest.approx(w, rel=1e-3)
    dialog.accept()
    [(_d, parts)] = dialog.selected_parts()
    assert [p.material for p in parts] == ["Steel", "Stainless", "SS400", "SUS304", "SS400"]
    assert parts[1].drawing_material == "Stainless" and "M=Stainless" in parts[1].material_source


def test_partlist_material_edit_and_dialog(window, app):
    from PySide6.QtCore import Qt

    from partlist_studio.core import dwg_io
    from partlist_studio.core.models import COLUMN_KEYS
    from partlist_studio.ui.work_dialogs import MaterialDialog

    state = window.state
    data = dwg_io.read_drawing(SAMPLES / "RRS-T-SET_frame_parts.dxf")
    parts = [c.part for c in dwg_io.drawing_to_candidates(data)]
    state.partlist.parts.extend(parts)
    state.flats.add_parts(parts, "RRS-T-SET")
    state.mark_dirty()
    page = window.pages["parts"]
    index = page.model.index(1, COLUMN_KEYS.index("material"))
    assert "M=Stainless" in page.model.data(index, Qt.ToolTipRole)
    w = parts[1].weight
    assert page.model.setData(index, "Aluminium")  # chosen in the table later
    assert parts[1].material == "Aluminium" and parts[1].weight == pytest.approx(w * 2.70 / 7.93, rel=0.02)
    assert parts[1].material_source.startswith(dwg_io.MAT_MANUAL)
    assert state.flats.get("RRS-T-002").material == "Aluminium"  # the laser plan cuts it as aluminium
    dialog = MaterialDialog(state.partlist.parts, [2, 3], page)
    assert dialog.targets() == [2, 3]
    dialog.value.setCurrentText("Stainless")
    page.materials_changed(dialog.apply())
    assert [p.material for p in parts] == ["Steel", "Aluminium", "Stainless", "Stainless", "SS400"]
    assert state.flats.get("RRS-T-004").material == "Stainless"
    dialog.scope.button(1).setChecked(True)  # every row
    dialog.action.button(1).setChecked(True)  # back to the drawing (M= / Title Block)
    page.materials_changed(dialog.apply())
    dialog.deleteLater()
    assert [p.material for p in parts] == ["Steel", "Stainless", "SS400", "SS400", "SS400"]
    assert parts[1].weight == pytest.approx(w, rel=1e-3) and state.flats.get("RRS-T-002").material == "Stainless"


def test_partlist_thickness_edit_and_dialog(window, app):
    from partlist_studio.core import dwg_io
    from partlist_studio.core.models import COLUMN_KEYS
    from partlist_studio.ui.work_dialogs import ThicknessDialog

    state = window.state
    data = dwg_io.read_drawing(SAMPLES / "RRS-T-SET_frame_parts.dxf")
    parts = [c.part for c in dwg_io.drawing_to_candidates(data)]
    state.partlist.parts.extend(parts)
    state.partlist.drawings.append(dwg_io.drawing_record(data, len(parts), parts))
    state.mark_dirty()
    register = window.pages["drawings"].table
    headers = [register.horizontalHeaderItem(c).text() for c in range(register.columnCount())]
    assert register.item(0, headers.index("จำนวนชิ้น")).text() == "24"
    page = window.pages["parts"]
    from PySide6.QtCore import Qt

    tip = page.model.data(page.model.index(0, COLUMN_KEYS.index("qty")), Qt.ToolTipRole)
    assert "16 ชิ้น" in tip
    part = state.partlist.parts[0]
    w = part.weight
    assert page.model.setData(page.model.index(0, COLUMN_KEYS.index("thickness")), "4.5")
    assert part.thickness == 4.5 and part.spec.startswith("t4.5")
    assert part.weight == pytest.approx(w * 1.5, abs=2e-3)
    dialog = ThicknessDialog(state.partlist.parts, [1, 2], 8)
    dialog.apply()
    assert [p.thickness for p in state.partlist.parts] == [4.5, 8, 8, 2, 2.3]
    dialog.scope.button(1).setChecked(True)  # every plate part
    dialog.action.button(1).setChecked(True)  # back to the drawing
    assert dialog.apply() == 3
    assert [p.thickness for p in state.partlist.parts] == [3, 3.2, 4, 2, 2.3]


def test_models_and_sources_flow(window, app, tmp_path, monkeypatch):
    from partlist_studio.core.company_files import ModelBOM, ModelRow
    from partlist_studio.core.stock import StockItem, StockList
    from partlist_studio.ui import work_dialogs

    state = window.state
    state.set_models([ModelBOM("แบบ A", "แบบทดสอบ", [ModelRow("1", "RRS-A-1", ["RRS-A-1"], "เฟรม", "", "1+1", 2)])])
    page = window.pages["models"]
    assert page.list.count() == 1 and page.table.rowCount() == 1
    monkeypatch.setattr(work_dialogs.VariantDialog, "exec", lambda self: (self.sets.setValue(2), 1)[1])
    page._use()
    assert [(p.part_no, p.qty) for p in state.partlist.parts] == [("RRS-A-1", 2)]  # per bed
    assert state.partlist.info.build_qty == 2
    state.add_stock_source("นับสต๊อค", StockList(items=[StockItem(code="RRS-A-1", on_hand=10, unit="ชิ้น")]))
    state.add_stock_source("สำรอง", StockList(items=[StockItem(code="RRS-A-1", on_hand=1)]), activate=False)
    assert state.stock.items[0].on_hand == 10
    assert window.pages["stock"].sources.count() == 2
    assert window.pages["stock"].run_check(show=False)
    assert state.requirements[0].status == "พอ"
    express = window.pages["express"]
    express.check_codes()
    assert express.result.rowCount() == 1
    # data survives a restart
    from partlist_studio.ui.state import AppState

    again = AppState(data_dir=state.data_dir())
    assert again.models[0].name == "แบบ A" and again.active_sources == ["นับสต๊อค"]


def test_express_codes_for_models(window, app, tmp_path, monkeypatch):
    import time

    from PySide6.QtWidgets import QMessageBox

    from partlist_studio.core.company_files import ModelBOM, ModelRow
    from partlist_studio.core.express import read_express_file

    state = window.state
    express, _ = read_express_file(SAMPLES / "express_item_detail_STMASR0200.txt")
    state.add_stock_source("Express: STMASR0200.txt", express)
    state.set_models([ModelBOM("กระบะคอกสูง3ราว", "Toyota คอกสูง 3 ราว", [
        ModelRow(item_no="1", raw_code="RRS-T-023", codes=["RRS-T-023"], name="เสาหลัง 80", qty_text="1+1", qty=2)])])
    page = window.pages["express"]
    out = tmp_path / "all.xlsx"
    monkeypatch.setattr(page.actions, "save_path", lambda *a: str(out))
    page.export_partlist_express()
    deadline = time.time() + 20
    while page.result.rowCount() == 0 and time.time() < deadline:
        app.processEvents()
        time.sleep(0.02)
    assert out.is_file() and page.result.rowCount() == 2

    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.Yes)
    page.apply_express_codes()
    assert [r.code for r in state.models[0].rows] == ["RRS-A-102-L-80", "RRS-A-102-R-80"]


def test_production_documents_nesting_minmax(window, app, monkeypatch):
    from PySide6.QtWidgets import QInputDialog, QMessageBox

    from partlist_studio.core import dwg_io
    from partlist_studio.core.stock import StockItem, StockList
    from partlist_studio.ui.work_dialogs import CompareDialog, NewCodeDialog

    state = window.state
    data = dwg_io.read_drawing(SAMPLES / "RRS-TB-001_side_panel.dxf")
    state.partlist.parts = [c.part for c in dwg_io.drawing_to_candidates(data)]
    state.partlist.info.build_qty = 2
    state.add_stock_source("สต็อก", StockList(items=[
        StockItem(code="RRS-TB-001", name="แผ่นข้างตู้ ซ้าย", unit="ชิ้น", on_hand=1),
        StockItem(code="01-B00 -0004", name="เหล็กแผ่นดำ 3.2 มม.4x8ฟุต 1219x2440", unit="แผ่น", spec="t3.2",
                  material="SS400", on_hand=5)]))
    monkeypatch.setattr(QInputDialog, "getText", lambda *a, **k: ("SO-T1", True))
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.Yes)
    monkeypatch.setattr(QMessageBox, "information", lambda *a, **k: None)
    prod = window.pages["production"]
    prod.new_from_partlist()
    job = state.jobs[0]
    assert job.job_no == "SO-T1" and prod.parts.rowCount() == len(job.parts)
    prod.parts.selectRow(0)
    prod.finish()
    assert job.parts[0].status == "เสร็จ"
    prod.make_documents()
    moves = window.pages["movements"]
    assert window.stack.currentWidget() is moves and moves.docs.rowCount() >= 1
    fr = next(d for d in state.ledger.docs if d.doc_type == "FR")
    moves._show_doc(fr)
    moves.post_doc()
    assert fr.status == "บันทึกแล้ว" and job.parts[0].received == job.parts[0].to_make
    assert moves.history.rowCount() == len(fr.lines)

    nest = window.pages["nesting"]
    nest.run()
    assert nest.groups and nest.table.rowCount() >= 1
    stock_page = window.pages["stock"]
    stock_page.replenish.run()
    assert stock_page.replenish.table.rowCount() == len(state.stock.items)

    dialog = CompareDialog(state, window.actions, window)
    dialog.sources[0][0].setCurrentIndex(1)  # Part List ปัจจุบัน vs itself
    dialog.run()
    assert dialog.changes and all(c.kind == "เหมือนเดิม" for c in dialog.changes)
    code = NewCodeDialog(state, "ฝาข้างใหม่(ซ้าย)", window)
    assert code.result.code.startswith("RRS-A-") and code.result.code.endswith("-L")

    from partlist_studio.ui.state import AppState

    again = AppState(data_dir=state.data_dir())
    assert again.jobs[0].job_no == "SO-T1" and again.ledger.docs[0].doc_no == state.ledger.docs[0].doc_no


def test_laser_page_from_jobs_to_cut(window, app, monkeypatch, tmp_path):
    from PySide6.QtWidgets import QFileDialog, QMessageBox

    from partlist_studio.core import dwg_io, laser, production
    from partlist_studio.ui.pages import nesting as page_mod

    state = window.state
    data = dwg_io.read_drawing(SAMPLES / "RRS-T-SET_frame_parts.dxf")
    parts = [c.part for c in dwg_io.drawing_to_candidates(data)]
    assert state.flats.add_parts(parts) == 5
    state.jobs.append(production.job_from_parts("SO6910-020", parts, 2, None, False))
    state.save_jobs()
    page = window.pages["nesting"]
    page.source.setCurrentIndex(page.source.findData(page_mod.SRC_JOBS))
    assert page.jobs.count() == 1 and page.jobs.item(0).checkState().name == "Checked"
    page.run()
    assert page.groups and page.make_btn.isEnabled()
    page.make_programs()
    queue = state.cut_queue
    assert queue.programs and page.programs.rowCount() == len(queue.open_programs())
    page.run()  # everything is in the queue now: nothing left to plan
    assert not page.groups
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *a, **k: str(tmp_path))
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.No)
    page.export_package(False)
    [folder] = list(tmp_path.glob("LaserPackage_*"))
    assert (folder / "ใบสั่งตัดเลเซอร์.xlsx").is_file() and list((folder / "programs").rglob("*.dxf"))
    t3 = next(p for p in queue.programs if p.thickness == 3)
    page.programs.selectRow(page._programs.index(t3))
    monkeypatch.setattr(page_mod.CutDialog, "exec", lambda self: 1)
    page.record_cut()
    job = state.jobs[-1]
    assert t3.status == laser.ST_DONE and job.parts[0].status_text == "รอพับ 32"
    assert any(d.doc_type == "PD" and t3.no in d.remark for d in state.ledger.docs)
    from partlist_studio.ui.state import AppState

    again = AppState(data_dir=state.data_dir())  # queue and library are saved
    assert again.cut_queue.find(t3.no).status == laser.ST_DONE and again.flats.get("RRS-T-001")


def test_laser_settings_dialog(app):
    from partlist_studio.core import laser
    from partlist_studio.ui.pages.nesting import LaserSettingsDialog

    dialog = LaserSettingsDialog(laser.LaserParams())
    row = next(r for r in range(dialog.speeds.rowCount()) if dialog.speeds.item(r, 0).text() == "3")
    dialog.speeds.item(row, 1).setText("3800")
    dialog.mark.setChecked(True)
    p = dialog.result_params()
    assert p.speed("STEEL", 3) == 3800 and p.mark_codes and p.speed("SUS", 3) == 26000
    assert p.machine == "HSG 12,000W" and p.bed_l == 8000
    dialog.machine.setCurrentText("Fiber 3,000W (ทั่วไป)")
    dialog._use_machine()
    p = dialog.result_params()
    assert p.speed("STEEL", 3) == 4500 and p.bed_l == 3000 and p.machine.startswith("Fiber 3,000W")


def test_parts_ready_tab_readiness_tickets_and_scan(window, app, monkeypatch, tmp_path):
    from PySide6.QtWidgets import QInputDialog

    from partlist_studio.core import catalog, production, qr
    from partlist_studio.core.stock import StockItem, StockList

    state = window.state
    state.add_stock_source("Express", StockList(items=[
        StockItem(code="RRS-T-024-L-84", name="บังอาย Champ 84(ซ้าย)", unit="ชิ้น", on_hand=4),
        StockItem(code="RRS-A-102-L-80", name="เสาหลัง(ซ้าย) 80", unit="ต้น", on_hand=1),
        StockItem(code="01-B00-0004", name="เหล็กแผ่นดำ 3.2 มม.", unit="แผ่น", on_hand=5)]))
    job = production.job_from_parts("SO-R1", [], 3, None, False, title="คอกสูง 3 ราว")
    job.parts = [production.JobPart("1", "RRS-T-024-L-84", "บังอาย Champ 84(ซ้าย)", 2, 6, from_stock=2,
                                    route=["ตัด", "พับ"], done={"ตัด": 3}),
                 production.JobPart("2", "RRS-A-102-L-80", "เสาหลัง(ซ้าย) 80", 1, 3, from_stock=3, route=[])]
    state.jobs.append(job)
    state.save_jobs()
    stock_page = window.pages["stock"]
    window.go("stock")
    stock_page.tabs.setCurrentWidget(stock_page.ready)
    tab = stock_page.ready
    assert tab.table.rowCount() == 2 and tab.groups.count() == 3  # ทุกกลุ่ม, FRONT, POST
    tab.search.setText(qr.item_payload("RRS-A-102-L-80", "x"))  # a scanned shelf label
    assert tab.table.rowCount() == 1 and tab.table.item(0, 1).text() == "RRS-A-102-L-80"
    tab.search.clear()
    cell = tab.table.item(0, catalog.PART_STOCK_HEADERS.index("ตำแหน่ง"))
    cell.setText("P-FRONT-01")  # typed in the table: saved, and the table is not rebuilt under the user
    assert state.catalog.location_of("RRS-T-024-L-84") == "P-FRONT-01" and tab.shown[0].location == "P-FRONT-01"
    assert tab.table.item(0, catalog.PART_STOCK_HEADERS.index("ตำแหน่ง")) is cell
    tab.table.selectRow(0)
    monkeypatch.setattr(QInputDialog, "getItem", lambda *a, **k: ("FIX – หู / ตัวยึด / ล็อก", True))
    tab.set_group()
    assert state.catalog.group_of("RRS-T-024-L-84", "บังอาย") == "FIX" and tab.groups.count() == 3
    monkeypatch.setattr(window.actions, "save_path", lambda caption, name, filters: str(tmp_path / name))
    tab.print_labels()
    assert (tmp_path / "ป้ายชั้นวาง.pdf").read_bytes()[:4] == b"%PDF"
    tab.export()
    assert (tmp_path / "ชิ้นส่วนพร้อมประกอบ_แยกกลุ่ม.xlsx").is_file()

    prod = window.pages["production"]
    window.go("production")
    prod._select_job("SO-R1")
    prod.tabs.setCurrentIndex(1)
    assert prod.ready_groups.rowCount() == 2 and "พร้อมประกอบ" in prod.ready_label.text()
    assert prod.ready_groups.item(0, 0).text() == "เสา / ซองเสา"  # FIX is listed after POST
    prod.parts.clearSelection()
    prod.print_tickets()  # nothing selected: every part the job makes
    assert (tmp_path / "ใบงาน_SO-R1.pdf").read_bytes()[:4] == b"%PDF"
    prod.export_kitting()
    assert (tmp_path / "ใบจัดชุด_SO-R1.xlsx").is_file()
    prod.scan.setText(qr.ticket_payload("SO-R1", 1, "RRS-T-024-L-84", 4))
    prod.scanned()
    assert prod.tabs.currentIndex() == 0 and [i.row() for i in prod.parts.selectionModel().selectedRows()] == [0]
    prod.scan.setText("เสาหลัง")
    prod.scanned()
    assert [i.row() for i in prod.parts.selectionModel().selectedRows()] == [1]
    from partlist_studio.ui.state import AppState

    again = AppState(data_dir=state.data_dir())  # what was set by hand is saved
    assert again.catalog.group_of("RRS-T-024-L-84") == "FIX" and again.catalog.location_of("RRS-T-024-L-84") == "P-FRONT-01"


def test_beds_edited_in_one_place(window, app):
    from partlist_studio.core import production
    from partlist_studio.core.models import Part

    state = window.state
    state.partlist.parts = [Part(part_no="RRS-T-001", name="เฟรมบน", qty=2)]
    state.partlist.info.build_qty = 3
    state.mark_dirty()
    stock, nest = window.pages["stock"], window.pages["nesting"]
    assert "3 คัน" in stock.build.text() and "3 คัน" in nest.sets.text()  # shown, not edited there
    dash = window.pages["dashboard"]
    dash.build_qty.setValue(5)  # the one place for the Part List
    assert state.partlist.info.build_qty == 5 and "5 คัน" in stock.build.text() and "5 คัน" in nest.sets.text()
    job = production.job_from_parts("SO-K1", state.partlist.parts, 5, None, False)
    state.jobs.append(job)
    state.save_jobs()
    prod = window.pages["production"]
    prod._select_job("SO-K1")
    assert prod.sets.value() == 5
    prod.sets.setValue(4)  # an open job: its beds are changed on the job page
    assert job.sets == 4 and job.parts[0].required == 8 and state.partlist.info.build_qty == 5
