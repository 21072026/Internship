import Link from 'next/link';
import { UserRoundPlus } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { getServerDictionary } from '@/i18n/server';
import { formatDate } from '@/lib/relativeTime';
import { assignedToYou } from '@/lib/assignedToYou';
import type { TenantWhere } from '@/lib/tenantFilter';

// "Assigned to you" (#3874, src/lib/assignedToYou.ts): what came to the rep from
// someone else and has not been opened yet. On the sales home it is the first
// card, above "Today" and the records; on the board a one-line strip above the
// columns. Renders nothing when there is nothing new.

export async function AssignedToYouCard({
  viewerId,
  tenant,
  variant = 'card',
  impersonating = false,
}: {
  viewerId: string;
  tenant: TenantWhere;
  variant?: 'card' | 'strip';
  /** An admin viewing as the rep: opening a record does not clear it for the rep (#3894). */
  impersonating?: boolean;
}) {
  const { items, total } = await assignedToYou(viewerId, tenant);
  if (items.length === 0) return null;
  const { t, locale } = await getServerDictionary();
  const a = t.assignedToYou;
  const from = (name: string | null) => (name ? a.from.replace('{name}', () => name) : a.fromSomeone);

  if (variant === 'strip') {
    return (
      <div
        className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100"
        data-testid="assigned-to-you-strip"
      >
        <UserRoundPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">{a.strip.replace('{n}', String(total))}</span>
        {items.map((i, n) => (
          <span key={i.relationId}>
            <Link href={`/sales/leads/${i.relationId}`} className="underline hover:no-underline" data-testid={`assigned-to-you-strip-${i.relationId}`}>
              {i.leadName}
            </Link>
            {n < items.length - 1 ? ',' : ''}
          </span>
        ))}
        {total > items.length && <span>· {a.more.replace('{n}', String(total - items.length))}</span>}
        {impersonating && (
          <span className="basis-full text-xs opacity-80" data-testid="assigned-to-you-impersonating">
            {a.hintImpersonating}
          </span>
        )}
      </div>
    );
  }

  const rowClass =
    'flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
  return (
    <Card className="mb-8" data-testid="assigned-to-you">
      <CardHeader>
        <CardTitle>{a.title}</CardTitle>
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid={impersonating ? 'assigned-to-you-impersonating' : undefined}>
          {impersonating ? a.hintImpersonating : a.hint}
        </p>
      </CardHeader>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {items.map((i) => {
          const step = [i.nextActionAt ? formatDate(i.nextActionAt, locale, { timeZone: 'UTC' }) : null, i.nextActionNote].filter(Boolean).join(' — ');
          return (
            <li key={i.relationId}>
              <Link href={`/sales/leads/${i.relationId}`} className={rowClass} data-testid={`assigned-to-you-${i.relationId}`}>
                <UserRoundPlus className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-gray-800 dark:text-gray-100">
                    {i.leadName}
                    {i.companyName && <span className="font-normal text-gray-500 dark:text-gray-400"> · {i.companyName}</span>}
                  </span>
                  <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{step || a.noStep}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
                  <span className="block">{from(i.fromName)}</span>
                  <RelativeTime date={i.assignedAt.toISOString()} className="block" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {total > items.length && (
        <p className="mt-2 px-2 text-xs text-gray-500 dark:text-gray-400" data-testid="assigned-to-you-more">
          {a.more.replace('{n}', String(total - items.length))}
        </p>
      )}
    </Card>
  );
}
