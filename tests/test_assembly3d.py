"""คู่มือประกอบ 3 มิติ: the model from the job, imported meshes, the order of drawing, the view and the tab."""

import os
import struct

import pytest

from partlist_studio.core import assembly3d as a3
from partlist_studio.core import install_manual as im


def _job(**kw) -> im.InstallJob:
    job = im.InstallJob(product=kw.pop("product", "flat_tray"))
    job.apply_product()
    for k, v in kw.items():
        setattr(job, k, v)
    return job


def test_tray_model_follows_the_job():
    model = a3.build_for_job(_job())
    assert "1.96 × 2.60" in model.name and model.source == "auto" and model.problems() == []
    assert [s.title for s in model.steps][1:4] == ["วางคานตามยาว (ซับเฟรม) ซ้าย–ขวา",
                                                    "ยึดคานตามยาวกับแท่นยึด – สลัก M14 เกรด 10.9", "วางคานขวาง"]
    assert model.steps[2].torque == "M14 เกรด 10.9: 150–200 Nm"
    groups = model.groups()
    assert groups[0] == a3.REF_GROUP and {"ซับเฟรม", "สลักยึด", "คานขวาง", "พื้น", "โครงกันหัว"} <= set(groups)
    rails = [p for p in model.parts if p.group == "ซับเฟรม"]
    assert len(rails) == 2 and rails[0].dims[0] == 2600 and rails[0].size == "C100×50×5 L=2600"
    cross = [p for p in model.parts if p.name == "คานขวาง"]
    xs = sorted(p.pos[0] for p in cross)
    assert len(cross) == 6 and max(b - a for a, b in zip(xs, xs[1:])) <= 600  # BEMM 5.6.3: 600 mm at most
    assert [(b.no, b.name, b.qty) for b in model.bom(3)] == [(1, "แหวนรอง Ø50×5", 12), (2, "สลัก M14 เกรด 10.9 + น็อตล็อก", 12)]
    assert model.bom_no(next(p for p in model.parts if p.name.startswith("สลัก"))) == 2
    lo, hi = model.bounds([p for p in model.parts if p.step > 0])
    assert (hi[0] - lo[0], hi[1] - lo[1]) == (2600, 1960)  # the body is as long and as wide as the job says
    shorter = a3.build_for_job(_job(cab="double", body_length=1850, bolt_size="M12"))
    assert "Double Cab" in shorter.name and shorter.steps[2].torque.startswith("M12")
    assert len([p for p in shorter.parts if p.name == "คานขวาง"]) == 4
    box = a3.build_for_job(_job(product="box_body"))
    assert any(p.name == "หลังคา" for p in box.parts) and "captive" in box.steps[2].warning and box.problems() == []
    assert a3.build_for_job(_job(product="trailer_5m")) is None


def test_faces_wind_outwards():
    np = pytest.importorskip("numpy")
    model = a3.build_for_job(_job())
    for part in model.parts:
        for piece in part.chunks():
            pts = np.array([q for f, _e in piece for q in f])
            mid = (pts.min(0) + pts.max(0)) / 2
            for f, _e in piece:
                v = np.array(f)
                assert np.cross(v[1] - v[0], v[2] - v[1]) @ (v.mean(0) - mid) > 0, part.name
    flipped = a3.Part3D("x", "c", "g", "channel", [500, 50, 100, 5], "y", [0, 0, 0], True)
    assert flipped.bounds() == ((-50, 0, 0), (0, 500, 100)) and len(flipped.chunks()) == 3


