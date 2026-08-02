import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { Icon } from './Icon.js';

export interface PopoverProps {
  readonly label: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly align?: 'start' | 'end';
}

/**
 * A small non-modal popover. It is a disclosure with position: focus moves into
 * the panel on open, Escape and an outside click close it, and focus returns to
 * the trigger. Nothing inside it is reachable by keyboard while it is closed.
 */
export function Popover({ label, title, children, align = 'start' }: PopoverProps): ReactElement {
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  return (
    <div className="au-popover">
      <button
        type="button"
        ref={triggerRef}
        className="au-button au-button--quiet au-popover__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="info" size={14} />
        {label}
      </button>
      <div
        id={panelId}
        ref={panelRef}
        className={`au-popover__panel au-popover__panel--${align}`}
        hidden={!open}
        tabIndex={-1}
        role="group"
        aria-label={title}
      >
        <div className="au-popover__head">
          <p className="au-popover__title">{title}</p>
          <button
            type="button"
            className="au-icon-button"
            onClick={() => close(true)}
            aria-label={`Close ${title}`}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="au-popover__body">{children}</div>
      </div>
    </div>
  );
}
