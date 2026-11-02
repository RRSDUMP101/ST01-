# Backend design – stock-qc on Cloudflare, recorded like RRS Sale Office

The owner asked that the backend "records data the way Sales Office and CRM do". Sales Office (RRSDUMP101/RRS-Sale-Office)
is a Cloudflare Worker with **D1** (SQL, business records + audit, append-only migrations), **R2** (file bytes),
**session login** (bcrypt users, `__Host-` HMAC session cookie, roles/permissions, MFA, rate limits, same-origin checks,
auth audit) and a **daily Google Drive backup** (OAuth refresh token, off by default). CRM data (customers, deals, SOs)
lives in Sales Office; the CRMBOT repository has no code yet. stock-qc follows the same stack and never copies customer
context: it keeps Sales Office IDs only and is fed by the existing Sales Office → Part List bridge.

Source facts read from Sales Office: `lib/rrs/auth.ts`, `lib/rrs/runtime.ts`, `lib/rrs/server.ts` (commit with workspace
revision/token CAS in one `db().batch`), `db/schema.ts`, `.env.example`, branch `codex/rrs-workflow-partlist-20261027`
(`lib/rrs/partlist-bridge.ts`, `partlist-store.ts`, `operations-schema.ts`, `drizzle/0012_partlist_bridge.sql`,
`docs/rrs-partlist-implementation.md`).

## Layout

```
web/stock-qc/worker/
  wrangler.toml          name rrs-stock-qc; D1 binding DB, R2 binding BUCKET, assets ../dist; cron for backup/sync.
                         database_id / bucket names are LOCAL PLACEHOLDERS – never a production id.
  migrations/0001_init.sql  append-only (later changes = 0002_…, never edit an applied file)
  src/index.js           routes; imports the engine files (src/engine/*.js in order.json) for their side effects
  src/runtime.js         env access, HttpError, json(), security headers
  src/security.js        sha256/hmac/randomToken/constant-time compare/body limits/client IP/security events
  src/auth.js            login/logout/session/password change/user credentials (Sales Office pattern)
  src/ledger.js          server ledger: isolate cache + D1 CAS append + catch-up + R2 snapshots
  src/files.js           R2 upload/download for QC photos, certificates, imported files
  src/backup.js          Google Drive backup of commits (JSONL parts + manifest), off unless SQ_DRIVE_BACKUP_ENABLED=true
  src/sales-bridge.js    connector to Sales Office (pull SO production commands, push material/QC status), off by default
  package.json + package-lock.json   bcryptjs (same as Sales Office), dev: wrangler, miniflare
  test/*.mjs             Miniflare D1/R2 tests (no Cloudflare account needed)
```

## Data in D1 (0001_init.sql)

| table | purpose |
| --- | --- |
| `sq_commits(seq INTEGER PRIMARY KEY, request_id TEXT UNIQUE NULL, kind, at, by, via, summary, payload_hash, prev, hash UNIQUE, effects TEXT)` | the source of truth: one row per engine commit, hash chained. A request id appears once. |
| `sq_records(tbl TEXT, id TEXT, data TEXT, seq INTEGER, PRIMARY KEY(tbl,id))` | readable current rows (like `rrs_records(workspace,id,kind,data)` in Sales Office) written from the commit effects in the SAME batch; rebuildable from `sq_commits` |
| `sq_snapshots(seq INTEGER PRIMARY KEY, r2_key, hash, created_at)` | state snapshots in R2 for fast cold start (every 500 commits) |
| `sq_app_users(username PK, password_hash, active, created_at, updated_at, must_change)` | login credentials only; roles/warehouses live in the engine `users` table (accountId = username) |
| `sq_sessions(id PK = hmac(token), username, created_at, expires_at, auth_version, revoked_at)` | 8 h sessions, cookie `__Host-sq_session` |
| `sq_auth_audit(id, time, ip, event)`, `sq_auth_limits(id, count, expires_at)`, `sq_security_events(...)` | as Sales Office |
| `sq_files(id = sha256 PK, r2_key, name, type, size, uploaded_by, uploaded_at)` | R2 metadata; engine rows keep the file id |
| `sq_backup_runs(...)` | Drive backup runs (status, commits, bytes, error, started/finished) |
| `sq_bridge_commands(workspace, command_id, job_id, version, payload_hash, payload, received_at, applied_seq, status)` / `sq_bridge_events(workspace, event_id PK…, event_hash, job_id, source_version, sent_at, result)` / `sq_bridge_health(workspace PK, last_pull_at, last_push_at, last_error)` | connector journal with Sales Office |

## Writing (same guarantees as Sales Office's revision/token CAS)

`POST /api/command {kind, payload, requestId}` with session + same-origin:
1. the isolate keeps `state` in memory; catch up: `SELECT … FROM sq_commits WHERE seq > ? ORDER BY seq` (cold isolate: newest
   snapshot from R2 + commits after it), verifying every hash with `RRS.core.verifyCommit`.
2. `RRS.core.prepare(state, command, {now, user: engineUserId, via: username})` – engine user = the `users` row whose
   accountId equals the session username (none → 403, except `system.bootstrap` by the owner account when no users exist).
