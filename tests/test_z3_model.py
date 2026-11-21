"""A ZW3D file opened as a 3D assembly (core/z3_model.py): boxes where the file places them, the box trailer's 13 steps,
and what is wrong with the design. The files are made here, like in test_z3_reader – never a file of a customer."""

import os
import time

import numpy as np
import pytest
from test_z3_reader import Z3Builder, move, write

from partlist_studio.core import assembly3d as a3
from partlist_studio.core import z3_model as zm
from partlist_studio.core import z3_reader as zr


def trailer(tmp_path, name: str = "รวมหางลาก ford.Z3"):
    """A small box trailer drawn like the RRS one: +Y to the rear, Z up, model +X = the left of the vehicle."""
    b = Z3Builder(fmt=3000)
    top = b.obj3d("รวมหางลาก ford")
    b.obj3d("4x5500 p2", box=(-45, 45, -2845, 2845, -282, 0))
    b.obj3d("4x5500 p2_Mirror_1", box=(-45, 45, -2845, 2795, -282, 0))  # 50 shorter: the RRS rails differ like this
    b.obj3d("บน p4", box=(-900, 900, -25, 25, -72, 0))
    b.obj3d("พื้นตีนไก่", box=(-900, 900, -2850, 2850, 0, 5))
    b.obj3d("ตู้ p1", box=(-25, 25, -50, 50, 0, 2250))
    b.obj3d("ตู้ p1_Mirror", box=(-25, 25, -50, 50, 0, 2250))
    door = b.obj3d("ประตูตู้ 1", box=(-18, 18, -700, 700, 0, 2200))  # an assembly with a shape of its own
    door2 = b.obj3d("ประตูตู้ 1_Mirror_6", box=(-18, 18, -700, 700, 0, 2200))
    b.obj3d("บานพับ ใหญ่", box=(0, 70, -50, 50, 0, 100))
    b.obj3d("Part002", box=(0, 25, -30, 30, 0, 40))
    b.obj3d("Part005", box=(-900, 900, 0, 150, 0, 54))
    b.obj3d("ล่าง p4", box=(-50, 50, -1500, 0, 0, 50))
    b.obj3d("Part006", box=(-150, 150, -4400, 0, 0, 7))  # the plate under the drawbar reaches its tip
    b.obj3d("ล่าง p1", box=(-100, 100, -8000, 0, 0, 100))  # stale: 8 m of drawbar
    b.obj3d("ไฟหลังสีแดง", box=(-45, 45, 0, 28, 0, 87))
    b.obj3d("กันนำ้บนหลังคา", box=(-900, 900, -2850, 2850, 0, 30))  # sara am before mai tho, as in the RRS file
    b.obj3d("แบบเก่า", box=(0, 10, 0, 10, 0, 10))  # in the file, used by nothing
    b.component(top, "4x5500 p2", at=move(857, 0, 707))
    b.component(top, "4x5500 p2_Mirror_1", at=move(-857, 0, 707))
    for k, y in enumerate((-600, 0, 600)):
        b.component(top, "บน p4", instance=f"บน p4_{k + 1}", at=move(0, y, 698))
    b.component(top, "พื้นตีนไก่", at=move(0, 0, 700))
    b.component(top, "ตู้ p1", at=move(875, -2800, 705))
    b.component(top, "ตู้ p1_Mirror", at=move(-875, -2800, 705))
    b.component(top, "ประตูตู้ 1", at=move(900, -1500, 750))
    b.component(top, "ประตูตู้ 1_Mirror_6", at=move(-900, -1500, 750))
    b.component(door, "บานพับ ใหญ่", instance="บานพับ ใหญ่_1", at=move(18, -650, 200))
    b.component(door2, "บานพับ ใหญ่", instance="บานพับ ใหญ่_1", at=move(-88, -650, 200))
    b.component(top, "Part002", instance="Part002_1", at=move(900, -2200, 700))  # on the +X side only
    b.component(top, "Part002", instance="Part002_2", at=move(900, -800, 700))
    b.component(top, "Part005", instance="Part005_1", at=move(0, 2800, 2955))
    b.component(top, "Part005", instance="Part005_2", at=move(0, 2800, 2955))  # the same place twice
    b.component(top, "ล่าง p4", at=move(0, -2850, 450))
    b.component(top, "Part006", at=move(0, 0, 441))
    b.component(top, "ล่าง p1", at=move(0, -2850, 450))
    b.component(top, "ไฟหลังสีแดง", instance="ไฟหลังสีแดง_1", at=move(700, 2860, 2900))
    b.component(top, "ไฟหลังสีแดง", instance="ไฟหลังสีแดง_2", at=move(-700, 2860, 2900))
    b.component(top, "กันนำ้บนหลังคา", at=move(0, 0, 3000))
    b.drawing("ประตูตู้ 1_2D")  # the 2D drawings of the file: one of a door, one of the whole
    b.component(-1, "ประตูตู้ 1", instance="")
    b.drawing("รวมหางลาก ford_2D")
    b.component(-1, "รวมหางลาก ford", instance="")
    return write(tmp_path, b.build(), name)


