import { newConnectorId } from '@auralis/core';
import type { ConnectorKind, ConnectorSummary } from '@auralis/core';

import { decryptSecret, DecryptionError, encryptSecret } from '../crypto/secrets.js';
import type { Db } from './database.js';

/**
 * Connector storage.
 *
 * Secret settings are encrypted before insert and are never returned by any
 * read path that feeds the API — `toSummary` masks them, and `resolveConfig`
 * (which does decrypt) is only reachable from the search orchestrator and the
 * connection test.
 */

export const CONNECTOR_PROVIDER_BY_KIND: Readonly<Record<ConnectorKind, string>> = {
  's3-compatible': 's3-compatible',
  webdav: 'webdav',
  'custom-json-api': 'custom-json-api',
  'rss-feed': 'rss-feed',
  'http-directory': 'http-directory',
  'ftp-directory': 'ftp-directory',
  'local-directory': 'local-files',
};

export const CONNECTOR_SCOPE_DESCRIPTION: Readonly<Record<ConnectorKind, string>> = {
  's3-compatible': 'Objects under the configured bucket and prefix.',
  webdav: 'Files under the configured collection.',
  'custom-json-api': 'Whatever the configured endpoint returns.',
  'rss-feed': 'Episodes published in the configured feeds.',
  'http-directory': 'Files under the configured directory addresses.',
  'ftp-directory': 'Files under the configured FTP paths.',
  'local-directory': 'Files in the folders you selected.',
};

/** Config keys that identify the account, shown so the user knows what is connected. */
const IDENTITY_KEY_BY_KIND: Readonly<Record<ConnectorKind, string | null>> = {
  's3-compatible': 'bucket',
  webdav: 'username',
  'custom-json-api': 'urlTemplate',
  'rss-feed': null,
  'http-directory': null,
  'ftp-directory': 'username',
  'local-directory': null,
};

export interface ConnectorRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly publicConfig: Readonly<Record<string, string>>;
  readonly accountIdentity: string | null;
  readonly scopeDescription: string;
  readonly status: ConnectorSummary['status'];
  readonly lastTestedAt: string | null;
  readonly lastTestMessage: string | null;
  readonly createdAt: string;
}

export class ConnectorRepository {
  constructor(
    private readonly db: Db,
    private readonly secretKey: Buffer,
  ) {}

