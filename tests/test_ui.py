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
def window(app):
    from PySide6.QtCore import QSettings

    from partlist_studio.ui import theme
    from partlist_studio.ui.main_window import MainWindow

    QSettings().clear()
    app.setStyleSheet(theme.STYLE_SHEET)
    w = MainWindow()
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