def by_cad(model, text):
    return [p for p in model.parts if p.name == text or f"ชื่อในไฟล์: {text}" in p.note]


def test_the_box_trailer_opens_as_boxes_in_its_13_steps(tmp_path):
    model, check = zm.model_from_z3(trailer(tmp_path))
    assert model.name == "รวมหางลาก ford" and model.source == "file" and model.problems() == []
    assert [n for n, s in enumerate(model.steps, 1) if s.no_parts] == [1, 2, 3, 6, 8, 13, 15, 16, 17, 19]  # no part here
    assert len(model.parts) == 22  # 20 parts + the 2 door leaves, which are assemblies with a shape of their own
    assert check.bodies == 2 and all(p.shape == "box" for p in model.parts)
    assert len(model.steps) == 19 and [s.phase for s in model.steps[:4]] == [zm.TRAILER_PHASES[0]] * 3 + [zm.TRAILER_PHASES[1]]
    assert model.steps[-1].phase == zm.TRAILER_PHASES[3] and model.steps[-1].no_parts
    steps = {p.group: p.step for p in model.parts}
    assert steps == {"คานแม่": 4, "คานขวาง": 5, "พื้นตู้": 9, "โครงตู้": 11, "หลังคา": 12, "ประตูข้าง": 10,
                     "บานพับ + หูรับกลอน": 14, "คันลาก": 7, "ไฟ + ป้าย": 18}
    # axes: X(program) = Y(file) to the rear, Y(program) = -X(file) = right of the vehicle, Z up
    rail = [p for p in model.parts if p.group == "คานแม่"]
    left = next(p for p in rail if p.centre()[1] < 0)
    lo, hi = left.bounds()
    assert np.allclose(lo, (-2845, -902, 425)) and np.allclose(hi, (2845, -812, 707)) and "ซ้าย" in left.name
    assert "ขวา" in next(p for p in rail if p.centre()[1] > 0).name
    # the 2 door leaves named by where they are; the file name stays in the note
    leaves = sorted(p.name for p in model.parts if p.name.startswith("ประตูข้าง"))
    assert leaves == ["ประตูข้างขวา บานที่ 1", "ประตูข้างซ้าย บานที่ 1"]
    assert "ชื่อในไฟล์: ประตูตู้ 1" in next(p for p in model.parts if p.name == "ประตูข้างซ้าย บานที่ 1").note
    # misspelling of the file corrected for the technician, and still known by its own spelling
    roof = by_cad(model, "กันนำ้บนหลังคา")
    assert len(roof) == 1 and roof[0].name == "กันน้ำบนหลังคา" and roof[0].group == "หลังคา"
    assert "กล่องขอบเขต" in model.note and "19 ขั้น 4 ช่วงงาน" in model.note


