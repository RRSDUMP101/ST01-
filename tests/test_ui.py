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


def test_models_and_sources_flow(window, app, tmp_path):
    from partlist_studio.core.company_files import ModelBOM, ModelRow
    from partlist_studio.core.stock import StockItem, StockList

    state = window.state
    state.set_models([ModelBOM("แบบ A", "แบบทดสอบ", [ModelRow("1", "RRS-A-1", ["RRS-A-1"], "เฟรม", "", "1+1", 2)])])
    page = window.pages["models"]
    assert page.list.count() == 1 and page.table.rowCount() == 1
    page.sets.setValue(2)
    page._use(replace=True)
    assert [(p.part_no, p.qty) for p in state.partlist.parts] == [("RRS-A-1", 4)]
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