def test_imported_models(tmp_path):
    obj = tmp_path / "frame.obj"
    obj.write_text("o RAIL_1\nv 0 0 0\nv 2 0 0\nv 2 0.1 0\nv 0 0.1 0\nf 1 2 3 4\n"
                   "o RAIL_2\nv 0 1 0\nv 2 1 0\nv 2 1.1 0\nf 5 6 7\n"
                   "g CROSS-01\nv 1 0 0.2\nv 1 1 0.2\nv 1.1 1 0.2\nf -3 -2 -1\n", encoding="utf-8")
    stl = tmp_path / "bracket_3.stl"
    tri = struct.pack("<12fH", 0, 0, 1, 0.5, 0.5, 0, 0.6, 0.5, 0, 0.6, 0.6, 0, 0)
    stl.write_bytes(b"\0" * 80 + struct.pack("<I", 1) + tri)
    model = a3.model_from_files([obj, stl])
    assert [p.name for p in model.parts] == ["RAIL_1", "RAIL_2", "CROSS-01", "bracket 3"]
    assert model.groups() == ["RAIL", "CROSS", "bracket"] and [p.step for p in model.parts] == [1, 1, 2, 3]
    assert "เมตร" in model.note and model.bounds()[1][0] == 2000  # 2 units long: metres, made mm
    assert len(model.steps) == 3 and model.problems() == [] and a3.face_count(model) == 4
    assert all(any(abs(x) > 1 for x in p.explode) for p in model.parts)  # every part has somewhere to wait
    text = tmp_path / "t.stl"
    text.write_text("solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 100 0 0\nvertex 0 100 0\nendloop\nendfacet\n",
                    encoding="utf-8")
    assert a3.load_stl(text).mesh == [[[0, 0, 0], [100, 0, 0], [0, 100, 0]]]
    a3.swap_up_axis(model)
    assert model.parts[1].mesh[0][0] == [0, -0.0, 1000]
    path = tmp_path / "m.rrsasm"
    model.save(path)
    back = a3.AssemblyModel.load(path)
    assert back.to_dict() == model.to_dict()
    model.parts[0].step = 7
    model.steps.append(a3.Step("ว่าง"))
    assert len(model.problems()) == 2
    (tmp_path / "empty.obj").write_text("", encoding="utf-8")
    with pytest.raises(ValueError):
        a3.model_from_files([tmp_path / "empty.obj"])
    page = a3.render_steps_html(a3.build_for_job(_job()), {1: "a.png"}, "SO-1", {1})
    assert "ขั้นที่ 1 / 9" in page and "a.png" in page and "☑" in page and "150–200 Nm" in page


@pytest.fixture(scope="module")
def app():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_a_floor_on_its_beam_is_drawn_after_it(app):
    import numpy as np

    from partlist_studio.ui.assembly_view import Assembly3DView, draw_order

    # a beam under the near edge of a big floor: its middle is nearer to the camera than the middle of the floor
    lo = np.array([[0, 0, 100], [0, 900, 0]], dtype=float)  # floor, beam
    hi = np.array([[2600, 1000, 104], [2600, 950, 100]], dtype=float)
    view = Assembly3DView()
    view.yaw, view.pitch = 90.0, 30.0  # from the +y side, from above
    r, u, d = view._basis()
    assert ((lo + hi) / 2 @ d)[1] < ((lo + hi) / 2 @ d)[0]  # by distance alone the beam would cover the floor
    assert draw_order(lo, hi, d, r, u) == [1, 0]
    view.pitch = -30.0  # from below: the beam is in front
    r, u, d = view._basis()
    assert draw_order(lo, hi, d, r, u) == [0, 1]
    far = np.array([[0, 0, 0], [5000, 5000, 0]], dtype=float)  # two that do not meet in the picture: by distance
    assert sorted(draw_order(far, far + 10, d, r, u)) == [0, 1]


def test_view_steps_and_picking(app):
    from partlist_studio.ui.assembly_view import Assembly3DView

    model = a3.build_for_job(_job())
    view = Assembly3DView()
    view.resize(900, 600)
    view.set_model(model)
    image = view.render_image(900, 600)
    colors = {image.pixel(x, y) for x in range(0, 900, 30) for y in range(0, 600, 30)}
    assert len(colors) > 8  # something is drawn
    floor = next(p for p in model.parts if p.name == "แผ่นพื้น ซ้าย")
    picked = model.part(view.pick(450, 300))
    assert picked is not None and picked.step > 0
    view.set_step(2, animate=False)
    states = {p.name: view._state(p) for p in model.parts}
    assert states["คานตามยาว ซ้าย"] == "current" and states["แท่นยึดบนแชสซี (ของรถ)"] == "done"
    assert states["แผ่นพื้น ซ้าย"] == "" and states["ผนังหลังเก๋ง"] == "ref"
    view.ghost_later = True
    assert view._state(floor) == "ghost"
    view.set_explode(0.5)
    assert list(view._offset(floor, "normal")) == [0, 75, 300] and not view._offset(model.parts[0], "ref").any()
    view.set_step(6)  # the floor flies in
    assert view._anim == 1 and view._timer.isActive() and list(view._offset(floor, "current")) == list(floor.explode)
    view.finish_animation()
    zoom = view.zoom
    view.zoom_to([floor.id])
    assert view.zoom != zoom and abs(view.target[2] - 177) < 1
    view.hidden_groups = {"พื้น"}
    assert view._state(floor) == ""


