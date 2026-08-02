/**
 * Minimal async resource holder: load once, expose status, allow a manual
 * reload. Used for providers, saved items, connectors and provider health.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { toUserMessage } from '../api/client.js';

export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Resource<T> {
  readonly data: T;
  readonly status: ResourceStatus;
  readonly error: string | null;
  readonly reload: () => void;
  readonly setData: (updater: (current: T) => T) => void;
}

export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  initial: T,
  options: { enabled?: boolean } = {},
): Resource<T> {
  const enabled = options.enabled ?? true;
  const [data, setDataState] = useState<T>(initial);
  const [status, setStatus] = useState<ResourceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    setStatus('loading');
    setError(null);

    loaderRef
      .current(controller.signal)
      .then((value) => {
        if (cancelled) return;
        setDataState(value);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(toUserMessage(cause));
        setStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const setData = useCallback(
    (updater: (current: T) => T) => setDataState((current) => updater(current)),
    [],
  );

  return { data, status, error, reload, setData };
}
