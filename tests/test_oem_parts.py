"""อะไหล่ Ford OEM: pages saved from the browser → catalogue → Part List / Excel."""

import os
from pathlib import Path

import pytest

from partlist_studio.core import oem_parts as oem

SAMPLE = Path(__file__).with_name("oem_page_sample.html")
PAGE3 = """<h1>Headlamp Components for 2026 Ford F-350 Super Duty</h1>
<h2>Diagram 3: High Beam Bulb</h2><div>No.</div><div>Part # / Description / Price</div>
<div>1</div><a href="https://ford.oempartsonline.com/oem-parts/ford-bulb-9l3z13n021b">Bulb</a>
<div>MSRP $31.20</div><div>$22.05</div><div>Sewell Ford</div><div>Notes: High beam. 9005.</div>"""


def test_ford_part_numbers():
    assert oem.split_ford_pn("PC3Z-13008-A") == ("PC3Z", "13008", "A")
    assert oem.split_ford_pn("hello") == ("", "hello", "")
    assert oem.slug_part_number("/oem-parts/ford-headlamp-assembly-pc3z13008a") == "PC3Z-13008-A"
    assert oem.slug_part_number("/oem-parts/ford-bulb-cover-pc3z13n021b?x=1") == "PC3Z-13N021-B"
    assert oem.slug_part_number("/oem-parts/ford-headlamp-bolt-w716593s450") == "W716593-S450"
    assert oem.money("$1,079.68") == 1079.68 and oem.money("") == 0 and oem.qty_of("2 pcs") == 2


def test_saved_page_is_read_by_its_text():
    asm, vehicle = oem.parse_page(SAMPLE.read_text(encoding="utf-8"))
    assert vehicle == "2026 Ford F-350 Super Duty" and (asm.number, asm.title) == (1, "Headlamp Assembly")
    first, bolt, cover = asm.parts  # the row of 'Related Parts' is not taken
    assert (first.callout, first.part_number, first.description) == ("1", "PC3Z-13008-A", "Headlamp Assembly")
    assert (first.msrp, first.price, first.seller, first.qty) == ("$1,079.68", "$717.77", "Sewell Ford", "1")
    assert first.notes == "Notes: Left. With LED."
    assert bolt.part_number == "W716593-S450" and bolt.price == "$3.10"
    assert cover.part_number == "PC3Z-13N021-B" and cover.notes == "Replaces: HC3Z-13N021-A"  # not the old number


def test_catalog_library_and_part_list(tmp_path):
    cat = oem.catalog_from_pages([SAMPLE.read_text(encoding="utf-8"), PAGE3, PAGE3])
    assert cat.vehicle == "2026 Ford F-350 Super Duty" and cat.category == "Headlamp Components"
    assert [a.number for a in cat.assemblies] == [1, 3] and cat.part_count == 4
    assert oem.missing_numbers(cat, 29)[:3] == [2, 4, 5] and len(oem.missing_numbers(cat, 29)) == 27
    assert [p.part_number for _a, p in cat.search("bulb 9005")] == ["9L3Z-13N021-B"]
    assert cat.where_used("PC3Z-13008-A") == [1]
    lib = oem.OemLibrary(tmp_path / "lib")
    src = tmp_path / "cat.json"
    cat.save(src)
    back = lib.add(src)
    assert back.to_dict() == cat.to_dict() and len(lib.catalogs) == 1
    (tmp_path / "lib" / "broken.json").write_text("{}", encoding="utf-8")
    lib.reload()
    assert len(lib.catalogs) == 1 and lib.problems
    a, p = cat.rows()[0]
    part = oem.to_part(a, p, cat.vehicle, sets=3)
    assert (part.part_no, part.name, part.qty, part.process) == ("PC3Z-13008-A", "Headlamp Assembly", 3, oem.PROCESS)
    assert part.drawing_no == "FORD-ASM-01" and "ตำแหน่ง 1" in part.remark and "Left" in part.remark
    out = tmp_path / "x.xlsx"
    assert oem.export_xlsx(cat, cat.rows(), out) == 4
    from openpyxl import load_workbook

    ws = load_workbook(out).active
    assert ws["D4"].value == "PC3Z-13008-A" and ws["J4"].value == 717.77 and ws["E4"].value == "13008"