@pytest.fixture
def window(app, tmp_path):
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    w.go("install")
    yield w
    w.state.dirty = False
    w.close()


def test_assembly_tab(window, tmp_path):
    from PySide6.QtCore import Qt

    page = window.pages["install"]
    tab = page.assembly
    assert "Single Cab" in tab.title.text() and tab.step == 0 and tab.bom.rowCount() > 10
    assert tab.groups.count() == len(tab.model.groups())  # 'ทุกกลุ่ม' in place of the vehicle
    tab.go(3, animate=False)
    assert tab.step_no.text() == "ขั้นที่ 3 / 9" and tab.bom.rowCount() == 2 and "150–200 Nm" in tab.step_info.text()
    tab.done.setChecked(True)
    assert page.job.record["asm:3"]["done"] and "1 / 9" in tab.progress.text()
    tab.go(99)
    assert tab.step == 9
    tab.go(-5)
    assert tab.step == 0 and tab.step_no.text().startswith("ภาพรวม")
    # one group alone
    tab.groups.setCurrentIndex(tab.groups.findData("คานขวาง"))
    assert "ซับเฟรม" in tab.view.hidden_groups and a3.REF_GROUP not in tab.view.hidden_groups
    tab.vehicle.setChecked(False)
    assert a3.REF_GROUP in tab.view.hidden_groups
    tab.groups.setCurrentIndex(0)
    # the job changes: the model follows (the 2.60 m tray on a double cab is still drawn - the BEMM tab says it fails)
    page.inputs["body_length"].setValue(1850)
    assert "1.85" in tab.title.text() and len([p for p in tab.model.parts if p.name == "คานขวาง"]) == 4
    assert "asm:3" in page.job.record  # the marks stay with the job
    # a part moved to another step by hand: the model is no longer rebuilt from the job
    row = next(r for r in range(tab.parts.rowCount()) if tab.parts.item(r, 1).text() == "คานท้าย")
    tab.parts.item(row, 3).setText("6")
    tab.parts.item(row, 5).setText("RRS-F-900")
    assert tab.model.source == "file" and [b.name for b in tab.model.bom(6)][0] == "คานท้าย"
    page.inputs["body_length"].setValue(2000)
    assert "1.85" in tab.title.text()
    tab.go(6, animate=False)
    assert tab.bom.rowCount() == 3 and tab.bom.item(0, 3).text() == "RRS-F-900"
    tab.step_title.setText("ปูพื้น + คานท้าย")
    tab._step_text_edited()
    saved = tab.save_model(str(tmp_path / "m.rrsasm"))
    tab.rebuild(force=True)
    assert "2.00" in tab.title.text() and tab.model.source == "auto"
    tab.open_model(saved)
    assert tab.model.steps[5].title == "ปูพื้น + คานท้าย" and tab.model.source == "file"
    pdf = tab.export_pdf(str(tmp_path / "manual.pdf"))
    assert (tmp_path / "manual.pdf").read_bytes()[:4] == b"%PDF" and pdf
    tab.export_pdf(str(tmp_path / "manual.html"))
    assert len(list((tmp_path / "manual").glob("step_*.png"))) == 9 and "ขั้นที่ 9 / 9" in (tmp_path / "manual.html").read_text("utf-8")
    # the demonstration
    tab.go(0)
    tab.toggle_play()
    assert tab._playing and tab.step == 1 and tab.play_btn.text() == "■ หยุด"
    tab.view.finish_animation()
    tab._play_next()
    assert tab.step == 2
    tab.toggle_play()
    assert not tab._playing
    # a trailer has no sample model; an imported one takes its place
    page.inputs["product"].setCurrentIndex(page.inputs["product"].findData("trailer_5m"))
    tab.rebuild(force=True)
    assert tab.model is None and tab.bom.rowCount() == 0 and "นำเข้า" in tab.note.text()
    obj = tmp_path / "t.obj"
    obj.write_text("o DRAWBAR\nv 0 0 0\nv 1500 0 0\nv 1500 100 0\nf 1 2 3\no AXLE_1\nv 0 0 300\nv 0 1800 300\nv 50 1800 300\nf 4 5 6\n",
                   encoding="utf-8")
    model = tab.import_files([str(obj)])
    assert model is tab.model and tab.parts.rowCount() == 2 and len(model.steps) == 2
    tab.view.resize(700, 500)
    assert not tab.view.render_image(700, 500, fit=True).isNull()
    tab.parts.selectRow(1)
    assert tab.view.selected == model.parts[1].id and "AXLE_1" in tab.part_info.text()
    assert tab.parts.item(0, 0).checkState() == Qt.Checked
    tab.parts.item(0, 0).setCheckState(Qt.Unchecked)
    assert model.parts[0].id in tab.view.hidden_parts


