'use client';

import { useT } from '@/i18n/client';
import type { SalesBookView } from '@/lib/salesBookRule';
import { salesViewClass } from '@/components/sales/SalesViewLinks';

// "Mine / Team" on the sales board (the team view, src/lib/salesBookRule.ts).
// The board keeps the choice in the URL (`?view=team`); the server pages use
// SalesViewLinks, the same control as plain links.
export function SalesViewToggle({ view, onChange }: { view: SalesBookView; onChange: (next: SalesBookView) => void }) {
  const t = useT();
  const v = t.sales.view;
  return (
    <div role="group" aria-label={v.label} className="inline-flex rounded-lg border border-gray-300 p-0.5 dark:border-gray-600" data-testid="sales-view">
      {(['mine', 'team'] as const).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={view === key}
          onClick={() => view !== key && onChange(key)}
          className={salesViewClass(view === key)}
          data-testid={`sales-view-${key}`}
        >
          {v[key]}
        </button>
      ))}
    </div>
  );
}
