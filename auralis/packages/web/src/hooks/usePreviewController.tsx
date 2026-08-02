/**
 * One player at a time. Each preview registers its id when it starts playing;
 * every other mounted player pauses itself when it sees a different active id.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

interface PreviewController {
  readonly activeId: string | null;
  readonly claim: (id: string) => void;
  readonly release: (id: string) => void;
}

const PreviewContext = createContext<PreviewController | null>(null);

export function PreviewProvider({ children }: { children: ReactNode }): ReactNode {
  const [activeId, setActiveId] = useState<string | null>(null);

  const claim = useCallback((id: string) => setActiveId(id), []);
  const release = useCallback(
    (id: string) => setActiveId((current) => (current === id ? null : current)),
    [],
  );

  const value = useMemo<PreviewController>(
    () => ({ activeId, claim, release }),
    [activeId, claim, release],
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function usePreviewController(): PreviewController {
  const controller = useContext(PreviewContext);
  if (!controller) {
    throw new Error('usePreviewController must be used inside a PreviewProvider.');
  }
  return controller;
}