def test_what_is_wrong_with_the_design_is_found(tmp_path):
    model, check = zm.model_from_z3(trailer(tmp_path))
    assert check.duplicates == [("Part005_1", "Part005_2")]
    assert check.stale == ["ล่าง p1"]  # cut back to the other parts: the drawbar ends where Part006 ends
    stale = next(p for p in model.parts if p.name.startswith("ล่าง p1"))
    assert stale.bounds()[0][0] == pytest.approx(-4400) and "กล่องเกินชิ้นจริง" in stale.note
    assert check.alone == {"Part002": 2}  # on one side only
    assert check.uneven == [("4x5500 p2", pytest.approx(50))]
    assert check.unused == 1 and check.unused_names == ["แบบเก่า"]
    for text in ("ชิ้นวางซ้ำที่เดียวกัน: Part005_1 = Part005_2", "ไม่มีคู่อีกด้าน: Part002 2 ชิ้น",
                 "ซ้าย/ขวาไม่เท่ากัน 50 มม.: 4x5500 p2", "วัตถุในไฟล์ที่ไม่ได้ใช้ในชุดประกอบ 1 รายการ"):
        assert text in model.note
    assert f"คำเตือนของแบบ {len(check.lines())} ข้อ" in model.note
    lo, hi = model.bounds()
    assert lo[0] == pytest.approx(-4400) and hi[0] == pytest.approx(2950)  # the stale box no longer sets the length


def test_every_part_knows_its_drawing_and_the_steps_their_bought_in_items(tmp_path):
    model, _check = zm.model_from_z3(trailer(tmp_path))
    door = by_cad(model, "ประตูตู้ 1")[0]
    assert (door.drawing, door.drawing_how) == ("ประตูตู้ 1_2D", "แบบของชิ้นนี้")
    twin = by_cad(model, "ประตูตู้ 1_Mirror_6")[0]  # a mirrored copy has no drawing of its own
    assert twin.drawing == "ประตูตู้ 1_2D" and "ภาพกลับด้าน" in twin.drawing_how
    hinges = [p for p in model.parts if p.name.startswith("บานพับ")]
    assert len(hinges) == 2 and all(h.drawing == "ประตูตู้ 1_2D" for h in hinges)  # the drawing of the door they are in
    assert sorted(h.drawing_how for h in hinges) == ["แบบของชุด ประตูตู้ 1", "แบบของชุด ประตูตู้ 1_Mirror_6"]
    rail = next(p for p in model.parts if p.group == "คานแม่")
    assert (rail.drawing, rail.drawing_how) == ("รวมหางลาก ford_2D", "แบบรวม")
    info = a3.part_details(model, door)
    assert ("แบบ 2 มิติ", "ประตูตู้ 1_2D (แบบของชิ้นนี้) · ยังไม่ได้แนบไฟล์ PDF ที่ส่งออกจาก CAD") in info["rows"]
    model.drawing_files["ประตูตู้ 1_2D"] = str(tmp_path / "door.pdf")
    info = a3.part_details(model, door)
    assert info["drawing_file"].endswith("door.pdf") and any(v.endswith("แนบไฟล์แล้ว") for _k, v in info["rows"])
    # bought-in items of the trailer, where they are fitted
    last = model.steps[17]
    assert a3.items_text(last.items).startswith("ล้อหน้า / ขาตั้ง × 1; โซ่นิรภัย × 2")
    assert {"name": "แผ่นสะท้อนแสง", "qty": ""} in last.items and model.steps[6].items[0]["qty"] == 1
    html = a3.render_steps_html(model, {})
    assert "ชิ้นซื้อสำเร็จ (ไม่มีแบบ CAD)" in html and "โซ่นิรภัย" in html and ">ระบุ<" in html
    back = a3.AssemblyModel.from_dict(model.to_dict())
    assert back.steps[17].items == last.items and back.drawing_files == model.drawing_files and back.parts[0].drawing


