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
- SQ_SALES_BRIDGE=off, SQ_DRIVE_BACKUP_ENABLED=false
- Secret bindings: ADMIN_USERNAME, ADMIN_PASSWORD_HASH, SESSION_SECRET

The stock database and bucket are independent of Sales Office. No cron triggers are configured. Login setup does not import stock, enable Sales Office synchronization or activate Drive backup.

## Build and release

Install the pinned worker dependencies, then run node scripts/build-mcp.mjs. This builds .deploy/worker.js with server-mode HTML, using the existing page security handler and an internal ASSETS adapter. Only / and /index.html serve HTML; browser-only artifacts are excluded. Generated output is not committed.

Upload the module through authenticated Cloudflare MCP PUT /accounts/{account_id}/workers/scripts/nexuspart-terminal with multipart metadata: main_module=worker.js, compatibility date 2025-09-01, nodejs_compat, D1/R2 bindings and the variables above. Preserve existing secret bindings using keep_bindings: ["secret_text"], or pass newly provisioned secrets directly in the authenticated call without writing them to disk. Actual resource IDs stay in deployment configuration.

Migrations 0001 and 0002 were applied during initial setup. Before applying 0003_case_insensitive_usernames.sql, check for case-variant duplicate accounts and owner-name collisions. The unique index rejects ambiguous accounts; never silently merge or delete them. Record applied migration names in d1_migrations and only migrate the Nexus database.

## Verification and first use

Run worker regression tests, login/UI tests and per-action permission tests. Rebuild before the generated-package smoke test. Verify HTTPS, local auth provider, unauthenticated API rejection, cross-origin protection, case-insensitive successful login, hidden password by default and the reveal toggle, credential administration and denied commands for restricted users. Use synthetic credentials for automated tests and never save real credentials in test fixtures.

The owner initializes the empty stock system using the existing bootstrap workflow. Then create employees, assign actions/warehouses, and reconcile opening stock before importing it. Keep previous Worker versions for code rollback; preserve the append-only ledger and use forward database migrations.

## Verified release — 2026-11-03

Independent login deployed successfully. Live lowercase and uppercase owner sign-ins returned the canonical Adbeamlee identity. The first stock administrator was initialized using the normal audited bootstrap command; the users/permissions page and all 46 action selections were inspected in the live browser. No employee test accounts or opening stock were created in production.

Validation: 83 worker regression tests plus the generated-package test passed; 15 login/account-editor tests passed. The engine regression suite passed 218 tests with one existing skip. The live HTTPS/API smoke check passed. Actual owner credentials were supplied only through hidden input and encrypted deployment bindings, never written to source or test fixtures.
