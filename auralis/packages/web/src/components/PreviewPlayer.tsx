import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { usePreviewController } from '../hooks/usePreviewController.js';

export interface PreviewPlayerProps {
  readonly resultId: string;
  readonly src: string;
  readonly title: string;
}

/**
 * Inline preview. `preload="none"` means nothing is fetched until a person
 * presses play, and the shared controller guarantees only one player runs.
 */
export function PreviewPlayer({ resultId, src, title }: PreviewPlayerProps): ReactElement {
  const { activeId, claim, release } = usePreviewController();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (activeId !== resultId && !audio.paused) {
      audio.pause();
    }
  }, [activeId, resultId]);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div className="au-preview">
      {failed ? (
        <p className="au-preview__message">
          This preview could not be played. The source may have moved or removed the file.
        </p>
      ) : null}
      <audio
        ref={audioRef}
        className="au-preview__player"
        controls
        preload="none"
        src={src}
        aria-label={`Preview of ${title}`}
        onPlay={() => claim(resultId)}
        onPause={() => release(resultId)}
        onEnded={() => release(resultId)}
        onError={() => {
          setFailed(true);
          release(resultId);
        }}
      >
        Your browser cannot play audio previews.
      </audio>
    </div>
  );
}
