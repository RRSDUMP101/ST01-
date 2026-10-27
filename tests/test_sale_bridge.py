"""Synthetic fixtures only: no real customer, credentials, URLs or production data."""
import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from partlist_studio.core.models import Part, PartList, ProjectInfo
from partlist_studio.core.production import Job, JOB_CANCELLED, job_documents
from partlist_studio.core.movements import Ledger
from partlist_studio.core.stock import StockList
from partlist_studio.core.sale_bridge import (BridgeConflict, BridgeStore, bind_partlist, bom_fingerprint,
                                             job_work_blockers, status_for_job)
from partlist_studio.sync_worker import BridgeClient, SyncError, sync_once


def command(version=1, **changes):
    value = {"schemaVersion": 1, "commandId": f"cmd-{version}", "workspace": "domestic", "orderId": "fixture-so-1",
             "productionJobId": "production:fixture-so-1", "version": version, "payloadHash": str(version % 10) * 64,
             "type": "upsert_draft", "payload": {"orderNumber": "SO-FIXTURE-1", "customerId": "fixture-customer",
             "dealId": "fixture-deal", "customerName": "Synthetic customer", "vehicle": "Fixture vehicle",
             "items": [{"lineId": "line-1", "description": "Fixture kit", "qty": "2", "unit": "set", "productId": "p-1"}],
             "due": "", "owner": "", "release": {"allowed": False, "blockers": ["รอมัดจำ"]}, "cancelled": False}}
    value.update(changes)
    return value


def mapped(store):
    job = store.jobs()[0]
    partlist = PartList(info=ProjectInfo(drawing_no="DW-FIXTURE"),
                        parts=[Part(item_no="1", part_no="PART-FIXTURE", name="Fixture", qty=3, process="ตัด/พับ")])
    job = bind_partlist(job, partlist, 2, "B1", "D1", "fixture-preparer", "fixture-evidence")
    store.save_job(job)
    return job


def released(store):
    job = mapped(store)
    c = command(2)
    c["payload"]["release"] = {"allowed": True, "blockers": [], "bomRevision": "B1", "drawingRevision": "D1",
                                "bomFingerprint": bom_fingerprint(job)}
    store.apply_command(c)
    return store.jobs()[0]


@pytest.fixture
def store(tmp_path):
    return BridgeStore(tmp_path / "bridge.sqlite3")


def test_command_replay_creates_single_job_handoff_and_event(store):
    first = store.apply_command(command())
    assert store.apply_command(command()) == first
    assert len(store.jobs()) == len(store.pending()) == 1
    job = store.jobs()[0]
    assert job.sets == 0 and not job.parts
    assert job.customer == "Synthetic customer" and job.vehicle == "Fixture vehicle"
    assert job.bridge["payload"]["items"][0]["qty"] == "2"
    assert len(job_work_blockers(job)) >= 2


def test_parallel_replay_is_atomic(store):
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(lambda _: store.apply_command(command()), range(8)))
    assert len(set(ids)) == 1
    assert len(store.jobs()) == len(store.pending()) == 1


def test_id_reuse_and_stale_versions_conflict(store):
    store.apply_command(command())
    bad = command()
    bad["payload"]["customerName"] = "Changed"
    with pytest.raises(BridgeConflict):
        store.apply_command(bad)
    old = command(commandId="different-id")
    with pytest.raises(BridgeConflict):
        store.apply_command(old)


def test_workspace_isolation_even_equal_so_ids(store):
    store.apply_command(command())
    store.apply_command(command(commandId="export-cmd", workspace="export"))
    assert len(store.jobs()) == 2
    assert len({j.bridge["key"] for j in store.jobs()}) == 2
    with pytest.raises(ValueError):
        store.apply_command(command(2), expected_workspace="export")


@pytest.mark.parametrize("edit", [lambda c: c.update(version=True), lambda c: c.update(payloadHash="bad"),
                                  lambda c: c["payload"]["items"][0].update(qty="nan"),
                                  lambda c: c["payload"].update(items=[]), lambda c: c.update(schemaVersion=2)])
