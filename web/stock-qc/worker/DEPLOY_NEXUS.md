# Nexus Part Terminal deployment

## Independent accounts

https://nexuspart-terminal.com uses its own Nexus accounts. It does not use Sales Office login, passwords or sessions. SQ_AUTH_PROVIDER=local; remove SALES_AUTH and SQ_AUTH_ORIGIN from this deployment.

The initial owner username is Adbeamlee. Login names are case-insensitive; sessions retain the canonical stored name. The owner password is held only as a bcrypt cost-12 hash in ADMIN_PASSWORD_HASH, with a separate randomly generated SESSION_SECRET. Never put plaintext passwords, hashes or session secrets in source, deployment notes, shell arguments or logs. The initial password is supplied by the owner outside this repository.

Employees are created in **ผู้ใช้และสิทธิ์**. Account passwords are stored as bcrypt hashes in sq_app_users. New/reset employee passwords are temporary and must be changed before recording stock transactions. Employee passwords require at least 12 characters and at most 72 UTF-8 bytes. Only the owner or a full administrator manages login credentials. Turning off an account or changing its password revokes existing sessions.

## Permissions

Each stock user has roles, warehouse scope and optional per-action permissions. Missing/null permissions retain role defaults for existing records; an explicit empty permission map grants no actions. Full administrators retain all actions. Non-admin delegated user managers cannot grant actions or warehouse access beyond their own, modify administrators or reset login credentials. Position text does not grant authority.

Action permissions are checked by the server engine for every command, not only by disabled buttons. Active enrolled users still share the stock ledger read model; these action grants are not field-level confidentiality controls. Preserve stock validation, warehouse limits, approval separation, audit history and last-administrator protection.

## Resources and configuration

- Worker: nexuspart-terminal
- Custom Domain: nexuspart-terminal.com
- D1 binding DB: nexuspart-terminal
- Private R2 binding BUCKET: nexuspart-terminal-files
- SQ_AUTH_PROVIDER=local, SQ_ENV=production, SQ_SNAPSHOT_EVERY=500
- SQ_SALES_BRIDGE=off, SQ_DRIVE_BACKUP_ENABLED=true, SQ_SHEETS_EXPORT_ENABLED=true
- Secret bindings: ADMIN_USERNAME, ADMIN_PASSWORD_HASH, SESSION_SECRET, GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET

The stock database and bucket are independent of Sales Office. The initial login release had no cron triggers and did not enable Drive backup. Sales Office synchronization remains separate and disabled.

## Google Drive and Google Sheets connection

The destination is the private owner folder **rrs-nexus-terminal data**. Configure `SQ_DRIVE_BACKUP_FOLDER_ID` in the production Worker; never infer the destination from its display name. A scheduled export is a dated snapshot for reading/reporting, not a write-back integration. The existing JSONL ledger files and final manifest remain the restoration format. Original R2 attachments are excluded.

Create a dedicated Google Cloud OAuth web application, enable Google Drive API and Google Sheets API, and register exactly `https://nexuspart-terminal.com/api/backup/google/callback` as an authorized redirect URI. Set `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` as Worker secrets and `SQ_GOOGLE_REDIRECT_URI` to that exact URL. Only the Nexus owner can initiate the Google connection from the backup page. The server requests offline Drive access for the pre-existing destination, protects authorization with session-bound single-use state and PKCE, and encrypts the refresh token in D1 using `SESSION_SECRET`; browser code and API responses must never receive the refresh token or client secret. A preconfigured `GOOGLE_DRIVE_REFRESH_TOKEN` secret remains supported.

Apply `0004_google_oauth.sql` before deploying the connection feature. Preserve `SESSION_SECRET` across deployments: rotating it requires reconnecting Google. Remove OAuth query strings from Cloudflare invocation logs (`observability.redact_query_string=true`) or leave invocation logging disabled.

After Google authorization, enable `SQ_DRIVE_BACKUP_ENABLED=true` and `SQ_SHEETS_EXPORT_ENABLED=true` for the first manual export, leaving production cron triggers absent. The backup flag gates manual exports as well as scheduled exports, so a manual test cannot run while it is false. Verify a native Google spreadsheet and the final manifest in the private destination, then inspect the recorded successful run. Only after that succeeds, register the production Cloudflare cron `0 20 * * *` (03:00 Asia/Bangkok the next day). The code's schedule string and the deployed trigger must match. Inspect the real Cloudflare schedule in addition to the page's configuration status. A configured timer alone is not evidence that Google authorization or export succeeded.

