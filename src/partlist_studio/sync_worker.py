"""Outbound-only service: python -m partlist_studio.sync_worker --data-dir PATH.

Run one process per workspace. No inbound port, no library.json access and no
customer messaging. Environment holds scoped credentials; logs contain codes only.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .core.sale_bridge import BridgeStore, BridgeConflict


class SyncError(Exception):
    def __init__(self, code: str, retry: bool = True):
        super().__init__(code)
        self.code, self.retry = code, retry


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SyncError("redirect_refused", False)


class BridgeClient:
    def __init__(self, origin: str, mode: str, connector_id: str, secret: str):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("RRS_PARTLIST_URL must be an HTTPS origin")
        if parsed.path not in ("", "/") or mode not in ("domestic", "export"):
            raise ValueError("Invalid origin or workspace")
        if not connector_id.strip() or not secret.strip() or "\n" in connector_id or "\r" in connector_id:
            raise ValueError("Missing connector credentials")
        self.mode = mode
        self.url = origin.rstrip("/") + "/api/rrs/partlist/bridge?mode=" + mode
        self.headers = {"Authorization": "Bearer " + secret, "X-RRS-Connector-Id": connector_id,
                        "Accept": "application/json", "Content-Type": "application/json"}
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, body: dict | None = None, cursor: str | None = None) -> dict:
        url = self.url + ("&cursor=" + urllib.parse.quote(cursor, safe="") if cursor else "")
        request = urllib.request.Request(url, headers=self.headers,
                                         data=json.dumps(body, allow_nan=False).encode() if body is not None else None,
                                         method="POST" if body is not None else "GET")
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise SyncError("response_too_large", False)
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise SyncError("invalid_response", False)
                return value
        except urllib.error.HTTPError as exc:
            # Never log body/URL/headers; may contain customer data or credentials.
            raise SyncError("auth_blocked" if exc.code in (401, 403) else f"http_{exc.code}",
                            exc.code in (408, 429) or exc.code >= 500) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise SyncError("network_unavailable") from None
        except (ValueError, UnicodeError):
            raise SyncError("invalid_json", False) from None


def sync_once(store: BridgeStore, client: BridgeClient) -> dict:
    """Persist GET before POST. A lost acknowledgment simply replays the event ID."""
    store.meta("configured", "true")
    try:
        cursor = None
        seen_cursors = set()
        command_count = 0
        last_error = ""
        while True:
            response = client.request(cursor=cursor) if cursor else client.request()
            commands = response.get("commands")
            if not isinstance(commands, list) or len(commands) > 100:
                raise SyncError("invalid_command_batch", False)
            command_count += len(commands)
            for command in commands:
                try:
                    store.apply_command(command, expected_workspace=client.mode)
                except (ValueError, BridgeConflict):
                    store.issue("command_rejected", "ตรวจ version, workspace และ identity ของคำสั่งจาก Sale Office")
                    last_error = "command_rejected"
            cursor = response.get("nextCursor")
            if cursor is None:
                break
            if not isinstance(cursor, str) or not cursor or len(cursor) > 1000 or cursor in seen_cursors or len(seen_cursors) >= 1000:
                raise SyncError("invalid_pagination", False)
            seen_cursors.add(cursor)
        sent = 0
        for row in store.pending(workspace=client.mode):
            event = json.loads(row["payload"])
            if event["workspace"] != client.mode:
                continue  # both workers may share one office DB; credentials remain workspace-scoped
            try:
                result = client.request({"events": [event]})
                accepted = result.get("accepted")
                rejected = result.get("rejected")
                if not isinstance(accepted, list) or not isinstance(rejected, list):
                    raise SyncError("invalid_acknowledgment")
                if event["eventId"] in accepted:
                    store.acknowledge(event["eventId"])
                    sent += 1
                else:
                    rejection = next((x for x in rejected if isinstance(x, dict) and x.get("eventId") == event["eventId"]), None)
                    code = rejection.get("code") if rejection else "missing_acknowledgment"
                    # Codes are allowlisted rather than storing arbitrary server text.
                    code = code if code in {"stale_command", "invalid_status", "conflict", "unauthorized", "invalid_event", "identity_mismatch", "stale_status", "workspace_mismatch", "event_conflict", "unknown_job", "mapping_conflict", "blocked_command"} else "missing_acknowledgment"
                    store.reject(event["eventId"], code, retry=code == "missing_acknowledgment")
                    last_error = code
            except SyncError as exc:
                store.reject(event["eventId"], exc.code, exc.retry)
                last_error = exc.code
                if exc.code == "auth_blocked":
                    raise
        store.meta("lastPoll", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        if not last_error:
            store.meta("lastSuccess", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        store.meta("lastError", last_error)
        return {"commands": command_count, "sent": sent}
    except SyncError as exc:
        store.meta("lastError", exc.code)
        if not exc.retry:
            store.meta("configured", "false")
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="RRS outbound SO/Part List connector")
    parser.add_argument("--data-dir", required=True, type=Path, help="Same data directory as Part List Studio")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args(argv)
    store = BridgeStore(args.data_dir / "sale_bridge.sqlite3")
    try:
        client = BridgeClient(os.environ.get("RRS_PARTLIST_URL", ""), os.environ.get("RRS_PARTLIST_MODE", ""),
                              os.environ.get("RRS_PARTLIST_CONNECTOR_ID", ""), os.environ.get("RRS_PARTLIST_CONNECTOR_SECRET", ""))
    except ValueError:
        store.meta("configured", "false")
        store.meta("lastError", "configuration_required")
        print("configuration_required")
        return 2
    running = True
    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    failures = 0
    while running:
        try:
            summary = sync_once(store, client)
            outcome = "sync_partial" if store.sync_summary()["lastError"] else "sync_ok"
            print(f'{outcome} commands={summary["commands"]} sent={summary["sent"]}', flush=True)
            failures = 0
        except SyncError as exc:
            print(exc.code, flush=True)
            failures += 1
            if not exc.retry:
                return 3  # service operator must repair credentials/config; no repeated auth probes
            if args.once:
                return 1
        if args.once:
            return 0
        deadline = time.monotonic() + max(5, min(3600, max(args.interval, 5 * 2 ** min(failures, 8))))
        while running and time.monotonic() < deadline:
            time.sleep(min(1, deadline - time.monotonic()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