def test_bought_in_items_as_one_line():
    items = a3.parse_items("หัวลาก Ø50 × 1; โซ่นิรภัย x 2 ;ไฟส่องป้าย;  ;สลัก M12×40 × 4\nปลั๊ก X 1")
    assert items == [{"name": "หัวลาก Ø50", "qty": 1}, {"name": "โซ่นิรภัย", "qty": 2}, {"name": "ไฟส่องป้าย", "qty": ""},
                     {"name": "สลัก M12×40", "qty": 4}, {"name": "ปลั๊ก", "qty": 1}]
    assert a3.parse_items(a3.items_text(items)) == items and a3.parse_items("") == [] and a3.parse_items("× 3") == [
        {"name": "× 3", "qty": ""}]
    assert a3.Step("ก").items == [] and a3.Step.from_dict({"title": "ก"}).items == []


def test_any_other_z3_gets_a_step_per_group(tmp_path):
    b = Z3Builder()
    top = b.obj3d("ชุดทดสอบ")
    b.obj3d("แผ่น", box=(0, 100, 0, 50, 0, 5))
    b.obj3d("เสา", box=(0, 20, 0, 20, 0, 300))
    b.component(top, "แผ่น", at=move(0, 0, 0))
    b.component(top, "เสา", n=2, at=move(10, 10, 5))
    model, check = zm.model_from_z3(write(tmp_path, b.build(), "ชุดทดสอบ.Z3"))
    assert len(model.parts) == 3 and len(model.steps) == 2 and "ช่วงงาน" not in model.note
    assert {p.group for p in model.parts} == {"แผ่น", "เสา"} and check.bodies == 0


def test_a_file_that_cannot_be_opened_says_so_in_thai(tmp_path):
    with pytest.raises(zr.Z3Error):
        zm.model_from_z3(write(tmp_path, b"not a ZW3D file" * 40, "เสีย.Z3"))
    b = Z3Builder()
    b.obj3d("ว่าง")  # a part with no box: nothing to draw
    with pytest.raises(zr.Z3Error, match="ไม่มีชิ้นที่มีตำแหน่งและขนาด"):
        zm.model_from_z3(write(tmp_path, b.build(), "ว่าง.Z3"))
    assert zm.is_z3_file("a.Z3") and zm.is_z3_file("b.z3asm") and not zm.is_z3_file("c.step")


def test_saved_and_opened_again_as_rrsasm(tmp_path):
    model, _check = zm.model_from_z3(trailer(tmp_path))
    model.save(tmp_path / "หาง.rrsasm")
    back = a3.AssemblyModel.load(tmp_path / "หาง.rrsasm")
    assert [(p.name, p.step, p.group) for p in back.parts] == [(p.name, p.step, p.group) for p in model.parts]
    assert back.note == model.note and len(back.steps) == 19


