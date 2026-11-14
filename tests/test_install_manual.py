"""คู่มือติดตั้ง Ford Ranger Super Duty: rules from the BEMM, the procedure, the file and the page."""

import os

import pytest

from partlist_studio.core import install_manual as im


def _job(**kw) -> im.InstallJob:
    job = im.InstallJob(product=kw.pop("product", "flat_tray"))
    job.apply_product()
    for k, v in kw.items():
        setattr(job, k, v)
    return job


def _status(findings, rule):
    return next(f.status for f in findings if f.rule == rule)


def test_rrs_flat_tray_fits_single_cab_only():
    # กระบะพื้นเรียบ 1.96 × 2.60 ม. of the RRS deck
    single = im.check(_job(cab="single"))
    assert not [f for f in single if f.status == im.FAIL]
    assert im.rear_overhang(_job(cab="single")) == 2600 - 1265
    for cab in ("super", "double"):
        f = im.check(_job(cab=cab))
        assert _status(f, "length") == im.FAIL and _status(f, "overhang") == im.FAIL
    # a wider tray is fine on the double cab width but not on the single cab
    assert _status(im.check(_job(cab="single", body_width=2000)), "width") == im.FAIL
    assert _status(im.check(_job(cab="double", body_width=2000, body_length=1800)), "width") == im.PASS


def test_overhang_grows_with_a_bigger_cab_gap():
    assert im.rear_overhang(_job(cab_gap=60)) == im.rear_overhang(_job()) + 32
    assert _status(im.check(_job(cab_gap=20)), "cab_gap") == im.FAIL


def test_centre_of_gravity_and_axle_loads():
    assert im.cg_limits(700) == (1965, 3255, 630, 130)
    assert im.cg_limits(1500) == (1965, 3350, 530, 65)
    f = im.check(_job(cg_x=1800, cg_z=700, cg_y=-100))
    assert {_status(f, r) for r in ("cg_x", "cg_z", "cg_y")} == {im.FAIL}
    assert _status(im.check(_job()), "weigh") == im.WARN  # not weighed: asked for
    job = _job(kerb_front=1350, kerb_rear=950, passengers=2, body_mass=400, payload=1000, cg_x=2600)
    front, rear = im.axle_loads(job)
    assert round(front + rear) == 1350 + 950 + 1400 + 150  # 2 people at 75 kg
    assert rear == pytest.approx(950 + 1400 * 2600 / 3270 + 70, abs=0.1)
    f = im.check(_job(kerb_front=1400, kerb_rear=1100, payload=2500))
    assert _status(f, "gvm") == im.FAIL and _status(f, "rgawr") == im.FAIL


def test_mounting_rules():
    f = im.check(_job(bolt_size="M10", bolt_grade="10.9"))
    assert _status(f, "bolts") == im.FAIL
    assert _status(im.check(_job(bolt_size="M12", bolt_grade="8.8")), "bolts") == im.FAIL
    f = im.check(_job(bolt_size="M12", bolt_grade="10.9"))
    assert _status(f, "bolts") == im.PASS and any(x.rule == "bolts_m14" for x in f)
    assert im.torque_for("M14", "10.9") == (200, 150)
    f = im.check(_job(frame_holes=2, frame_hole_dia=18, holes_in_vertical_line=3))
    assert _status(f, "hole_dia") == im.FAIL and _status(f, "hole_line") == im.FAIL
    assert _status(im.check(_job(product="box_body")), "flex_mounts") == im.WARN


def test_lamps_and_parking_sensors():
    f = im.check(_job(lamp_low=450, lamp_high=1250, lamp_from_edge=420, plate_height=1350))
    assert {_status(f, r) for r in ("lamp_low", "lamp_high", "lamp_edge", "plate")} == {im.FAIL}
    f = im.check(_job(sensor_x=300, sensor_y=300, sensor_z=200))
    assert {_status(f, r) for r in ("sensor_x", "sensor_y", "sensor_z")} == {im.FAIL}
    assert not any(x.rule.startswith("sensor_") for x in im.check(_job(parking_sensors=False)))


