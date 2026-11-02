-- RRS Stock & QC – first schema (BACKEND_DESIGN.md "Data in D1").
-- Append-only: once applied, this file is never edited; later changes go in 0002_…, 0003_… .
-- sq_commits is the source of truth (one row per engine commit, hash chained). sq_records is written from the same
-- commit's effects in the same D1 batch and can always be rebuilt from sq_commits. No credentials, tokens or secret
-- values are stored in any table: passwords only as bcrypt hashes, sessions only as HMAC(token).

CREATE TABLE sq_commits (
  seq INTEGER PRIMARY KEY CHECK (seq > 0),
  request_id TEXT UNIQUE CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 100),
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  "by" TEXT NOT NULL DEFAULT '',
  via TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  effects TEXT NOT NULL CHECK (json_valid(effects))
);

-- History is never changed or removed (a reversal is a new commit that points at what it reverses).
CREATE TRIGGER sq_commits_no_update BEFORE UPDATE ON sq_commits
BEGIN
  SELECT RAISE(ABORT, 'sq_commits is append-only');
END;

CREATE TRIGGER sq_commits_no_delete BEFORE DELETE ON sq_commits
BEGIN
  SELECT RAISE(ABORT, 'sq_commits is append-only');
END;

-- Current rows (like rrs_records in Sales Office), keyed by engine table + row key.
CREATE TABLE sq_records (
  tbl TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (tbl, id)
);
CREATE INDEX sq_records_seq ON sq_records (seq);

-- State snapshots in R2 (every SQ_SNAPSHOT_EVERY commits) for a fast cold start.
CREATE TABLE sq_snapshots (
  seq INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Login credentials only (roles and warehouses live in the engine users table, accountId = username).
CREATE TABLE sq_app_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change INTEGER NOT NULL DEFAULT 1 CHECK (must_change IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT ''
);

-- 8 h sessions; id = HMAC(SESSION_SECRET, token), never the token itself.
CREATE TABLE sq_sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_version TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sq_sessions_expiry ON sq_sessions (expires_at);
CREATE INDEX sq_sessions_user ON sq_sessions (username);

CREATE TABLE sq_auth_audit (
  id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  ip TEXT NOT NULL,
  event TEXT NOT NULL
);
CREATE INDEX sq_auth_audit_time ON sq_auth_audit (time);

CREATE TABLE sq_auth_limits (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sq_auth_limits_expiry ON sq_auth_limits (expires_at);

CREATE TABLE sq_security_limits (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sq_security_limits_expiry ON sq_security_limits (expires_at);

CREATE TABLE sq_security_events (
  id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  ip TEXT NOT NULL,
  event TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sq_security_events_time ON sq_security_events (time);

-- R2 file metadata; engine rows keep the file id (sha256 of the bytes).
CREATE TABLE sq_files (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

-- Google Drive backup runs (off unless SQ_DRIVE_BACKUP_ENABLED=true). Metadata only, never credentials.
CREATE TABLE sq_backup_runs (
  id TEXT PRIMARY KEY,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled')),
  day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  from_seq INTEGER NOT NULL DEFAULT 0,
  to_seq INTEGER NOT NULL DEFAULT 0,
  head TEXT NOT NULL DEFAULT '',
  commits INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  parts INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  lease TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX sq_backup_runs_recent ON sq_backup_runs (started_at);
CREATE UNIQUE INDEX sq_backup_runs_daily ON sq_backup_runs (day) WHERE trigger_kind = 'scheduled';

-- Sales Office connector journal (off by default). Domestic and Export stay apart: workspace is on every row and part
-- of every key; nothing is ever matched by customer name.
CREATE TABLE sq_bridge_commands (
  workspace TEXT NOT NULL CHECK (workspace IN ('domestic', 'export')),
  command_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  order_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL CHECK (version > 0),
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_seq INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (workspace, command_id),
  UNIQUE (workspace, job_id, version)
);
CREATE INDEX sq_bridge_commands_job ON sq_bridge_commands (workspace, job_id, version);

CREATE TABLE sq_bridge_events (
  workspace TEXT NOT NULL CHECK (workspace IN ('domestic', 'export')),
  event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  job_id TEXT NOT NULL,
  command_id TEXT NOT NULL DEFAULT '',
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (workspace, event_id),
  UNIQUE (workspace, job_id, source_version)
);

CREATE TABLE sq_bridge_health (
  workspace TEXT PRIMARY KEY CHECK (workspace IN ('domestic', 'export')),
  connector_id TEXT NOT NULL DEFAULT '',
  pull_cursor TEXT NOT NULL DEFAULT '',
  last_pull_at TEXT,
  last_push_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