For an external Google OAuth app left in Testing, Google generally expires refresh tokens after seven days for these scopes. Use the appropriate production publishing state for this owner's ongoing backup; connecting successfully once does not eliminate that expiry. Never enable billing or broader services merely to enable Drive/Sheets APIs.

## Build and release

Install the pinned worker dependencies, then run node scripts/build-mcp.mjs. This builds .deploy/worker.js with server-mode HTML, using the existing page security handler and an internal ASSETS adapter. Only / and /index.html serve application HTML; /privacy is a separate static public disclosure with no account or storage access. Browser-only artifacts are excluded. Generated output is not committed.

Upload the module through authenticated Cloudflare MCP PUT /accounts/{account_id}/workers/scripts/nexuspart-terminal with multipart metadata: main_module=worker.js, compatibility date 2025-09-01, nodejs_compat, D1/R2 bindings and the variables above. Preserve existing secret bindings using keep_bindings: ["secret_text"], or pass newly provisioned secrets directly in the authenticated call without writing them to disk. Actual resource IDs stay in deployment configuration.

Migrations 0001 and 0002 were applied during initial setup. Before applying 0003_case_insensitive_usernames.sql, check for case-variant duplicate accounts and owner-name collisions. The unique index rejects ambiguous accounts; never silently merge or delete them. Record applied migration names in d1_migrations and only migrate the Nexus database.

## Verification and first use

Run worker regression tests, login/UI tests and per-action permission tests. Rebuild before the generated-package smoke test. Verify HTTPS, local auth provider, unauthenticated API rejection, cross-origin protection, case-insensitive successful login, hidden password by default and the reveal toggle, credential administration and denied commands for restricted users. Use synthetic credentials for automated tests and never save real credentials in test fixtures.

The owner initializes the empty stock system using the existing bootstrap workflow. Then create employees, assign actions/warehouses, and reconcile opening stock before importing it. Keep previous Worker versions for code rollback; preserve the append-only ledger and use forward database migrations.

## Verified release — 2026-11-03

Independent login deployed successfully. Live lowercase and uppercase owner sign-ins returned the canonical Adbeamlee identity. The first stock administrator was initialized using the normal audited bootstrap command; the users/permissions page and all 46 action selections were inspected in the live browser. No employee test accounts or opening stock were created in production.

Validation: 83 worker regression tests plus the generated-package test passed; 15 login/account-editor tests passed. The engine regression suite passed 218 tests with one existing skip. The live HTTPS/API smoke check passed. Actual owner credentials were supplied only through hidden input and encrypted deployment bindings, never written to source or test fixtures.

## Verified Google export — 2026-11-03

The dedicated Google Cloud project has Drive and Sheets APIs enabled, with no billing activation. The OAuth app is In production (not Testing); Google app verification is still pending. The owner explicitly approved the policy, full Drive scope, and Google's unverified-app warning before completing consent. The encrypted connection is stored in D1; invocation logging remains disabled. The public privacy disclosure is available at https://nexuspart-terminal.com/privacy.

The first manual export completed successfully at 09:54 Asia/Bangkok on 2026-11-03. Drive read-back confirmed the private dated subfolder contains one native spreadsheet with 32 tabs, one JSONL history part and the final manifest. The spreadsheet metadata tab matches the current ledger head and sequence 1 (initial administrator bootstrap only; no opening stock or production documents have been entered yet). This verifies integration on the current small dataset, not a production-volume load test or a full disaster-recovery drill.

Only after that success, the live Cloudflare schedule was registered and read back as `0 20 * * *`. The first scheduled run is due at 03:00 Asia/Bangkok on 2026-11-04. No scheduled execution has occurred yet at release time. Each run creates a new dated snapshot; Sheets changes do not write back, and original R2 attachments are not included.

Validation for the integration: 100 worker tests passed; after the final Sheets edge-case fix, all 10 Sheets tests and the rebuilt-package test passed. The backup UI and phase-6 suites passed 43 tests. The privacy route passed 2 tests, followed by the rebuilt-package regression test. Live HTTPS /privacy returned 200 with the restrictive content security policy; OAuth connection, manual export, Drive files, native Sheets metadata and the deployed schedule were independently checked.
