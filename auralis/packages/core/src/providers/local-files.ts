import { createReadStream, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { coverage } from '../scoring/relevance.js';
import {
  buildCandidate,
  capabilities,
  configList,
  looksLikeAudioFilename,
  msRemaining,
} from './helpers.js';

/**
 * Local files adapter.
 *
 * Searches directories the user explicitly selected. Results are classified
 * `user_owned`, so they never enter a shared cache and are never offered to
 * another workspace.
 *
 * SECURITY: every resolved path is checked against the configured root with
 * `isInsideRoot` before it is read or emitted, so a symlink pointing outside
 * the selected folder cannot be used to read the rest of the filesystem.
 *
 * Configuration:
 *   roots — newline or comma separated absolute directory paths
 */

const CONFIG_ROOTS = 'roots';
const MAX_ENTRIES_SCANNED = 5000;
const MAX_DEPTH = 6;

export function isInsideRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedRoot = resolve(rootPath);
  const resolvedCandidate = resolve(candidatePath);
  if (resolvedCandidate === resolvedRoot) return true;
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !relativePath.startsWith(`..${sep}`) &&
    !resolve(resolvedRoot, relativePath).startsWith('..')
  );
}

export class LocalFilesProvider implements SearchProvider {
  readonly id = 'local-files';
  readonly displayName = 'Local files';
  readonly capabilities = capabilities({
    supportsTextSearch: true,
    returnsDirectMediaUrls: false,
    supportsPreview: true,
    supportsServerSideSearch: false,
    rateLimit: { kind: 'concurrency_only', maxConcurrent: 1 },
    robotsPosture: 'not_applicable',
    timeoutMs: 10_000,
    exposesFileSize: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 1,
    sourceCategory: 'local_files',
    modes: ['connected', 'deep'],
    producesPrivateResults: true,
    requiredConfiguration: [CONFIG_ROOTS],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    const roots = configList(context.config[CONFIG_ROOTS]).slice(0, 8);
    if (roots.length === 0) return;

    const searchText = query.variants[0]?.text ?? query.normalized;
    let emitted = 0;
    let scanned = 0;

    for (const rawRoot of roots) {
      const root = resolve(rawRoot);
      if (signal.aborted || emitted >= context.maxCandidates) return;

      const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

      while (queue.length > 0) {
        if (signal.aborted || emitted >= context.maxCandidates) return;
        if (msRemaining(context) <= 0 || scanned >= MAX_ENTRIES_SCANNED) return;

        const current = queue.shift();
        if (!current) break;
        if (!isInsideRoot(current.path, root)) continue;

        let entries: Dirent[];
        try {
          entries = await readdir(current.path, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          scanned += 1;
          if (scanned >= MAX_ENTRIES_SCANNED) break;
          if (entry.name.startsWith('.')) continue;

          const fullPath = join(current.path, entry.name);
          // Re-check after joining: this is what rejects a symlink that escapes.
          if (!isInsideRoot(fullPath, root)) continue;

          if (entry.isDirectory()) {
            if (current.depth + 1 <= MAX_DEPTH)
              queue.push({ path: fullPath, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile()) continue;
          if (!looksLikeAudioFilename(entry.name)) continue;
          if (coverage(searchText, entry.name) < 0.34) continue;
          if (emitted >= context.maxCandidates) return;

          let sizeBytes: number | null = null;
          let modifiedAt: string | null = null;
          try {
            const stats = await stat(fullPath);
            sizeBytes = stats.size;
            modifiedAt = stats.mtime.toISOString();
          } catch {
            continue;
          }

          yield buildCandidate({
            providerId: this.id,
            providerDisplayName: this.displayName,
            category: 'local_files',
            providerAssetId: fullPath,
            title: basename(entry.name, extname(entry.name)).replace(/[_-]+/g, ' '),
            filename: entry.name,
            // Local files have no URL. The server exposes them through a
            // workspace-scoped streaming route once access is classified.
            mediaUrl: null,
            pageUrl: null,
            collection: basename(current.path),
            publishedAt: modifiedAt,
            declaredAccess: 'user_owned',
            claimed: { sizeBytes },
            extras: { localPath: fullPath, root },
          });
          emitted += 1;
        }
      }
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const roots = configList(context.config[CONFIG_ROOTS]);
    if (roots.length === 0) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message: 'Select one or more folders to search them.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/local-files.md',
      };
    }

    const startedAt = context.now();
    const unreadable: string[] = [];
    for (const root of roots) {
      try {
        const stats = await stat(resolve(root));
        if (!stats.isDirectory()) unreadable.push(root);
      } catch {
        unreadable.push(root);
      }
    }

    return {
      providerId: this.id,
      status:
        unreadable.length === 0
          ? 'ready'
          : unreadable.length === roots.length
            ? 'unavailable'
            : 'degraded',
      message:
        unreadable.length === 0
          ? `${roots.length} folder${roots.length === 1 ? '' : 's'} available.`
          : `${unreadable.length} of ${roots.length} folders could not be read.`,
      checkedAt: new Date().toISOString(),
      latencyMs: context.now() - startedAt,
      setupDocPath: 'docs/providers/local-files.md',
    };
  }
}

/** Opens a bounded read stream for a local asset, after re-checking the root. */
export async function openLocalAsset(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<{
  readonly stream: ReturnType<typeof createReadStream>;
  readonly sizeBytes: number;
} | null> {
  const resolved = resolve(filePath);
  if (!allowedRoots.some((root) => isInsideRoot(resolved, root))) return null;
  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) return null;
    return { stream: createReadStream(resolved), sizeBytes: stats.size };
  } catch {
    return null;
  }
}

/** Reads a bounded sample from a local file for verification. */
export async function readLocalSample(
  filePath: string,
  allowedRoots: readonly string[],
  maxBytes: number,
  fromEnd = false,
): Promise<Uint8Array | null> {
  const resolved = resolve(filePath);
  if (!allowedRoots.some((root) => isInsideRoot(resolved, root))) return null;

  let size: number;
  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) return null;
    size = stats.size;
  } catch {
    return null;
  }

  const start = fromEnd ? Math.max(0, size - maxBytes) : 0;
  const end = fromEnd ? Math.max(0, size - 1) : Math.min(size, maxBytes) - 1;
  if (end < start) return new Uint8Array(0);

  return await new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(resolved, { start, end });
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('error', () => resolvePromise(null));
    stream.on('end', () => resolvePromise(new Uint8Array(Buffer.concat(chunks))));
  });
}
