import { randomBytes, randomUUID } from 'node:crypto';

/** Identifier helpers. All IDs are opaque, URL-safe and non-guessable. */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(prefix: string, length = 20): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

export const newSearchId = (): string => randomId('srch');
export const newResultId = (): string => randomId('res');
export const newConnectorId = (): string => randomId('conn');
export const newWorkspaceId = (): string => randomId('ws');
export const newUserId = (): string => randomId('usr');
export const newSavedId = (): string => randomId('sav');
export const newCorrelationId = (): string => randomUUID();

/** Stable, deterministic identifier for an asset within a search. */
export function deterministicId(prefix: string, ...parts: readonly string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0x5f;
  }
  const value = (hash >>> 0).toString(36).padStart(7, '0');
  return `${prefix}_${value}`;
}