  create(input: {
    readonly workspaceId: string;
    readonly kind: ConnectorKind;
    readonly displayName: string;
    readonly config: Readonly<Record<string, string>>;
    readonly secretKeys: readonly string[];
  }): ConnectorRow {
    const id = newConnectorId();
    const now = new Date().toISOString();
    const providerId = CONNECTOR_PROVIDER_BY_KIND[input.kind];

    const publicConfig: Record<string, string> = {};
    const secretEntries: [string, string][] = [];

    for (const [key, value] of Object.entries(input.config)) {
      if (input.secretKeys.includes(key)) secretEntries.push([key, value]);
      else publicConfig[key] = value;
    }

    const identityKey = IDENTITY_KEY_BY_KIND[input.kind];
    const accountIdentity = identityKey ? (input.config[identityKey] ?? null) : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO connector
           (id, workspace_id, provider_id, kind, display_name, config_json, account_identity,
            scope_description, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'untested', ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          providerId,
          input.kind,
          input.displayName,
          JSON.stringify(publicConfig),
          maskIdentity(accountIdentity),
          CONNECTOR_SCOPE_DESCRIPTION[input.kind],
          now,
          now,
        );

      const insertSecret = this.db.prepare(
        'INSERT INTO connector_credential (connector_id, key, ciphertext, rotated_at) VALUES (?, ?, ?, ?)',
      );
      for (const [key, value] of secretEntries) {
        insertSecret.run(id, key, encryptSecret(value, this.secretKey), now);
      }
    });

    return {
      id,
      workspaceId: input.workspaceId,
      providerId,
      kind: input.kind,
      displayName: input.displayName,
      publicConfig,
      accountIdentity: maskIdentity(accountIdentity),
      scopeDescription: CONNECTOR_SCOPE_DESCRIPTION[input.kind],
      status: 'untested',
      lastTestedAt: null,
      lastTestMessage: null,
      createdAt: now,
    };
  }

  list(workspaceId: string): readonly ConnectorRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, provider_id, kind, display_name, config_json, account_identity,
                scope_description, status, last_tested_at, last_test_message, created_at
         FROM connector WHERE workspace_id = ? ORDER BY created_at DESC`,
      )
      .all(workspaceId) as unknown as RawConnectorRow[];
    return rows.map(toRow);
  }

  get(workspaceId: string, connectorId: string): ConnectorRow | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, provider_id, kind, display_name, config_json, account_identity,
                scope_description, status, last_tested_at, last_test_message, created_at
         FROM connector WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, connectorId) as unknown as RawConnectorRow | undefined;
    return row ? toRow(row) : null;
  }

  /**
   * Returns the full configuration including decrypted secrets.
   *
   * SECURITY: the only callers are the search orchestrator and the connection
   * test. The result must never be serialised into a response or a log record.
   */
  resolveConfig(workspaceId: string, connectorId: string): Readonly<Record<string, string>> | null {
    const connector = this.get(workspaceId, connectorId);
    if (!connector) return null;

    const secrets = this.db
      .prepare('SELECT key, ciphertext FROM connector_credential WHERE connector_id = ?')
      .all(connectorId) as unknown as { key: string; ciphertext: string }[];

    const config: Record<string, string> = {
      ...connector.publicConfig,
      displayName: connector.displayName,
    };
    for (const secret of secrets) {
      try {
        config[secret.key] = decryptSecret(secret.ciphertext, this.secretKey);
      } catch (error) {
        if (error instanceof DecryptionError) return null;
        throw error;
      }
    }
    return config;
  }

  /** Configuration for every ready connector in a workspace, keyed by provider. */
  resolveAllByProvider(workspaceId: string): {
    readonly configByProvider: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly connectorIdByProvider: Readonly<Record<string, string>>;
    readonly validCredentialProviderIds: ReadonlySet<string>;
  } {
    const configByProvider: Record<string, Record<string, string>> = {};
    const connectorIdByProvider: Record<string, string> = {};
    const valid = new Set<string>();

    for (const connector of this.list(workspaceId)) {
      const config = this.resolveConfig(workspaceId, connector.id);
      if (!config) continue;

      const existing = configByProvider[connector.providerId];
      if (existing) {
        // Multiple connectors of one kind merge their list-style settings so a
        // workspace can attach several feeds or directories.
        for (const [key, value] of Object.entries(config)) {
          existing[key] = existing[key] ? `${existing[key]}\n${value}` : value;
        }
      } else {
        configByProvider[connector.providerId] = { ...config };
        connectorIdByProvider[connector.providerId] = connector.id;
      }
      if (connector.status !== 'auth_required' && connector.status !== 'error') {
        valid.add(connector.providerId);
      }
    }

    return { configByProvider, connectorIdByProvider, validCredentialProviderIds: valid };
  }

  updateStatus(
    workspaceId: string,
    connectorId: string,
    status: ConnectorSummary['status'],
    message: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE connector SET status = ?, last_test_message = ?, last_tested_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        status,
        message,
        new Date().toISOString(),
        new Date().toISOString(),
        workspaceId,
        connectorId,
      );
  }

  remove(workspaceId: string, connectorId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM connector WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, connectorId);
    return Number(result.changes) > 0;
  }
}

interface RawConnectorRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly provider_id: string;
  readonly kind: string;
  readonly display_name: string;
  readonly config_json: string;
  readonly account_identity: string | null;
  readonly scope_description: string;
  readonly status: string;
  readonly last_tested_at: string | null;
  readonly last_test_message: string | null;
  readonly created_at: string;
}

function toRow(row: RawConnectorRow): ConnectorRow {
  let publicConfig: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object') publicConfig = parsed as Record<string, string>;
  } catch {
    publicConfig = {};
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    providerId: row.provider_id,
    kind: row.kind as ConnectorKind,
    displayName: row.display_name,
    publicConfig,
    accountIdentity: row.account_identity,
    scopeDescription: row.scope_description,
    status: row.status as ConnectorSummary['status'],
    lastTestedAt: row.last_tested_at,
    lastTestMessage: row.last_test_message,
    createdAt: row.created_at,
  };
}

/** Shows enough of an identity to recognise it, never the whole value. */
function maskIdentity(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 6) return value;
  if (value.startsWith('http')) {
    try {
      return new URL(value).host;
    } catch {
      return `${value.slice(0, 6)}…`;
    }
  }
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

export function toConnectorSummary(row: ConnectorRow): ConnectorSummary {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    providerId: row.providerId,
    status: row.status,
    accountIdentity: row.accountIdentity,
    scopeDescription: row.scopeDescription,
    createdAt: row.createdAt,
    lastTestedAt: row.lastTestedAt,
    lastTestMessage: row.lastTestMessage,
    config: row.publicConfig,
  };
}