def test_invalid_commands_do_not_write(store, edit):
    c = command()
    edit(c)
    with pytest.raises(ValueError):
        store.apply_command(c)
    assert not store.jobs() and not store.pending()


def test_bom_proposal_keeps_release_locked_and_preserves_source(store):
    store.apply_command(command())
    job = mapped(store)
    assert job.parts[0].required == 6
    assert job.parts[0].from_stock == 0
    assert not job.bridge["revisionApproved"]
    with pytest.raises(ValueError):
        job.record(job.parts[0], "ตัด", 2)
    with pytest.raises(ValueError):
        job_documents(job, StockList(), Ledger())
    status = status_for_job(job, 1)
    assert status["good"] is None and status["scrap"] is None and status["rework"] is None
    assert status["parts"][0]["shortage"] is None and status["materialStatus"] == "unknown"
    assert status["bomFingerprint"] == bom_fingerprint(job)


def test_exact_release_enables_partial_work_and_prior_step_limit(store):
    store.apply_command(command())
    job = released(store)
    assert job_work_blockers(job) == []
    assert job.record(job.parts[0], "ตัด", 4) == 4
    assert job.record(job.parts[0], "พับ", 9) == 4
    store.save_job(job)
    assert store.jobs()[0].parts[0].done == {"ตัด": 4, "พับ": 4}


def test_mismatched_bom_cannot_release(store):
    store.apply_command(command())
    job = mapped(store)
    c = command(2)
    c["payload"]["release"] = {"allowed": True, "blockers": [], "bomRevision": "B1", "drawingRevision": "D1",
                                "bomFingerprint": "0" * 64}
    store.apply_command(c)
    assert job_work_blockers(store.jobs()[0])


def test_same_revision_mutated_bom_invalidates_gate(store):
    store.apply_command(command())
    job = released(store)
    job.parts[0].required = 99
    assert job_work_blockers(job)
    store.save_job(job)
    assert not store.jobs()[0].bridge["releaseAllowed"]


def test_lease_expiration_fails_closed(store):
    store.apply_command(command())
    job = released(store)
    assert job_work_blockers(job, now=job.bridge["releaseAt"] + 901)


def test_cloud_cancellation_preserves_progress_and_history(store):
    store.apply_command(command())
    job = released(store)
    job.record(job.parts[0], "ตัด", 2)
    store.save_job(job)
    c = command(3)
    c["payload"]["cancelled"] = True
    store.apply_command(c)
    job = store.jobs()[0]
    assert job.status == JOB_CANCELLED and job.parts[0].done["ตัด"] == 2 and len(job.log) == 1
    with pytest.raises(ValueError):
        job.record(job.parts[0], "ตัด", 1)


def test_optimistic_concurrency_does_not_overwrite_cloud(store):
    store.apply_command(command())
    stale = store.jobs()[0]
    store.apply_command(command(2))
    stale.remark = "a stale desktop edit"
    with pytest.raises(BridgeConflict):
        store.save_job(stale)
    assert store.jobs()[0].bridge["commandVersion"] == 2


def test_save_cannot_change_owned_fields_or_release(store):
    store.apply_command(command())
    job = store.jobs()[0]
    job.customer = "replace identity"
    with pytest.raises(BridgeConflict):
        store.save_job(job)
    job = store.jobs()[0]
    job.bridge["releaseAllowed"] = True
    with pytest.raises(BridgeConflict):
        store.save_job(job)


def test_queue_persists_restart_and_lost_ack_reuses_event_id(store):
    store.apply_command(command())
    event = json.loads(store.pending()[0]["payload"])
    store.reject(event["eventId"], "network_unavailable")
    again = BridgeStore(store.path)
    assert json.loads(again.pending(now=1e20)[0]["payload"])["eventId"] == event["eventId"]
    again.acknowledge(event["eventId"])
    assert not again.pending(now=1e20)