def test_imported_mesh_is_filled_and_picked(app):
    """A thin plate seen from above: its top and bottom triangles overlap on the screen and turn opposite ways. Drawn
    as one path they must not cancel each other (the floor of the real tray once showed as a hole)."""
    import numpy as np

    from partlist_studio.ui.assembly_view import Assembly3DView, triangles_path

    from PySide6.QtCore import QPointF

    twice = triangles_path(np.array([[[0, 0], [10, 0], [0, 10]], [[0, 0], [10, 0], [0, 10]]], dtype=float))
    assert twice.elementCount() == 8 and twice.contains(QPointF(2, 2))  # one over the other: still filled
    opposite = triangles_path(np.array([[[0, 0], [10, 0], [0, 10]], [[0, 0], [0, 10], [10, 0]]], dtype=float))
    assert not opposite.contains(QPointF(2, 2))  # why the view turns them all the same way first
    top = [[0, 0, 2], [1000, 0, 2], [1000, 800, 2]], [[0, 0, 2], [1000, 800, 2], [0, 800, 2]]
    bottom = [[0, 0, 0], [1000, 800, 0], [1000, 0, 0]], [[0, 0, 0], [0, 800, 0], [1000, 800, 0]]
    quad = [[0, 0, 0], [1000, 0, 0], [1000, 0, 2], [0, 0, 2]]  # a face with 4 corners: drawn as 2 triangles
    plate = a3.Part3D("m1", "แผ่นพื้น", "พื้น", "mesh", mesh=[*top, *bottom, quad], color="#A0A0A0", step=1)
    model = a3.AssemblyModel("plate", [plate], [a3.Step("พื้น")], source="file")
    view = Assembly3DView()
    view.resize(600, 400)
    view.set_model(model)
    assert view._meshes["m1"].faces == 6
    for moving in (False, True):
        view._moving = moving
        image = view.render_image(600, 400)
        r, g, b = image.pixelColor(300, 200).getRgb()[:3]
        assert abs(r - g) < 6 and abs(g - b) < 6 and 60 < r < 200, (moving, r, g, b)  # grey steel, not the background
    view._moving = False
    assert view.pick(300, 200) == "m1" and view.pick(5, 5) == ""
    view.selected = "m1"  # a selected mesh is tinted (it has no outline to thicken)
    r, g, b = view.render_image(600, 400).pixelColor(300, 200).getRgb()[:3]
    assert r > b + 15


def test_a_long_import_note_stays_short(window):
    tab = window.pages["install"].assembly
    assert "ตัวอย่าง" in tab.note.text() and not tab.note.toolTip()  # the sample's own note fits
    model = a3.build_for_job(_job())
    model.source = "file"
    model.note = " · ".join(f"บันทึกข้อที่ {n} " + "ก" * 60 for n in range(1, 9))
    model.steps.append(a3.Step("ขั้นที่ไม่มีชิ้นส่วน"))
    tab.set_model(model)
    shown = tab.note.text()
    assert "ข้อที่ 2" in shown and "ข้อที่ 3" not in shown and "ชี้เมาส์" in shown
    assert "ไม่มีชิ้นส่วน" in shown  # what is wrong with the steps is never cut away
    assert "ข้อที่ 8" in tab.note.toolTip()