3. `db.batch([INSERT INTO sq_commits … , INSERT/UPSERT/DELETE sq_records for each effect])` – one atomic batch.
   A PRIMARY KEY/UNIQUE conflict on seq means someone else committed first → catch up and prepare again (max 5).
   A UNIQUE conflict on request_id → return `{ok:true, duplicate:true}` (the same request applied once).
4. respond with the prepare result (`{ok, commit, warnings, result}` or `{ok:false, errors}`).
`GET /api/commits?after=N` (session) → `{commits, more}` (≤ 500 commits / ≤ 4 MB per page) for the page's RemoteLedger.
The browser never writes commits itself in server mode; the Worker is the only writer.

## Login (copied behaviour of Sales Office `lib/rrs/auth.ts`)

- owner account from env `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` (bcrypt cost 12–16), other accounts in `sq_app_users`.
- `SESSION_SECRET` ≥ 32 chars; session id stored as HMAC(token); `auth_version` = HMAC(username:hash) so a password change
  ends old sessions; generic Thai error on failure; rate limit 10/IP/15 min and 100 global; audit every attempt.
- cookie `__Host-sq_session=…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`; `requireSameOrigin` on every
  POST (Origin must equal the request origin; `Sec-Fetch-Site: cross-site` refused).
- `POST /api/auth/login {username, password}`, `POST /api/auth/logout`, `GET /api/auth/session` → `{username, user (engine row) | null, owner}`,
  `POST /api/auth/password {current, next}`, admin: `POST /api/admin/credentials {username, password, active}` (engine perm users.manage).
- MFA: not in this round (Sales Office has TOTP – listed as a follow-up, the owner account must keep a strong password).

## Files (R2)

`POST /api/files` (session, same-origin, ≤ 10 MB, image/jpeg|png|webp, application/pdf, text/csv, xlsx) → stored at
`stockqc/files/<sha256>` with metadata in `sq_files`; `GET /api/files/<sha256>` (session) streams it back with
`Content-Disposition: attachment` for non-images and `X-Content-Type-Options: nosniff`.

## Google Drive backup (like Sales Office `drive-backup.ts`, simplified)

Env (names only, values in Worker secrets): `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
`GOOGLE_DRIVE_REFRESH_TOKEN`, `SQ_DRIVE_BACKUP_FOLDER_ID`, `SQ_DRIVE_BACKUP_ENABLED` (default off).
Daily cron (and a manual run by users with backup.export): export all commits as JSONL parts ≤ 4 MB + `manifest.json`
(seq range, head hash, sha256 of each part) into a dated folder; record the run in `sq_backup_runs`. Restore check:
the page's "สำรองและกู้คืน" verifies a downloaded backup with `RRS.reports.verifyBackup`.

## Sales Office connector (off by default)

Env: `SQ_SALES_URL` (https origin of Sales Office), `SQ_SALES_CONNECTOR_ID`, `SQ_SALES_DOMESTIC_SECRET`,
`SQ_SALES_EXPORT_SECRET` (different values), `SQ_SALES_BRIDGE` = `off` (default) | `pull` | `pull_push`.
Protocol (exactly Sales Office's): `GET {url}/api/rrs/partlist/bridge?mode=domestic|export[&cursor=…]` with
`Authorization: Bearer <secret>` and `X-RRS-Connector-Id` → `{commands:[{schemaVersion:1, commandId, workspace, orderId,
productionJobId, version, type:'upsert_draft', payloadHash, payload:{orderNumber, customerId, dealId, customerName, vehicle,
items:[{lineId, description, qty, unit, productId}], due, owner, release:{allowed, blockers, drawingRevision, bomRevision,
bomFingerprint}, cancelled}}], nextCursor, serverTime}`; `POST` same URL `{events:[≤20 {eventId, commandId, commandVersion,
payloadHash, workspace, orderId, productionJobId, status:{externalJobId, sourceVersion, bomRevision, drawingRevision,
bomFingerprint, revisionApproved, revisionEvidence, materialStatus 'unknown'|'ready'|'short', parts:[{partId, required,
reserved, shortage, unit, completed?}], station, good, scrap, rework, blockers[], eta, observedAt}}]}` → `{accepted, rejected}`.
- pulled commands become engine commands `sales.syncJob` (new engine module `src/engine/sales.js`): a job keyed by
  `workspace + productionJobId` with orderId/orderNumber/customerId/dealId kept exactly; SO lines are NOT turned into stock
  lines by name – the planner maps the job to an approved BOM product (`sales.mapJob`); until then the job shows the blocker.
- pushed status: materialStatus `ready` only when every job line is reserved in full and nothing is short (Sales Office
  validates the same rule); `revisionApproved` only from an APPROVED BOM rev; QC facts are reported, never approvals.
- Sales Office accepts ONE connector per workspace (links/health are per connector). The ST01 desktop app has a connector
  for the same bridge (branch codex/so-partlist-bridge-20261027). Enable `pull_push` in stock-qc only when the desktop
  connector is off for that workspace – decision ค-10. `pull` reads only and never posts.
- Domestic and Export stay apart: separate secrets, `workspace` kept on every job, no joining by customer name.

## Staging defaults

`SQ_SALES_BRIDGE=off`, `SQ_DRIVE_BACKUP_ENABLED` unset, no outbound messages of any kind. Never point a copied deployment
at production Sales Office or production D1/R2. `.dev.vars` is git-ignored; `.dev.vars.example` lists names only.