def test_dead_letter_and_new_command_supersedes_old_queue(store):
    store.apply_command(command())
    event = store.pending()[0]
    store.reject(event["id"], "stale_command", retry=False)
    assert store.sync_summary()["dead"] == 1
    store.apply_command(command(2))
    latest = store.pending()
    assert len(latest) == 1 and json.loads(latest[0]["payload"])["commandVersion"] == 2


def test_unlinked_native_job_unchanged():
    job = Job("fixture-legacy")
    assert not job_work_blockers(job)
    assert Job.from_dict(job.to_dict()).bridge == {}


class FakeClient:
    mode = "domestic"
    def __init__(self):
        self.events = []
        self.fail_post = False
    def request(self, body=None):
        if body is None:
            return {"commands": [command()]}
        self.events.extend(body["events"])
        if self.fail_post:
            raise SyncError("network_unavailable")
        return {"accepted": [x["eventId"] for x in body["events"]], "rejected": []}


def test_poll_and_return_snapshot_round_trip(store):
    client = FakeClient()
    result = sync_once(store, client)
    assert result == {"commands": 1, "sent": 1}
    assert client.events[0]["payloadHash"] == "1" * 64
    assert client.events[0]["commandVersion"] == 1
    assert client.events[0]["status"]["externalJobId"] == store.jobs()[0].bridge["key"]
    assert sync_once(store, client)["sent"] == 0


def test_post_offline_keeps_durable_event(store):
    client = FakeClient()
    client.fail_post = True
    sync_once(store, client)
    assert len(store.pending(now=1e20)) == 1
    assert store.sync_summary()["pending"] == 1


def test_auth_configuration_blocks_without_exposing_secret(store):
    class Denied(FakeClient):
        def request(self, body=None):
            raise SyncError("auth_blocked", False)
    with pytest.raises(SyncError):
        sync_once(store, Denied())
    assert store.sync_summary()["lastError"] == "auth_blocked"
    assert not store.sync_summary()["configured"]


@pytest.mark.parametrize("origin", ["http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test?token=bad"])
def test_transport_rejects_unsafe_origins(origin):
    with pytest.raises(ValueError):
        BridgeClient(origin, "domestic", "fixture-id", "fixture-secret")


def test_pagination_reads_each_page_before_sending(store):
    class Pages(FakeClient):
        def request(self, body=None, cursor=None):
            if body is not None:
                return super().request(body)
            if cursor is None:
                return {"commands": [command()], "nextCursor": "page-2"}
            assert cursor == "page-2"
            return {"commands": [command(commandId="second", orderId="fixture-so-2", productionJobId="production:fixture-so-2")], "nextCursor": None}
    assert sync_once(store, Pages()) == {"commands": 2, "sent": 2}
    assert len(store.jobs()) == 2
    assert len({j.job_no for j in store.jobs()}) == 2  # duplicate visible SO numbers remain distinct internally


def test_failed_retry_skips_stale_authority(store):
    store.apply_command(command())
    first = store.pending()[0]
    store.reject(first["id"], "network_unavailable", retry=False)
    assert store.retry_failed() == 1
    store.reject(first["id"], "stale_command", retry=False)
    assert store.retry_failed() == 0


def test_duplicate_poll_renews_lease_without_new_event(store):
    store.apply_command(command())
    job = released(store)
    c = command(2)
    c["payload"]["release"] = {"allowed": True, "blockers": [], "bomRevision": "B1", "drawingRevision": "D1",
                                "bomFingerprint": bom_fingerprint(job)}
    count = len(store.pending())
    store.apply_command(c)
    assert len(store.pending()) == count
    assert store.jobs()[0].bridge["releaseAt"] >= job.bridge["releaseAt"]


def test_future_database_version_is_not_downgraded(tmp_path):
    path = tmp_path / "future.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA user_version=99")
    with pytest.raises(ValueError):
        BridgeStore(path)
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 99


