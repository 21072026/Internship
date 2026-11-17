'use client';

import { useId } from 'react';
import { Info } from 'lucide-react';
import { useT } from '@/i18n/client';
import { isOverWipLimit } from '@/lib/boardWip';

// A board column's header (#2076): the stage label and its card count, amber
// with "count / limit" once the column is over its WIP limit. The limit is a
// PROP — where it comes from is #1439's rule (src/lib/boardWip.ts), resolved by
// the board; null means no limit applies here (switched off, or the board is
// saturated). Advisory only: nothing here can block a move.
export function BoardColumnHeader({
  status,
  label,
  count,
  limit,
  muted = false,
  description = null,
}: {
  status: string;
  label: string;
  count: number;
  limit: number | null;
  /** Dim the count of an empty column (the owner's board, #1366). */
  muted?: boolean;
  /** What the stage means (#3660); null/empty draws no info icon. */
  description?: string | null;
}) {
  const t = useT();
  const tipId = useId();
  const overLimit = isOverWipLimit({ status, count, limit });
  // Says WHICH limit was passed, rather than "over the recommended limit" —
  // with the number configurable per stage, a warning that does not name it
  // cannot be acted on.
  const wipWarning = overLimit
    ? t.adminBoard.wipWarning.replace('{count}', String(count)).replace('{limit}', String(limit))
    : undefined;
  return (
    <div className="flex items-center justify-between mb-3 px-1">
      <span className="flex min-w-0 items-center gap-1">
        <span data-testid={`board-column-title-${status}`} className="text-xs font-semibold text-gray-700">{label}</span>
        {description ? (
          // A button, so a keyboard reaches it; the text is its description and
          // shows on hover and on focus (the HealthBadge pattern). Not a `title`:
          // that reaches a mouse and nothing else.
          <span className="group relative inline-flex">
            <button
              type="button"
              aria-label={t.adminBoard.stageInfo.replace('{stage}', label)}
              aria-describedby={tipId}
              data-testid={`board-column-info-${status}`}
              className="rounded-full p-0.5 text-gray-500 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <span
              role="tooltip"
              id={tipId}
              data-testid={`board-column-description-${status}`}
              className="invisible absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-2 text-xs font-normal text-gray-700 shadow-lg group-focus-within:visible group-hover:visible dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            >
              {description}
            </span>
          </span>
        ) : null}
      </span>
      <span
        /* Named so a test can read one column's count and its warning
           without matching on the label text (#1346). */
        data-testid={`board-column-count-${status}`}
        title={wipWarning}
        className={`text-xs rounded-full px-2 py-0.5 border ${
          overLimit
            ? 'text-amber-700 bg-amber-50 border-amber-300 font-semibold'
            : `text-gray-400 bg-white border-gray-200${muted && count === 0 ? ' opacity-50' : ''}`
        }`}
      >
        {count}{overLimit ? ` / ${limit}` : ''}
        {/* A `title` on a plain span reaches a mouse and nothing else. */}
        {wipWarning && <span className="sr-only">{wipWarning}</span>}
      </span>
    </div>
  );
}
