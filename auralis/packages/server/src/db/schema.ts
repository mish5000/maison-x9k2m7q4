/**
 * Database schema.
 *
 * The model separates three things that are easy to conflate:
 *   - `media_asset`   a logical recording (this speech, this track)
 *   - `media_variant` a particular encoded file of that recording
 *   - `raw_candidate` a particular source listing pointing at a variant
 * Collapsing these into one table is what makes a discovery product
 * unable to explain why two results are "the same but different".
 *
 * Migrations are append-only. Each entry runs once, in order, inside a
 * transaction, and is recorded in `schema_migration`.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE workspace (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
) STRICT;

CREATE TABLE app_user (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_app_user_workspace ON app_user(workspace_id);

CREATE TABLE search_session (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL,
  locale             TEXT NOT NULL,
  -- Stored so a user can review and delete their own history. Excluded from
  -- logs by default; deleted by the retention job.
  raw_query          TEXT NOT NULL,
  normalized_query   TEXT NOT NULL,
  filters_json       TEXT NOT NULL,
  provider_ids_json  TEXT NOT NULL,
  status             TEXT NOT NULL,
  correlation_id     TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  result_count       INTEGER NOT NULL DEFAULT 0,
  partial            INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_search_session_workspace ON search_session(workspace_id, started_at DESC);

CREATE TABLE search_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id    TEXT NOT NULL REFERENCES search_session(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_search_event_seq ON search_event(search_id, seq);

CREATE TABLE provider_search (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id      TEXT NOT NULL REFERENCES search_session(id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_provider_search_search ON provider_search(search_id);

CREATE TABLE media_asset (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  creator         TEXT,
  duplicate_group TEXT,
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_media_asset_group ON media_asset(duplicate_group);

CREATE TABLE search_result (
  id                 TEXT NOT NULL,
  search_id          TEXT NOT NULL REFERENCES search_session(id) ON DELETE CASCADE,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider_id        TEXT NOT NULL,
  provider_asset_id  TEXT NOT NULL,
  access_class       TEXT NOT NULL,
  ranking_total      REAL NOT NULL,
  -- The full SearchResult as delivered to the client, plus the fields the
  -- download-control service needs to re-derive its decision server-side.
  result_json        TEXT NOT NULL,
  media_url          TEXT,
  final_url          TEXT,
  local_path         TEXT,
  connector_id       TEXT,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (search_id, id)
) STRICT;

CREATE INDEX idx_search_result_workspace ON search_result(workspace_id, created_at DESC);

CREATE TABLE connector (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider_id       TEXT NOT NULL,
  kind              TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  -- Non-secret settings as JSON; secret settings live in connector_credential.
  config_json       TEXT NOT NULL,
  account_identity  TEXT,
  scope_description TEXT NOT NULL,
  status            TEXT NOT NULL,
  last_tested_at    TEXT,
  last_test_message TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE INDEX idx_connector_workspace ON connector(workspace_id);

CREATE TABLE connector_credential (
  connector_id  TEXT NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  -- AES-256-GCM record. Never logged, never returned by the API.
  ciphertext    TEXT NOT NULL,
  rotated_at    TEXT NOT NULL,
  PRIMARY KEY (connector_id, key)
) STRICT;

CREATE TABLE connector_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id  TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  action        TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_connector_audit_workspace ON connector_audit(workspace_id, created_at DESC);

CREATE TABLE saved_item (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  search_id     TEXT NOT NULL,
  result_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  creator       TEXT,
  source_name   TEXT NOT NULL,
  page_url      TEXT,
  format        TEXT NOT NULL,
  duration_secs REAL,
  note          TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_saved_item_unique ON saved_item(workspace_id, search_id, result_id);

CREATE TABLE download_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id   TEXT NOT NULL,
  search_id      TEXT NOT NULL,
  result_id      TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  access_class   TEXT NOT NULL,
  allowed        INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  method         TEXT,
  -- Host only. Full URLs are never stored here because they may be signed.
  final_host     TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_download_audit_workspace ON download_audit(workspace_id, created_at DESC);

CREATE TABLE abuse_signal (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_abuse_signal_workspace ON abuse_signal(workspace_id, created_at DESC);

CREATE TABLE provider_health_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id   TEXT NOT NULL,
  workspace_id  TEXT,
  status        TEXT NOT NULL,
  message       TEXT NOT NULL,
  latency_ms    INTEGER,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_provider_health_provider ON provider_health_snapshot(provider_id, created_at DESC);
`,
  },
];

/**
 * Retention policy, applied by `pruneExpiredData`. Times are in days.
 * Documented in docs/security/privacy.md.
 */
export interface RetentionPolicy {
  readonly searchSession: number;
  readonly searchEvent: number;
  readonly searchResult: number;
  readonly providerSearch: number;
  readonly downloadAudit: number;
  readonly connectorAudit: number;
  readonly abuseSignal: number;
  readonly providerHealthSnapshot: number;
}

export const RETENTION_DAYS: RetentionPolicy = Object.freeze({
  searchSession: 30,
  searchEvent: 7,
  searchResult: 30,
  providerSearch: 7,
  downloadAudit: 90,
  connectorAudit: 180,
  abuseSignal: 90,
  providerHealthSnapshot: 7,
});