def test_repeated_part_codes_return_one_exact_unit_record(store):
    store.apply_command(command())
    parts = PartList(parts=[Part(item_no="1", part_no="P", qty=2, unit="ชิ้น"),
                           Part(item_no="2", part_no="P", qty=3, unit="ชิ้น")])
    job = bind_partlist(store.jobs()[0], parts, 2, "B1", "D1", "fixture", "fixture")
    status = status_for_job(job, 1)
    assert len(status["parts"]) == 1 and status["parts"][0]["required"] == 10
    parts.parts[1].unit = "กก."
    with pytest.raises(ValueError):
        bind_partlist(store.jobs()[0], parts, 2, "B1", "D1", "fixture", "fixture")


@pytest.mark.parametrize("code", ["workspace_mismatch", "event_conflict", "unknown_job", "mapping_conflict", "blocked_command"])
def test_permanent_server_conflicts_do_not_retry_forever(store, code):
    class Conflict(FakeClient):
        def request(self, body=None):
            if body is None:
                return {"commands": [command()]}
            return {"accepted": [], "rejected": [{"eventId": body["events"][0]["eventId"], "code": code}]}
    sync_once(store, Conflict())
    assert not store.pending(now=1e20)
    assert store.sync_summary()["dead"] == 1
    assert store.sync_summary()["lastError"] == code
    assert store.issues()[0]["code"] == code


def test_workspace_filter_precedes_pending_limit(store):
    for i in range(55):
        store.apply_command(command(commandId=f"dom-{i}", orderId=f"dom-{i}", productionJobId=f"production:dom-{i}"))
    c = command(commandId="export-one", workspace="export", orderId="export-one", productionJobId="production:export-one")
    store.apply_command(c)
    assert len(store.pending(workspace="export")) == 1
    class Export(FakeClient):
        mode = "export"
        def request(self, body=None):
            if body is None:
                return {"commands": [c]}
            return super().request(body)
    assert sync_once(store, Export())["sent"] == 1
    assert len(store.pending(workspace="domestic")) == 50


def test_rejected_command_does_not_claim_success(store):
    class Invalid(FakeClient):
        def request(self, body=None):
            return {"commands": [command(payloadHash="invalid")]}
    sync_once(store, Invalid())
    assert store.sync_summary()["lastError"] == "command_rejected"
    assert store.sync_summary()["lastSuccess"] == ""


def test_equivalent_command_key_order_replays_safely(store):
    c = command()
    store.apply_command(c)
    store.apply_command(dict(reversed(list(c.items()))))
    assert len(store.jobs()) == 1


def test_laser_linked_post_blocked_before_any_mutation_even_if_released(store):
    from partlist_studio.core.laser import CutProgram, apply_cut, job_key
    store.apply_command(command())
    job = released(store)
    key = job_key(job.job_no, 0)
    program = CutProgram("FIXTURE-LASER", "STEEL", "STEEL", 3, 1000, 1000,
                         items={key: {"code": job.parts[0].code, "job": job.job_no}}, placements=[{"key": key}])
    ledger = Ledger()
    before = (job.to_dict(), program.to_dict(), ledger.to_dict())
    with pytest.raises(ValueError, match="transaction"):
        apply_cut(program, 1, [job], ledger)
    assert (job.to_dict(), program.to_dict(), ledger.to_dict()) == before


@pytest.mark.parametrize("counter", ["ตัด", "พับ"])
@pytest.mark.parametrize("value", [7, -1, float("nan"), float("inf"), True])
def test_offline_corrupt_progress_cannot_be_saved(store, counter, value):
    store.apply_command(command())
    job = released(store)
    previous = store.jobs()[0].to_dict()
    job.parts[0].done[counter] = value
    with pytest.raises(ValueError):
        store.save_job(job)
    assert store.jobs()[0].to_dict() == previous


def test_bilingual_max_length_sales_description_is_accepted(store):
    c = command()
    c["payload"]["items"][0]["description"] = "E" * 15000 + "\n" + "ท" * 15000
    store.apply_command(c)
    assert len(store.jobs()[0].bridge["payload"]["items"][0]["description"]) == 30001
    invalid = command(2)
    invalid["payload"]["items"][0]["description"] = "E" * 30002
    with pytest.raises(ValueError):
        store.apply_command(invalid)
