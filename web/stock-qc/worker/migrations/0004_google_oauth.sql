-- Server-only Google connection. Values and PKCE verifiers are AES-GCM encrypted; OAuth state is stored only hashed.
CREATE TABLE sq_integrations (
  id TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  client_id_hash TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE sq_google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  client_id_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sq_google_oauth_states_expiry ON sq_google_oauth_states (expires_at);
