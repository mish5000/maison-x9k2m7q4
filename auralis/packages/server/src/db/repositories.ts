import type { SearchEvent } from '@auralis/core';
import type { SearchResult } from '@auralis/core';
import { newSavedId, newUserId, newWorkspaceId } from '@auralis/core';

import type { Db } from './database.js';

/**
 * Repositories.
 *
 * Every query that can reach workspace-owned data takes a `workspaceId` and
 * includes it in the WHERE clause. That is the mechanism that enforces tenant
 * isolation at the data layer rather than relying on route handlers.
 */

export interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly userId: string;
}

export class WorkspaceRepository {
  constructor(private readonly db: Db) {}

  create(now: string = new Date().toISOString()): WorkspaceRecord {
    const workspaceId = newWorkspaceId();
    const userId = newUserId();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO workspace (id, created_at, last_seen_at) VALUES (?, ?, ?)')
        .run(workspaceId, now, now);
      this.db
        .prepare(
          'INSERT INTO app_user (id, workspace_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
        )
        .run(userId, workspaceId, now, now);
    });
    return { workspaceId, userId };
  }

  findByUserId(userId: string): WorkspaceRecord | null {
    const row = this.db
      .prepare('SELECT id, workspace_id FROM app_user WHERE id = ?')
      .get(userId) as { id: string; workspace_id: string } | undefined;
    return row ? { workspaceId: row.workspace_id, userId: row.id } : null;
  }

  touch(userId: string, now: string = new Date().toISOString()): void {
    this.db.prepare('UPDATE app_user SET last_seen_at = ? WHERE id = ?').run(now, userId);
    this.db
      .prepare(
        'UPDATE workspace SET last_seen_at = ? WHERE id = (SELECT workspace_id FROM app_user WHERE id = ?)',
      )
      .run(now, userId);
  }
}

export interface SearchSessionInsert {
  readonly searchId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly mode: string;
  readonly locale: string;
  readonly rawQuery: string;
  readonly normalizedQuery: string;
  readonly filters: unknown;
  readonly providerIds: readonly string[];
  readonly correlationId: string;
}

export interface SearchSessionRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly mode: string;
  readonly normalizedQuery: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly resultCount: number;
  readonly partial: boolean;
}

export class SearchRepository {
  constructor(private readonly db: Db) {}

  createSession(input: SearchSessionInsert, now: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO search_session
         (id, workspace_id, user_id, mode, locale, raw_query, normalized_query,
          filters_json, provider_ids_json, status, correlation_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        input.searchId,
        input.workspaceId,
        input.userId,
        input.mode,
        input.locale,
        input.rawQuery,
        input.normalizedQuery,
        JSON.stringify(input.filters),
        JSON.stringify(input.providerIds),
        input.correlationId,
        now,
      );
  }

  getSession(searchId: string, workspaceId: string): SearchSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, status, mode, normalized_query, started_at,
                finished_at, result_count, partial
         FROM search_session WHERE id = ? AND workspace_id = ?`,
      )
      .get(searchId, workspaceId) as
      | {
          id: string;
          workspace_id: string;
          status: string;
          mode: string;
          normalized_query: string;
          started_at: string;
          finished_at: string | null;
          result_count: number;
          partial: number;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      status: row.status,
      mode: row.mode,
      normalizedQuery: row.normalized_query,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      resultCount: row.result_count,
      partial: row.partial === 1,
    };
  }

  finishSession(
    searchId: string,
    status: 'completed' | 'cancelled' | 'failed',
    resultCount: number,
    partial: boolean,
    now: string = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        'UPDATE search_session SET status = ?, finished_at = ?, result_count = ?, partial = ? WHERE id = ?',
      )
      .run(status, now, resultCount, partial ? 1 : 0, searchId);
  }

  appendEvent(event: SearchEvent, now: string = new Date().toISOString()): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO search_event (search_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(event.searchId, event.seq, event.type, JSON.stringify(event), now);
  }

  /** Replays events after `afterSeq`, which is how SSE resumption works. */
  eventsSince(searchId: string, afterSeq: number): readonly SearchEvent[] {
    const rows = this.db
      .prepare(
        'SELECT payload_json FROM search_event WHERE search_id = ? AND seq > ? ORDER BY seq ASC',
      )
      .all(searchId, afterSeq) as { payload_json: string }[];
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload_json) as SearchEvent];
      } catch {
        return [];
      }
    });
  }

  recordProviderSearch(
    searchId: string,
    providerId: string,
    outcome: string,
    candidateCount: number,
    durationMs: number,
    now: string = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_search (search_id, provider_id, outcome, candidate_count, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(searchId, providerId, outcome, candidateCount, durationMs, now);
  }

  /**
   * Persists a single result as soon as it is emitted.
   *
   * This has to happen while the search is still running: the interface shows
   * results the moment they stream in, so a download request can arrive long
   * before the search finishes.
   */
  saveResult(
    searchId: string,
    workspaceId: string,
    result: SearchResult,
    extra: { localPath?: string | null; connectorId?: string | null } = {},
    now: string = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO search_result
         (id, search_id, workspace_id, provider_id, provider_asset_id, access_class,
          ranking_total, result_json, media_url, final_url, local_path, connector_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        searchId,
        workspaceId,
        result.source.providerId,
        result.id,
        result.access.classification,
        result.ranking.total,
        JSON.stringify(result),
        result.mediaUrl,
        result.verification.finalUrl,
        extra.localPath ?? null,
        extra.connectorId ?? null,
        now,
      );
  }

  /** Removes a result that the pipeline rejected after it had been emitted. */
  deleteResult(searchId: string, workspaceId: string, resultId: string): void {
    this.db
      .prepare('DELETE FROM search_result WHERE search_id = ? AND workspace_id = ? AND id = ?')
      .run(searchId, workspaceId, resultId);
  }

  saveResults(
    searchId: string,
    workspaceId: string,
    results: readonly SearchResult[],
    extra: ReadonlyMap<string, { localPath?: string | null; connectorId?: string | null }>,
    now: string = new Date().toISOString(),
  ): void {
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO search_result
       (id, search_id, workspace_id, provider_id, provider_asset_id, access_class,
        ranking_total, result_json, media_url, final_url, local_path, connector_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const result of results) {
        const supplemental = extra.get(result.id);
        statement.run(
          result.id,
          searchId,
          workspaceId,
          result.source.providerId,
          result.id,
          result.access.classification,
          result.ranking.total,
          JSON.stringify(result),
          result.mediaUrl,
          result.verification.finalUrl,
          supplemental?.localPath ?? null,
          supplemental?.connectorId ?? null,
          now,
        );
      }
    });
  }

  getResult(
    searchId: string,
    resultId: string,
    workspaceId: string,
  ): {
    readonly result: SearchResult;
    readonly mediaUrl: string | null;
    readonly finalUrl: string | null;
    readonly localPath: string | null;
    readonly connectorId: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT result_json, media_url, final_url, local_path, connector_id
         FROM search_result WHERE search_id = ? AND id = ? AND workspace_id = ?`,
      )
      .get(searchId, resultId, workspaceId) as
      | {
          result_json: string;
          media_url: string | null;
          final_url: string | null;
          local_path: string | null;
          connector_id: string | null;
        }
      | undefined;

    if (!row) return null;
    try {
      return {
        result: JSON.parse(row.result_json) as SearchResult,
        mediaUrl: row.media_url,
        finalUrl: row.final_url,
        localPath: row.local_path,
        connectorId: row.connector_id,
      };
    } catch {
      return null;
    }
  }

  listResults(searchId: string, workspaceId: string): readonly SearchResult[] {
    const rows = this.db
      .prepare(
        'SELECT result_json FROM search_result WHERE search_id = ? AND workspace_id = ? ORDER BY ranking_total DESC',
      )
      .all(searchId, workspaceId) as { result_json: string }[];
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.result_json) as SearchResult];
      } catch {
        return [];
      }
    });
  }

  deleteHistory(workspaceId: string): number {
    const result = this.db
      .prepare('DELETE FROM search_session WHERE workspace_id = ?')
      .run(workspaceId);
    return Number(result.changes);
  }
}

