'use client';

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
}: {
  status: string;
  label: string;
  count: number;
  limit: number | null;
  /** Dim the count of an empty column (the owner's board, #1366). */
  muted?: boolean;
}) {
  const t = useT();
  const overLimit = isOverWipLimit({ status, count, limit });
  // Says WHICH limit was passed, rather than "over the recommended limit" —
  // with the number configurable per stage, a warning that does not name it
  // cannot be acted on.
  const wipWarning = overLimit
    ? t.adminBoard.wipWarning.replace('{count}', String(count)).replace('{limit}', String(limit))
    : undefined;
  return (
    <div className="flex items-center justify-between mb-3 px-1">
      <span data-testid={`board-column-title-${status}`} className="text-xs font-semibold text-gray-700">{label}</span>
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
