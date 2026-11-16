"""แท็บ ไฟล์ ZW3D: a ZW3D file opened in the program - tree, parts list, CSV, Part List."""

import os

import pytest
from test_z3_reader import Z3Builder, model, pin_file


@pytest.fixture
def tab(tmp_path):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    w.go("install")
    page = w.pages["install"]
    page.tabs.setCurrentWidget(page.z3)
    yield page.z3
    app.processEvents()
    w.state.dirty = False
    w.close()


def test_open_list_export_and_add(tab, tmp_path):
    from partlist_studio.core import z3_reader as z3

    path = tmp_path / "งานประกอบ ทดสอบ.Z3"
    path.write_bytes(model().build())
    (tmp_path / "สลัก.Z3").write_bytes(pin_file())
    expected = z3.bom(z3.read_z3(path))
    assert tab.table.rowCount() == 0 and tab.add_to_partlist() == 0 and tab.export_csv(str(tmp_path / "no.csv")) == ""
    assert tab.load(str(path))
    assert tab.title.text() == path.name and "งานประกอบ ทดสอบ" in tab.summary.text() and "TESTER" in tab.summary.text()
    assert tab.tree.topLevelItemCount() == 1 and tab.tree.topLevelItem(0).text(0) == expected.root.name
    assert tab.tree.topLevelItem(0).childCount() == len(expected.root.children)
    own, everything = expected.own(), expected.flat
    assert len(everything) > len(own) > 0  # the model uses parts of other files too
    assert tab.scope.currentData() == "own" and tab.table.rowCount() == len(own)
    assert [tab.table.item(r, 1).text() for r in range(len(own))] == [x.name for x in own]
    tab.scope.setCurrentIndex(1)
    assert tab.table.rowCount() == len(everything) and f"{sum(x.qty for x in everything)} ชิ้น" in tab.count.text()
    out = tmp_path / "bom.csv"
    assert tab.export_csv(str(out))
    text = out.read_text(encoding="utf-8-sig").splitlines()
    assert text[0] == "ลำดับ,ชื่อชิ้นส่วน,จำนวนรวม,อยู่ในไฟล์,หมายเหตุ" and len(text) == len(everything) + 1
    tab.scope.setCurrentIndex(0)
    tab.table.selectRow(0)
    assert tab.add_to_partlist() == 1  # the chosen row only
    part = tab.state.partlist.parts[-1]
    assert part.name == own[0].name and part.qty == own[0].qty and part.drawing_no == path.stem and "ZW3D" in part.remark
    tab.table.clearSelection()
    assert tab.add_to_partlist() == len(own) and tab.state.partlist.parts[-1].item_no == str(len(own) + 1)


def test_files_that_cannot_be_listed(tab, tmp_path):
    bad = tmp_path / "เสีย.Z3"
    bad.write_bytes(model().build()[:-200])
    assert not tab.load(str(bad)) and tab.title.text() == "อ่านไฟล์ไม่ได้" and "เสีย.Z3" in tab.summary.text()
    assert tab.table.rowCount() == 0 and tab.file is None
    text = tmp_path / "ไม่ใช่.Z3"
    text.write_text("hello", encoding="utf-8")
    assert not tab.load(str(text)) and "ไม่ใช่ไฟล์ ZW3D" in tab.summary.text()
    drawings = Z3Builder()
    drawings.drawing("แบบแผ่นพื้น_2D")
    only_2d = tmp_path / "แบบ.Z3"
    only_2d.write_bytes(drawings.build())
    assert tab.load(str(only_2d)) and "มีแต่แบบ 2 มิติ" in tab.summary.text() and tab.table.rowCount() == 0
    assert tab.tree.topLevelItemCount() == 0