def test_oem_tab(tmp_path):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    w.go("install")
    tab = w.pages["install"].oem
    assert tab.table.rowCount() == 0 and "Chrome" in tab.coverage.text()
    page3 = tmp_path / "d3.html"
    page3.write_text(PAGE3, encoding="utf-8")
    tab.import_pages([str(SAMPLE)])
    tab.import_pages([str(page3)])  # a second round keeps the diagram of the first
    assert tab.catalogs.count() == 1 and tab.catalog.part_count == 4 and tab.table.rowCount() == 4
    assert "ยังขาดแผนภาพ: 2, 4" in tab.coverage.text()
    tab.diagrams.setCurrentRow(2)  # 3. High Beam Bulb
    assert tab.table.rowCount() == 1 and tab.table.item(0, 2).text() == "9L3Z-13N021-B"
    tab.diagrams.setCurrentRow(0)
    tab.search.setText("headlamp")  # the parts and the diagram titled Headlamp Assembly
    assert tab.table.rowCount() == 3
    from PySide6.QtWidgets import QAbstractItemView

    tab.table.setSelectionMode(QAbstractItemView.MultiSelection)
    tab.table.selectRow(0)
    tab.table.selectRow(1)
    tab.sets.setValue(2)
    assert tab.add_to_partlist() == 2  # the selected rows only
    parts = w.state.partlist.parts
    assert [p.part_no for p in parts] == ["PC3Z-13008-A", "W716593-S450"] and parts[0].qty == 2 and parts[1].item_no == "2"
    assert tab.export(str(tmp_path / "o.xlsx"))
    app.processEvents()
    w.state.dirty = False
    w.close()


def _png(path):
    from PIL import Image

    Image.new("RGB", (120, 90), "white").save(path)
    return path


def test_diagram_pictures_and_callouts(tmp_path):
    assert oem.parse_callouts("1-12")[-1] == "12" and oem.parse_callouts("1-4, 6,8 8") == ["1", "2", "3", "4", "6", "8"]
    cat = oem.catalog_from_pages([SAMPLE.read_text(encoding="utf-8")])
    a1 = cat.assembly(1)
    assert a1.image_url == "https://example.invalid/diagrams/headlamp-1.png"
    a1.callouts = "1-12"
    assert a1.missing_callouts() == ["3", "4", "5", "6", "7", "9", "10", "11", "12"]
    lib = oem.OemLibrary(tmp_path / "lib")
    lib.attach_image(cat, 1, _png(tmp_path / "d1.png"))
    lib.attach_image(cat, 7, _png(tmp_path / "d7.png"), "Low Beam Bulb")  # a picture before its page
    back = lib.catalogs[0]
    assert [a.number for a in back.assemblies] == [1, 7] and back.assembly(7).title == "Low Beam Bulb"
    assert back.assembly(1).callouts == "1-12" and lib.image_path(back.assembly(1)).is_file()
    lib.remove(back)
    assert not list((tmp_path / "lib" / "images").iterdir())
    # a page saved as 'Webpage, Complete': its picture is in the _files folder next to it
    folder = tmp_path / "page_files"
    folder.mkdir()
    _png(folder / "headlamp 1.png")
    page = SAMPLE.read_text(encoding="utf-8").replace("https://example.invalid/diagrams/headlamp-1.png",
                                                       "./page_files/headlamp%201.png")
    assert oem.local_image(tmp_path / "page.html", oem.diagram_image_src(page, 1)) == (folder / "headlamp 1.png").resolve()
    assert oem.local_image(tmp_path / "page.html", "https://x.invalid/a.png") is None


def test_oem_tab_pictures(tmp_path):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    tab = w.pages["install"].oem
    folder = tmp_path / "saved_files"
    folder.mkdir()
    _png(folder / "d1.png")
    saved = tmp_path / "saved.html"
    saved.write_text(SAMPLE.read_text(encoding="utf-8").replace("https://example.invalid/diagrams/headlamp-1.png",
                                                                 "saved_files/d1.png"), encoding="utf-8")
    tab.import_pages([str(saved)])
    tab.diagrams.setCurrentRow(1)
    assert tab.picture.pixmap() and not tab.picture.pixmap().isNull() and "🖼" in tab.diagrams.item(1).text()
    tab.callouts.setText("1-12")
    tab.set_callouts()
    assert "3, 4, 5" in tab.callout_check.text() and "⚠" in tab.diagrams.item(1).text()
    tab.import_pages([str(SAMPLE)])  # the page again: its picture and numbers stay
    assert tab.catalog.assembly(1).image_file and tab.catalog.assembly(1).callouts == "1-12"
    tab.diagrams.setCurrentRow(0)
    asm = tab.attach_image(str(_png(tmp_path / "x.png")), number=4, title="Low Beam Bulb")
    assert asm.number == 4 and tab.current_assembly().number == 4 and tab.catalog.part_count == 3
    app.processEvents()
    w.state.dirty = False
    w.close()
