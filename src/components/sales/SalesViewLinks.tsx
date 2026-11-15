import Link from 'next/link';
import type { SalesBookView } from '@/lib/salesBookRule';

// "Mine / Team" as links, for the server-rendered sales pages (`/sales`,
// `/sales/accounts`): the view lives in the URL (`?view=team`), so a link is
// all it takes and the page re-renders on the server with the other book.
export function salesViewClass(active: boolean): string {
  return `inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium ${
    active ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'
  }`;
}

export function SalesViewLinks({
  view,
  basePath,
  labels,
}: {
  view: SalesBookView;
  basePath: string;
  labels: { label: string; mine: string; team: string };
}) {
  return (
    <nav aria-label={labels.label} className="inline-flex rounded-lg border border-gray-300 p-0.5 dark:border-gray-600" data-testid="sales-view">
      {(['mine', 'team'] as const).map((key) => (
        <Link
          key={key}
          href={key === 'team' ? `${basePath}?view=team` : basePath}
          aria-current={view === key ? 'page' : undefined}
          className={salesViewClass(view === key)}
          data-testid={`sales-view-${key}`}
        >
          {labels[key]}
        </Link>
      ))}
    </nav>
  );
}
