import { useEffect, useState } from 'react';

/**
 * Wall-clock elapsed time for a running search. The engine also reports elapsed
 * time in progress events; this keeps the readout moving between them.
 */
export function useElapsed(startedAtMs: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || startedAtMs === null) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAtMs]);

  if (startedAtMs === null) return 0;
  return Math.max(0, now - startedAtMs);
}