@pytest.fixture(scope="module")
def app():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_the_page_opens_a_z3_on_a_worker(app, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.pages import assembly3d as page
    from partlist_studio.ui.state import AppState

    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    try:
        w.go("install")
        tab = w.pages["install"].assembly
        assert "*.z3" in page.MODEL_FILTER and "*.z3asm" in page.MODEL_FILTER
        path = trailer(tmp_path)
        assert tab.import_files([str(path)]) is None and tab._cad_busy == path.name
        assert not tab.import_z3(str(path))  # one at a time
        end = time.monotonic() + 30
        while tab._cad_busy and time.monotonic() < end:
            app.processEvents()
            time.sleep(0.01)
        app.processEvents()
        assert not tab._cad_busy and tab.model is not None and len(tab.model.parts) == 22
        assert tab.title.text() == "รวมหางลาก ford" and "คำเตือนของแบบ" in tab.note.text()
        assert tab.parts.rowCount() == 22 and len(tab.model.steps) == 19
        tab.go(10, animate=False)
        assert tab.bom.rowCount() >= 2
        tab.go(18, animate=False)  # its bought-in items under the parts, and they can be edited
        rows = [tab.bom.item(r, 1).text() for r in range(tab.bom.rowCount())]
        assert "โซ่นิรภัย" in rows and tab.bom.item(rows.index("โซ่นิรภัย"), 0).text() == "ซ"
        tab.edit_btn.setChecked(True)
        assert tab.items_edit.text().startswith("ล้อหน้า / ขาตั้ง × 1")
        tab.items_edit.setText("หัวลาก Ø70 × 1")
        tab.items_edit.editingFinished.emit()
        assert tab.model.steps[17].items == [{"name": "หัวลาก Ø70", "qty": 1}] and "ชิ้นซื้อสำเร็จ" in tab.step_info.text()
        tab.edit_btn.setChecked(False)
        # videos / photos of the real work, kept by path, opened from the step
        clip, photo = tmp_path / "งาน.mov", tmp_path / "งาน.jpg"
        clip.write_bytes(b"x")
        from PySide6.QtGui import QColor, QImage
        img = QImage(8, 8, QImage.Format_RGB32)
        img.fill(QColor("white"))
        img.save(str(photo))
        assert tab.media_btn.text() == "แนบวิดีโอ / รูปงานจริง…"
        assert tab.attach_step_media([str(clip), str(photo), str(clip)]) == 2 and tab.media_btn.text().endswith("(2)…")
        assert tab.model.steps[17].media == [str(clip.resolve()), str(photo.resolve())]
        html = a3.render_steps_html(tab.model, {})
        assert "วิดีโองานจริงของขั้นนี้: งาน.mov" in html and photo.resolve().as_uri() in html
        back = a3.AssemblyModel.from_dict(tab.model.to_dict())
        assert back.steps[17].media == tab.model.steps[17].media
        # the drawing of a part: attached once, then opened for every part shown in it
        from PySide6.QtGui import QDesktopServices
        opened = []
        monkeypatch.setattr(QDesktopServices, "openUrl", lambda url: opened.append(url.toLocalFile()))
        pdf = tmp_path / "ประตู.pdf"
        pdf.write_bytes(b"%PDF-1.4\n")
        door = next(p for p in tab.model.parts if p.drawing == "ประตูตู้ 1_2D")
        hinge = next(p for p in tab.model.parts if p.name.startswith("บานพับ"))
        tab.show_part_card(door)
        assert tab.popup.drawing_btn.isVisibleTo(tab.popup) and tab.popup.drawing_btn.text() == "แนบแบบ 2 มิติ (PDF)…"
        assert tab.open_step_media(0) and opened == [str(clip.resolve())]
        clip.unlink()
        monkeypatch.setattr(QMessageBox, "warning", lambda *a: None)
        assert not tab.open_step_media(0) and not tab.open_step_media(5)
        assert tab.attach_step_media(clear=True) == 0
        opened.clear()
        assert tab.open_drawing(door.id, str(pdf)) and opened == [str(pdf.resolve())]
        assert tab.popup.drawing_btn.text() == "เปิดแบบ 2 มิติ" and tab.popup.redraw_btn.isVisibleTo(tab.popup)
        assert tab.open_drawing(hinge.id) and opened[-1] == str(pdf.resolve())  # the same drawing, no question
        rail = next(p for p in tab.model.parts if p.group == "คานแม่")
        tab.popup.put_away()
        from PySide6.QtWidgets import QFileDialog
        monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *a, **k: ("", ""))  # the user cancels
        assert not tab.open_drawing(rail.id) and len(opened) == 2  # its drawing (the whole) has no file: nothing
        tab.view.resize(600, 400)
        assert not tab.view.render_image(600, 400, fit=True).isNull()
        # a file that cannot be read: told, and the model stays
        said = []
        monkeypatch.setattr(QMessageBox, "warning", lambda _parent, title, text: said.append((title, text)))
        kept = tab.model
        bad = write(tmp_path, b"junk" * 100, "เสีย.Z3")
        tab.import_files([str(bad)])
        end = time.monotonic() + 30
        while tab._cad_busy and time.monotonic() < end:
            app.processEvents()
            time.sleep(0.01)
        app.processEvents()
        assert tab.model is kept and said and said[-1][0] == "นำเข้าโมเดล" and "เสีย.Z3" in said[-1][1]
    finally:
        w.state.dirty = False
        w.close()