def test_steps_can_be_added_removed_and_moved():
    model = a3.build_for_job(_job())
    titles = [s.title for s in model.steps]
    floor = [p.id for p in model.parts_of_step(6)]
    assert a3.insert_step(model, 3, a3.Step("ตรวจระดับ")) == {n: n + 1 for n in range(3, 10)}
    assert [s.title for s in model.steps] == [*titles[:2], "ตรวจระดับ", *titles[2:]] and model.parts_of_step(3) == []
    assert [p.id for p in model.parts_of_step(7)] == floor and len(model.problems()) == 1  # the new step is empty
    assert a3.move_step(model, 7, -1) == {7: 6, 6: 7}
    assert [p.id for p in model.parts_of_step(6)] == floor and model.steps[5].title == "ปูพื้นกระบะ"
    assert a3.move_step(model, 1, -1) == {} and a3.move_step(model, 10, 1) == {} and a3.move_step(model, 2, 3) == {}
    assert a3.remove_step(model, 3)[3] is None and [s.title for s in model.steps][:3] == titles[:3]
    bolts = len(model.parts_of_step(3))
    rails = len(model.parts_of_step(2))
    moved = a3.remove_step(model, 3)  # the bolts join the rails
    assert moved == {3: None, **{n: n - 1 for n in range(4, 10)}} and len(model.parts_of_step(2)) == rails + bolts
    pads = len(model.parts_of_step(1))
    a3.remove_step(model, 1)  # the first step: its parts join what is now the first
    assert len(model.parts_of_step(1)) == pads + rails + bolts and model.problems() == []
    one = a3.AssemblyModel("x", [a3.Part3D("a", "a", "g", step=1)], [a3.Step("เดียว")])
    assert a3.remove_step(one, 1) == {} and len(one.steps) == 1  # the last step stays
    a3.set_explode(one.parts, "ไปทางขวา (−Y)", 250)
    assert one.parts[0].explode == [0.0, -250.0, 0.0]


def test_tab_tools_for_many_parts_and_steps(window, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    page = window.pages["install"]
    tab = page.assembly
    model = tab.model
    rows = [r for r in range(tab.parts.rowCount()) if tab.parts.item(r, 1).text() == "คานขวาง"]
    for r in rows:
        tab.select_part_row(r, more=True)
    assert tab.chosen.text() == "เลือก 6 ชิ้น" and len(tab.view.marked) == 6
    assert tab.move_selected_to_step() == 0  # the overview is no step
    tab.go(5, animate=False)
    assert tab.move_selected_to_step() == 6 and tab.model.source == "file"
    assert sum(1 for p in model.parts_of_step(5) if p.name == "คานขวาง") == 6 and "ขั้นที่ 4" in tab.note.text()
    assert len(tab.selected_parts()) == 6  # the selection stays for the next action
    assert tab.set_group_selected("กรอบพื้น") == 6 and "คานขวาง" not in model.groups()
    tab.explode_dir.setCurrentText("ลง (−Z)")
    tab.explode_dist.setValue(300)
    assert tab.set_explode_selected() == 6 and tab.selected_parts()[0].explode == [0.0, 0.0, -300.0]
    assert tab.explode.value() == 100
    # the fields of a step
    tab.edit_btn.setChecked(True)
    assert tab.editor.isVisibleTo(tab) and not tab.step_info.isVisibleTo(tab)
    tab.step_fields["torque"].setText("M10 เกรด 8.8: 41–55 Nm")
    tab.step_fields["check"].setText("ระยะทแยงมุมเท่ากัน ±2 มม.")
    tab._step_fields_edited()
    assert model.steps[4].torque == "M10 เกรด 8.8: 41–55 Nm" and model.steps[4].check.startswith("ระยะทแยงมุม")
    # steps added, moved, removed; the done marks follow their steps
    tab.done.setChecked(True)
    assert page.job.record["asm:5"]["done"]
    assert tab.shift_step(-1) and tab.step == 4 and model.steps[3].torque.startswith("M10")
    assert page.job.record["asm:4"]["done"] and "asm:5" not in page.job.record
    assert tab.add_step(after=False) == 4 and model.steps[3].title == "ขั้นตอนใหม่" and len(model.steps) == 10
    assert page.job.record["asm:5"]["done"] and tab.bom.rowCount() == 0
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.Yes)
    assert tab.delete_step() and len(model.steps) == 9 and page.job.record["asm:4"]["done"]
    tab.go(4, animate=False)
    assert tab.done.isChecked() and tab.step_fields["torque"].text().startswith("M10")
    assert not tab.shift_step(9)
    pdf_note = a3.render_steps_html(model, {}, "SO-9", tab.done_steps())
    assert "41–55 Nm" in pdf_note and "ระยะทแยงมุม" in pdf_note
