# Sale Office to Part List Studio bridge

This phase adds a real outbound connector and native production drafts to the existing desktop application. It extends `Job` and the existing production page. It does not replace the application or change legacy document numbers/data.

The verified development baseline is `claude/app-ui-design-70lpo7` at `89e153d7d76fc0b2cf3b2e278966ce92478d5f96`. The new code has fixture validation; a live office/staging connection has not yet been tested. No production deployment, message sending or database reset was performed.

## Data ownership

| Data | Owner | Bridge behavior |
| --- | --- | --- |
| Customer/deal/SO IDs, visible SO number, original sales lines, agreed due date/owner | Sale Office | Immutable in Part List; exact IDs only, no name matching |
| Native job ID | Part List | Stable `pls:` key from workspace+SO ID, native `PLS-…` number distinct from original SO number |
| BOM mapping, part IDs, station quantities | Part List | Explicitly map the current Part List once, retain source lines and return actual per-part quantities |
| Release approval and exact drawing/BOM fingerprint | Sale Office | Desktop cannot approve its own proposal; server releases only after its payment/material/owner/revision gates |
| Legacy stock movements, cut programs | Existing desktop library | Preserved; cross-store posting for imported jobs intentionally blocked until transactional integration |

`library.json` continues to own existing jobs/stock/laser data. Imported jobs, accepted commands and outbound events are owned by an additive `sale_bridge.sqlite3` database in the same data directory. Creating a job and its response event is one SQLite transaction. Replayed command IDs must match their original payload. Newer command versions use compare-and-swap semantics; a stale desktop editor reloads rather than overwriting the worker.

## Configure staging

Use a separate staging data directory first. Do not copy a live database into Git. The bridge only initiates HTTPS requests; no office port or database is exposed.

Set these environment variables using the operating system service's secret store:

- `RRS_PARTLIST_URL`: verified Sale Office HTTPS origin, without a path/query.
- `RRS_PARTLIST_MODE`: `domestic` or `export`.
- `RRS_PARTLIST_CONNECTOR_ID`: the registered office connector identity.
- `RRS_PARTLIST_CONNECTOR_SECRET`: the secret scoped to this workspace. It corresponds to Sale Office's `RRS_PARTLIST_DOMESTIC_SECRET` or `RRS_PARTLIST_EXPORT_SECRET`.

The installed `partlist-sync` command is a console entry point. From source:

```bash
PYTHONPATH=src python -m partlist_studio.sync_worker --data-dir /path/to/staging-partlist --once
PYTHONPATH=src python -m partlist_studio.sync_worker --data-dir /path/to/staging-partlist --interval 30
```

On Windows, set `PYTHONPATH=src` in the service environment or install the package and use `partlist-sync --data-dir "C:\…"`. The path must be the same directory used by the desktop's `AppState.data_dir()`. IT should register the repeating command with the OS service manager/Task Scheduler using the office user account, automatic restart on transient failures, and a private working directory. A 401/403 exits with `auth_blocked`; repair configuration instead of repeatedly probing credentials. This service installation is **not performed by this PR**.

One process serves one workspace. Both may share the same office database, but each only sends events for its configured workspace. Run just one connector identity per workspace; avoid parallel instances for the same identity. SQLite locking and server event IDs still protect repeat delivery.

## Staff workflow

1. Sales confirms an SO in Sale Office. Its server-side workflow creates the production draft/handoff and a command.
2. The office worker polls `/api/rrs/partlist/bridge?mode=…`; it stores the command, native draft and response atomically even when the desktop is closed.
3. Open **Sale Office → งานผลิต**. It shows original SO lines, responsible owner/due date, pending/failed queue counts and last successful sync. Unknown set count remains unknown, not `1`.
4. Engineering opens the relevant Part List, selects the imported SO, explicitly enters the number of sets, drawing revision, BOM revision, preparer and evidence, then selects **ผูก Part List และส่งตรวจ**. This is a proposal and does not approve/release production. No stock reservation is invented.
5. An authorized reviewer in Sale Office approves the exact returned revisions and `bomFingerprint`, and checks the SO-specific deposit, material readiness, owner and due date.
6. The next command carries release authority. The existing production page can record real per-part progress. Customer/source/quantity fields and deletion are protected for bridged jobs; an unapproved BOM cannot be used to record production.
7. Work saves as a native job plus durable response event. When offline, saved events stay in the queue with the same IDs and retry later. A lost acknowledgment cannot double-count quantities.

