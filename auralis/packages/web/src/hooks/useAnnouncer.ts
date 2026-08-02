/**
 * Throttled screen-reader announcements.
 *
 * A streaming search produces dozens of updates a second. Announcing each one
 * would make the page unusable with a screen reader, so a message is published
 * at most once every `intervalMs` — except when `immediate` is set, which is how
 * state transitions (finished, cancelled, failed) jump the queue.
 */

import { useEffect, useRef, useState } from 'react';

const DEFAULT_INTERVAL_MS = 2000;

export function useAnnouncer(
  message: string,
  options: { immediate?: boolean; intervalMs?: number } = {},
): string {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const immediate = options.immediate ?? false;
  const [announced, setAnnounced] = useState('');
  const lastAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (message === announced) {
      return;
    }

    const publish = (): void => {
      lastAtRef.current = Date.now();
      setAnnounced(message);
    };

    if (immediate) {
      publish();
      return;
    }

    const waited = Date.now() - lastAtRef.current;
    if (waited >= intervalMs) {
      publish();
      return;
    }

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(publish, intervalMs - waited);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [message, announced, immediate, intervalMs]);

  return announced;
}
