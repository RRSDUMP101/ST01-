# Nexus Part Terminal deployment

## Authentication

The Nexus deployment uses the existing Sales Office accounts, passwords and MFA through a Cloudflare service binding. It does not copy password hashes or authentication secrets. Users sign in separately on this domain; this is shared authentication, not automatic cross-domain SSO.

- Worker: `nexuspart-terminal`
- Hostname: `nexuspart-terminal.com`
- D1: `nexuspart-terminal` (independent stock database)
- R2: `nexuspart-terminal-files` (private binding, not a public bucket)
- Service binding `SALES_AUTH` → `rrs-sale-office-staging`
- `SQ_AUTH_PROVIDER=sales-office`
- `SQ_AUTH_ORIGIN=https://rrs-sale-office-staging.rrs-company.workers.dev`
- `SQ_ENV=production`, `SQ_SNAPSHOT_EVERY=500`
- `SQ_SALES_BRIDGE=off`, `SQ_DRIVE_BACKUP_ENABLED=false`

No new ADMIN_USERNAME, ADMIN_PASSWORD_HASH or SESSION_SECRET is needed in shared-auth mode. Credentials are managed at Sales Office. Unknown/missing provider configuration fails closed. A valid Sales Office account alone does not grant stock permissions: the Sales Office owner can bootstrap the empty stock system, and other accounts need stock user roles/warehouse permissions. Every protected request rechecks its session with Sales Office; account disablement and session revocation remain effective.

## Build and deploy

Install the pinned worker dependencies from package-lock.json, then run `node scripts/build-mcp.mjs`. This produces `.deploy/worker.js`, a minified ESM Worker including the server-mode HTML. It serves the HTML through the existing page security handler using an internal ASSETS fetch adapter. Only `/` and `/index.html` serve HTML; browser-only artifact files are excluded. The generated bundle is not committed.

Upload the module through authenticated Cloudflare MCP `PUT /accounts/{account_id}/workers/scripts/nexuspart-terminal` using multipart metadata: `main_module=worker.js`, compatibility date `2025-09-01`, `nodejs_compat`, D1 `DB`, R2 `BUCKET`, service `SALES_AUTH`, and the plain-text vars above. Bind the requested hostname via the Workers Custom Domains API. Actual resource IDs are kept in deployment records/configuration, not this template. There are no cron triggers for this initial release.

Database migrations 0001 and 0002 are applied to the new database only and recorded in d1_migrations. Never reapply them to the existing Sales Office database. Keep an earlier Worker version for code rollback; preserve the append-only stock ledger and use forward migrations for database changes.

## Verification and first use

Run the worker tests, shared-auth tests, frontend login tests and generated-package smoke tests. Check HTTPS, `/api/health`, unauthenticated 401 responses, cross-origin rejection, artifact 404, login error handling, and logout on the deployed domain. The account owner must perform the real password/MFA success check; do not extract or reset credentials to test.

After owner login, use the existing bootstrap workflow to initialize the new empty stock system. Grant stock roles deliberately and import approved opening data only after reconciliation. Login integration does not activate Sales Office job synchronization, Google Drive backup, outbound notifications, or production stock imports.

## Initial release verification — 2026-11-03

Deployed through Cloudflare MCP and connected `https://nexuspart-terminal.com` as a Workers Custom Domain. HTTPS, the rendered login page, ready D1/R2 bindings, unauthenticated API rejection, cross-origin login rejection, and exclusion of browser-only artifacts were verified. An intentionally nonexistent account was rejected by the real Sales Office service with HTTP 401 and no session cookie. No real account password was read, reset or used; successful owner login/MFA and initial stock bootstrap remain the account owner's first-use steps.

The deployment uses `rrs-sale-office-staging`, which is the existing Sales Office service identified for this setup. Keep that service available. The stock database and file bucket are new and independent of Sales Office data.
