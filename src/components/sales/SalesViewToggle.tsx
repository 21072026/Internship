'use client';

import { useT } from '@/i18n/client';

export type SalesBoardView = 'mine' | 'team';

/** `?view=team` → the team view; anything else is the default, the viewer's own book. */
export function salesBoardView(value: unknown): SalesBoardView {
  return value === 'team' ? 'team' : 'mine';
}

// "Mine / Team" on the sales board. "Mine" is the viewer's own book (GET
// /api/mentorship?surface=sales, unchanged); "Team" reads the org's book,
// read-only, from GET /api/sales/team-book (src/lib/salesTeamBook.ts). The
// board keeps the choice in the URL (`?view=team`) and renders this only for a
// viewer the team read allows.
export function SalesViewToggle({ view, onChange }: { view: SalesBoardView; onChange: (next: SalesBoardView) => void }) {
  const t = useT();
  const v = t.sales.view;
  // The selected button pins its dark-mode colours with `!` (#3838): globals.css
  // repaints `.bg-gray-900` under html.dark, which beat `dark:bg-gray-100` and
  // left dark text on a near-black button.
  return (
    <div role="group" aria-label={v.label} className="inline-flex rounded-lg border border-gray-300 p-0.5 dark:border-gray-600" data-testid="sales-view">
      {(['mine', 'team'] as const).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={view === key}
          onClick={() => view !== key && onChange(key)}
          className={`rounded-md px-3 py-1 text-sm ${view === key ? 'bg-gray-900 text-white dark:!bg-gray-100 dark:!text-gray-900' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
          data-testid={`sales-view-${key}`}
        >
          {v[key]}
        </button>
      ))}
    </div>
  );
}