export interface SavedItemRow {
  readonly id: string;
  readonly title: string;
  readonly creator: string | null;
  readonly sourceName: string;
  readonly pageUrl: string | null;
  readonly format: string;
  readonly durationSeconds: number | null;
  readonly savedAt: string;
  readonly note: string | null;
}

export class SavedItemRepository {
  constructor(private readonly db: Db) {}

  save(
    workspaceId: string,
    searchId: string,
    result: SearchResult,
    note: string | null,
    now: string = new Date().toISOString(),
  ): SavedItemRow {
    const id = newSavedId();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO saved_item
         (id, workspace_id, search_id, result_id, title, creator, source_name, page_url, format, duration_secs, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        searchId,
        result.id,
        result.title,
        result.creator,
        result.source.providerDisplayName,
        result.pageUrl,
        result.technical.format,
        result.technical.durationSeconds,
        note,
        now,
      );

    return {
      id,
      title: result.title,
      creator: result.creator,
      sourceName: result.source.providerDisplayName,
      pageUrl: result.pageUrl,
      format: result.technical.format,
      durationSeconds: result.technical.durationSeconds,
      savedAt: now,
      note,
    };
  }

  list(workspaceId: string): readonly SavedItemRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, creator, source_name, page_url, format, duration_secs, note, created_at
         FROM saved_item WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`,
      )
      .all(workspaceId) as {
      id: string;
      title: string;
      creator: string | null;
      source_name: string;
      page_url: string | null;
      format: string;
      duration_secs: number | null;
      note: string | null;
      created_at: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      creator: row.creator,
      sourceName: row.source_name,
      pageUrl: row.page_url,
      format: row.format,
      durationSeconds: row.duration_secs,
      savedAt: row.created_at,
      note: row.note,
    }));
  }

  remove(workspaceId: string, savedId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM saved_item WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, savedId);
    return Number(result.changes) > 0;
  }
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  recordDownloadIntent(input: {
    readonly workspaceId: string;
    readonly searchId: string;
    readonly resultId: string;
    readonly providerId: string;
    readonly accessClass: string;
    readonly allowed: boolean;
    readonly reason: string;
    readonly method: string | null;
    readonly finalHost: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO download_audit
         (workspace_id, search_id, result_id, provider_id, access_class, allowed, reason, method, final_host, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workspaceId,
        input.searchId,
        input.resultId,
        input.providerId,
        input.accessClass,
        input.allowed ? 1 : 0,
        input.reason,
        input.method,
        input.finalHost,
        new Date().toISOString(),
      );
  }

  recordConnectorAction(
    connectorId: string,
    workspaceId: string,
    action: string,
    outcome: string,
    detail: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO connector_audit (connector_id, workspace_id, action, outcome, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(connectorId, workspaceId, action, outcome, detail, new Date().toISOString());
  }

  recordAbuseSignal(workspaceId: string, kind: string, detail: string | null): void {
    this.db
      .prepare(
        'INSERT INTO abuse_signal (workspace_id, kind, detail, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(workspaceId, kind, detail, new Date().toISOString());
  }

  recordProviderHealth(
    providerId: string,
    workspaceId: string | null,
    status: string,
    message: string,
    latencyMs: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_health_snapshot (provider_id, workspace_id, status, message, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(providerId, workspaceId, status, message, latencyMs, new Date().toISOString());
  }
}
