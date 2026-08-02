/**
 * Recent searches live only in this browser. Nothing is sent anywhere, which is
 * what the privacy line on the landing screen promises.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'auralis.recent-searches.v1';
const MAX_ENTRIES = 8;

function readStore(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeStore(entries: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Private browsing or a full quota. Recent searches are a convenience only.
  }
}

export interface RecentSearchesApi {
  readonly entries: readonly string[];
  readonly remember: (query: string) => void;
  readonly forget: (query: string) => void;
  readonly clear: () => void;
}

export function useRecentSearches(): RecentSearchesApi {
  const [entries, setEntries] = useState<readonly string[]>([]);

  useEffect(() => {
    setEntries(readStore());
  }, []);

  const remember = useCallback((query: string) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setEntries((current) => {
      const next = [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(0, MAX_ENTRIES);
      writeStore(next);
      return next;
    });
  }, []);

  const forget = useCallback((query: string) => {
    setEntries((current) => {
      const next = current.filter((entry) => entry !== query);
      writeStore(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    writeStore([]);
  }, []);

  return { entries, remember, forget, clear };
}