def test_trailer_towing():
    job = _job(product="trailer_5m")
    assert job.tow_hitch == "4.5T"
    f = im.check(job)
    assert _status(f, "atm") == im.PASS and _status(f, "mirrors") == im.WARN
    assert not any(x.rule == "width" for x in f)  # the vehicle body rules are not for a trailer
    job.tow_hitch, job.trailer_load = "3.5T", 3000
    assert _status(im.check(job), "atm") == im.FAIL
    job.tow_hitch = ""
    assert _status(im.check(job), "hitch") == im.FAIL
    job = _job(product="trailer_5m", kerb_front=1300, kerb_rear=900, payload=1500, trailer_load=3500)
    assert _status(im.check(job), "gcm") == im.FAIL
    assert _status(im.check(_job(product="trailer_5m", trailer_led_ma=300)), "led") == im.WARN


def test_procedure_checklist_and_file(tmp_path):
    tray = [s.id for s in im.procedure(_job())]
    assert "mount_bolt" in tray and "fuel_filler" in tray and "tow_hitch" not in tray and "mount_flex" not in tray
    assert "mount_flex" in [s.id for s in im.procedure(_job(product="box_body"))]
    assert "fuel_filler" not in [s.id for s in im.procedure(_job(tub_removed=False))]
    trailer = [s.id for s in im.procedure(_job(product="trailer_5m"))]
    assert "tow_wiring" in trailer and "mount_bolt" not in trailer
    assert len({s.id for s in im.STEPS}) == len(im.STEPS) and all(s.phase in im.PHASES for s in im.STEPS)

    job = _job(job_no="SO-001", customer="ทดสอบ")
    batt = next(s for s in im.STEPS if s.id == "rcv_batt")
    im.mark(job, "rcv_batt", value="12.6", by="ช่างเอ")
    assert im.step_state(job, batt) == im.FAIL  # OCV below 12.75 V
    im.mark(job, "rcv_batt", value="12.8", done=True)
    assert im.step_state(job, batt) == im.PASS and im.progress(job)[0] == 1
    path = tmp_path / "job.rrsinst"
    job.save(path)
    back = im.InstallJob.load(path)
    assert back == job and back.record["rcv_batt"]["by"] == "ช่างเอ"
    page = im.render_html(back)
    assert "SO-001" in page and "ไม่ผ่าน 0" in page and "☑" in page and "12.8" in page


@pytest.fixture
def window(tmp_path):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    QtWidgets = pytest.importorskip("PySide6.QtWidgets")
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    from partlist_studio.ui import theme
    from partlist_studio.ui.main_window import MainWindow
    from partlist_studio.ui.state import AppState

    app.setStyleSheet(theme.STYLE_SHEET)
    w = MainWindow(AppState(data_dir=tmp_path / "data"))
    yield w
    w.state.dirty = False
    w.close()


def test_install_page(window, tmp_path):
    from PySide6.QtCore import Qt

    window.go("install")
    page = window.pages["install"]
    assert page.ftable.rowCount() == len(page.findings) and "✔" in page.verdict.text()
    page.inputs["cab"].setCurrentIndex(page.inputs["cab"].findData("double"))  # the 2.60 m tray on a double cab
    assert page.job.cab == "double" and page.verdict.text().startswith("❌")
    page.inputs["product"].setCurrentIndex(page.inputs["product"].findData("trailer_5m"))
    page.apply_product()
    assert page.job.body_length == 5000 and page.job.tow_hitch == "4.5T"
    assert page.stable.rowCount() == len(im.procedure(page.job))
    row = next(r for r in range(page.stable.rowCount()) if page.stable.item(r, 0).data(Qt.UserRole) == "rcv_batt")
    page.stable.item(row, 5).setText("12.5")
    assert page.stable.item(row, 7).text() == im.FAIL
    page.stable.item(row, 6).setCheckState(Qt.Checked)
    assert page.job.record["rcv_batt"]["done"] and "ทำแล้ว 1 /" in page.progress.text()
    page.inputs["job_no"].setText("SO-77")
    page.save_job(str(tmp_path / "a.rrsinst"))
    page.new_job()
    assert page.job.record == {}
    page.open_job(str(tmp_path / "a.rrsinst"))
    assert page.job.job_no == "SO-77" and page.inputs["job_no"].text() == "SO-77"
    pdf = page.export("pdf", str(tmp_path / "steps.pdf"))
    assert (tmp_path / "steps.pdf").read_bytes()[:4] == b"%PDF" and pdf
    page.export("html", str(tmp_path / "steps.html"))
    assert "SO-77" in (tmp_path / "steps.html").read_text(encoding="utf-8")
