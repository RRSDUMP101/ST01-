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
    for i in range(window.nav.count()):
        window.nav.setCurrentRow(i)
        app.processEvents()
        assert window.stack.currentIndex() == i


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
    assert p.speed("STEEL", 3) == 3800 and p.mark_codes and p.speed("SUS", 3) == 4500
