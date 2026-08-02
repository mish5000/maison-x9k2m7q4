import type { ReactElement, ReactNode } from 'react';

import type { Tone } from '../lib/labels.js';

const TONE_CLASS: Record<Tone, string> = {
  neutral: '',
  accent: 'au-chip--accent',
  success: 'au-chip--success',
  warning: 'au-chip--warning',
  danger: 'au-chip--danger',
};

export interface StatusChipProps {
  readonly label: string;
  readonly tone?: Tone;
  /** Shown as the control's title and to assistive technology. */
  readonly detail?: string;
  readonly trailing?: ReactNode;
  readonly showDot?: boolean;
}

/**
 * A status pill. The label is always present, so the tone colour is redundant
 * reinforcement rather than the only carrier of meaning.
 */
export function StatusChip({
  label,
  tone = 'neutral',
  detail,
  trailing,
  showDot = false,
}: StatusChipProps): ReactElement {
  const className = ['au-chip', TONE_CLASS[tone]].filter(Boolean).join(' ');
  return (
    <span className={className} {...(detail ? { title: detail } : {})}>
      {showDot ? <span className="au-chip__dot" aria-hidden="true" /> : null}
      <span>{label}</span>
      {detail ? <span className="au-visually-hidden">. {detail}</span> : null}
      {trailing}
    </span>
  );
}