Release authority expires locally after **15 minutes** without a successful current-command poll. GET must keep returning latest active commands even after their acknowledgment; replay refreshes the lease without creating duplicate work. A changed BOM fingerprint, cancellation or changed source spec blocks affected work. Changing an already started BOM requires an explicit impact workflow; this phase blocks automatic remapping rather than discarding completed quantities.

## Protocol

GET sends `Authorization: Bearer <scoped secret>` and `X-RRS-Connector-Id`. It receives `{commands, nextCursor}` and follows `cursor` until null.

Commands use `schemaVersion:1`, `type:upsert_draft`, `commandId`, `workspace`, `orderId`, `productionJobId`, `version`, an opaque server `payloadHash`, and `payload` containing SO fields/items, `cancelled`, and `release`. Release binds `bomRevision`, `drawingRevision` and `bomFingerprint`.

POST sends `{events:[{eventId,commandId,commandVersion,payloadHash,workspace,orderId,productionJobId,status}]}`. The server returns `{accepted:[eventId],rejected:[{eventId,code}]}`. The local `status.sourceVersion` is monotonic per job, independent of the cloud command version. HTTP redirects are rejected so bearer credentials cannot be forwarded to another origin. Timeouts and response size are bounded; logs contain error codes and counts, not payloads/secrets.

Status includes native job ID, revisions/fingerprint, actual per-part required/reserved/completed/station counts and their units, blockers and observation time. **Material readiness stays unknown** until the dedicated stock/material gate is verified. Shortage, aggregate finished kits, scrap, rework and ETA remain null where the native model cannot establish them. Do not interpret absence as zero.

Failures retry with bounded backoff. After ten attempts they remain in the visible failed queue. The **ลองส่งรายการที่ล้มเหลวใหม่** button calls `BridgeStore.retry_failed()` and only requeues transient failures bound to the current command; stale authority and invalid payloads are never blindly retried. A newer command supersedes pending old events and creates a fresh snapshot. Queued failures and identity/version conflicts remain auditable.

## Phase boundary and rollback

This bridge does not claim a complete QR scan service, simultaneous reservation across all SOs, raw-material purchasing, QC, Express posting or delivery integration. Imported-job stock posting and laser-result posting are blocked before mutation because a single transaction across SQLite and legacy JSON does not exist yet. Existing unlinked workflows remain available. This avoids a failed operation leaving stock/cut records changed without matching job progress.

To roll back, stop the connector service first, disable its credentials on the server and preserve both `library.json` and `sale_bridge.sqlite3` (including a consistent SQLite backup). Revert application code only after reviewing in-flight work. Old versions will not display SQLite-owned imported jobs; do not delete the bridge database or copy them into legacy JSON without reconciliation. No destructive down migration is needed; the database uses additive tables, version `1`, and rejects a future version rather than downgrading it.

## Validation and acceptance

Local automated tests cover duplicate and concurrent command replay, conflicting IDs/versions, workspace separation, invalid numbers, atomic job+event creation, exact BOM approval, missing deposit/release, expiry, partial station progress capped by upstream output, cancellation preserving history, stale editor conflicts, offline queue recovery, bounded retry, unsafe origins, paginated polling, local/source field protection, and legacy UI preservation. See `tests/test_sale_bridge.py` and `tests/test_sale_bridge_ui.py`.

Before production, perform a staging test with one synthetic SO and the real office service: confirm the shared endpoint contract, scoped credentials, existing stock/BOM code mappings, OS service operation while browsers/desktops are closed, UI refresh, offline replay, cancellation/revocation and one actual station update. Validate authorized reviewer roles and backup/restore. Production connectivity, actual office acceptance, service installation and the 90% business automation target remain **BLOCKED / NOT RUN**, not inferred from fixture tests.

## Desktop permission boundary

The existing Part List desktop has no multi-user login/RBAC. This connector does not invent one: local mapping/progress uses the trusted OS user account. Treat the office machine/data directory as a restricted workstation. Server-side connector credentials are workspace-scoped and cannot approve finances, revisions or lifecycle transitions through the bridge endpoint. The authenticated Sale Office UI owns those approvals. Adding per-operator authentication and signatures to the native shop-floor workflow remains later work; the preparer name entered locally is attribution, not proof of identity.

For a consistent SQLite backup while the service is running, use SQLite's backup API or stop both the worker and desktop first. Do not copy only the `.sqlite3` file while ignoring its WAL. Existing `library.json` and the bridge database must both be retained for reconciliation; never drop tables to undo this feature.
