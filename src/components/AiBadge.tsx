'use client';

import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { useT } from '@/i18n/client';

/**
 * The ✨ marker every piece of model-generated text in this product wears
 * (#2034). One component, so the promise made on /ai — "generated content is
 * marked" — cannot be true on three surfaces and quietly false on a fourth.
 *
 * Three layers, because a sparkle on its own means nothing:
 *  - the chip, for someone scanning the page;
 *  - a screen-reader-only sentence, because the icon and the short chip label
 *    are both meaningless to a screen reader;
 *  - `title`, so hovering explains it without a click.
 *
 * `note` adds the one-line "check it before you rely on it" caution plus the
 * route that explains what was sent. Use it wherever the output is prose
 * someone might act on; the bare chip is enough for a single suggested value
 * sitting next to an Apply button.
 *
 * Colours are `bg-indigo-50` + `text-indigo-700`, a pair globals.css already
 * re-tints for dark mode — no new override needed.
 */
export function AiBadge({ note = false, className = '' }: { note?: boolean; className?: string }) {
  const t = useT();
  const b = t.aiBadge;

  const chip = (
    <span
      data-testid="ai-badge"
      title={b.tooltip}
      className="inline-flex items-center gap-1 rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 align-middle"
    >
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      <span aria-hidden="true">{b.label}</span>
      <span className="sr-only">{b.srLabel}</span>
    </span>
  );

  if (!note) return className ? <span className={className}>{chip}</span> : chip;

  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      {chip}
      <span className="text-[11px] text-gray-500 dark:text-gray-400">
        {b.note}{' '}
        <Link href="/ai" className="text-blue-600 dark:text-blue-400 hover:underline">
          {b.learnMore}
        </Link>
      </span>
    </span>
  );
}
