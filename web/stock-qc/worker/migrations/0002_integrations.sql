-- RRS Stock & QC – Google Drive backup and Sales Office connector bookkeeping (BACKEND_DESIGN.md).
-- Append-only: 0001_init.sql is never edited; this file only adds tables and indexes. No credentials, tokens, secret
-- values or customer names are stored here (connector rows keep Sales Office IDs, hashes and error codes).

-- Short leases so two runs of the same job (cron + a manual run, or two isolates) never overlap.
CREATE TABLE sq_leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- One row per uploaded backup file (JSONL part or manifest): what Drive should hold, checked against Drive's checksum.
CREATE TABLE sq_backup_parts (
  run_id TEXT NOT NULL,
  part_no INTEGER NOT NULL CHECK (part_no >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('commits', 'manifest')),
  name TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL DEFAULT 0,
  to_seq INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, part_no)
);

-- Commands from Sales Office that were not applied and need a person: a known command id with another payload, the
-- same job + version under another command id, a payload hash that does not match, a command of the other workspace,
-- a bad envelope. The first and the latest time it was seen; never the payload itself.
CREATE TABLE sq_bridge_issues (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL CHECK (workspace IN ('domestic', 'export')),
  code TEXT NOT NULL,
  command_id TEXT NOT NULL DEFAULT '',
  job_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  known_hash TEXT NOT NULL DEFAULT '',
  received_hash TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX sq_bridge_issues_recent ON sq_bridge_issues (workspace, last_seen_at);

CREATE INDEX sq_bridge_events_queue ON sq_bridge_events (workspace, result, job_id, source_version);
