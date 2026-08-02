import type { ReactElement, ReactNode } from 'react';

import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';

export type NoticeTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

const TONE_ICON: Record<NoticeTone, IconName> = {
  neutral: 'info',
  info: 'info',
  warning: 'alert',
  danger: 'alert',
  success: 'check',
};

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly title: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  /** `alert` makes assistive technology interrupt; use only for real failures. */
  readonly assertive?: boolean;
  readonly compact?: boolean;
  readonly id?: string;
}

/**
 * The single component for every explanatory state: empty, partial, failed,
 * offline, unavailable. Calm sentence first, technical detail never.
 */
export function Notice({
  tone = 'neutral',
  title,
  children,
  actions,
  assertive = false,
  compact = false,
  id,
}: NoticeProps): ReactElement {
  const className = ['au-notice', `au-notice--${tone}`, compact ? 'au-notice--compact' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      {...(id ? { id } : {})}
      {...(assertive ? { role: 'alert' as const } : {})}
    >
      <span className="au-notice__icon" aria-hidden="true">
        <Icon name={TONE_ICON[tone]} size={16} />
      </span>
      <div className="au-notice__body">
        <p className="au-notice__title">{title}</p>
        {children ? <div className="au-notice__text">{children}</div> : null}
        {actions ? <div className="au-notice__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
