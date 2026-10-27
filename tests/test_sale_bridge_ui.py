"""Bridge UI writes preserve legacy data and cannot bypass production gates."""
import hashlib
import json
import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
QtWidgets = pytest.importorskip("PySide6.QtWidgets")

from partlist_studio.core.models import Part, PartList
from partlist_studio.core.movements import DocLine, StockDoc
from partlist_studio.core.production import Job
from partlist_studio.ui.pages.production import ProductionPage
from partlist_studio.ui.pages.sale_bridge import SaleBridgePage
from partlist_studio.ui.state import AppState


@pytest.fixture(scope="module")
def app():
    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    application.setOrganizationName("RRS-tests")
    application.setApplicationName("PartListStudio-tests")
    yield application


def command(version=1, owner="planning"):
    payload = {"orderNumber": "SO-FIXTURE-1", "customerId": "fixture-company", "dealId": "fixture-deal",
               "customerName": "Fixture customer", "vehicle": "Fixture vehicle",
               "items": [{"lineId": "fixture-line", "description": "Fixture kit", "qty": "2", "unit": "set",
                           "productId": "fixture-product"}], "due": "", "owner": owner,
               "release": {"allowed": False, "blockers": ["รอตรวจแบบ"]}, "cancelled": False}
    return {"schemaVersion": 1, "type": "upsert_draft", "commandId": f"fixture-command-{version}",
            "workspace": "domestic", "orderId": "fixture-order", "productionJobId": "production:fixture-order",
            "version": version, "payloadHash": hashlib.sha256(json.dumps(payload).encode()).hexdigest(),
            "payload": payload}


class Actions:
    def __init__(self):
        self.errors = []

    def error(self, title, text):
        self.errors.append((title, text))

    def go(self, page):
        pass


def linked_state(tmp_path):
    state = AppState(tmp_path)
    state.bridge_store.apply_command(command())
    state.refresh_bridge_jobs()
    return state


def test_linked_jobs_stay_out_of_legacy_library(app, tmp_path):
    state = linked_state(tmp_path)
    state.jobs.append(Job("LEGACY-FIXTURE", customer="Unlinked fixture"))
    initial_version = state.bridge_store.jobs()[0].bridge["localVersion"]
    assert state.save_jobs()
    assert state.save_jobs()
    saved = json.loads((tmp_path / "library.json").read_text())
    assert [job["job_no"] for job in saved["jobs"]] == ["LEGACY-FIXTURE"]
    assert state.bridge_store.jobs()[0].bridge["localVersion"] == initial_version
    reopened = AppState(tmp_path)
    assert len(reopened.jobs) == 2
    assert sum(bool(j.bridge) for j in reopened.jobs) == 1


def test_stale_save_reloads_without_overwrite(app, tmp_path):
    state = linked_state(tmp_path)
    errors = []
    state.persistence_error.connect(errors.append)
    old_job = state.jobs[0]
    state.bridge_store.apply_command(command(2, "engineering"))
    old_job.bridge["revisionEvidence"] = "stale unsaved edit"
    assert not state.save_jobs()
    assert len(errors) == 1
    assert state.jobs[0].bridge["commandVersion"] == 2
    assert state.jobs[0].bridge["payload"]["owner"] == "engineering"
    assert state.jobs[0].bridge["revisionEvidence"] != "stale unsaved edit"


def test_production_source_fields_and_delete_are_protected(app, tmp_path):
    state = linked_state(tmp_path)
    actions = Actions()
    page = ProductionPage(state, actions)
    job = state.jobs[0]
    assert all(not widget.isEnabled() for widget in (page.customer, page.due, page.status, page.sets))
    assert page.sets.value() == 0
    assert all(not widget.isEnabled() for widget in page.work_buttons)
    page.customer.setText("Attempted override")
    page._info_edited()
    page._sets_edited(9)
    page.remove_job()
    assert job.customer == "Fixture customer" and job.sets == 0
    assert len(state.jobs) == 1 and actions.errors
    page.deleteLater()


def test_bom_mapping_is_a_review_proposal(app, tmp_path):
    state = linked_state(tmp_path)
    state.partlist = PartList(parts=[Part(part_no="FIXTURE-PART", name="Fixture part", qty=3)])
    actions = Actions()
    page = SaleBridgePage(state, actions)
    page.sets.setValue(2)
    page.bom_revision.setText("B1")
    page.drawing_revision.setText("D1")
    page.reviewer.setText("Fixture planner")
    page.evidence.setPlainText("Fixture review document")
    page._bind()
    assert not actions.errors
    job = state.bridge_store.jobs()[0]
    assert job.parts[0].required == 6
    assert not job.bridge["revisionApproved"]
    assert not job.bridge["releaseAllowed"]
    assert state.bridge_store.sync_summary()["pending"] >= 1
    page.deleteLater()


def test_linked_stock_post_is_blocked_before_mutation(app, tmp_path):
    state = linked_state(tmp_path)
    job = state.jobs[0]
    doc = StockDoc("FR", job=job.job_no, lines=[DocLine("FIXTURE-PART", "Fixture part", 2, "pcs")])
    before = state.ledger.to_dict()
    with pytest.raises(ValueError, match="ช่วง 2"):
        state.post_doc(doc)
    assert state.ledger.to_dict() == before
    assert not state.stock_sources
