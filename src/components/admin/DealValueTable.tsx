'use client';

import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { netChangeMinor, type DealValueMonth, type ValueTally } from '@/lib/dealValue';

// The estimated-value table (#2422/#2424): the one rendering of the month ×
// value rows, shared by the analytics card and the printable full report so
// the two cannot disagree. Amounts go through src/lib/money.ts; a month with
// nothing in a column shows "—", never a fabricated 0 (#2424).
export function DealValueTable({ months, currency }: { months: DealValueMonth[]; currency: string }) {
  const t = useT();
  const c = t.dealValue.card;
  const locale = useLocale();

  const money = (tally: ValueTally) =>
    tally.count === 0 ? (
      <span className="text-gray-500">—</span>
    ) : (
      <>
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {tally.count} · {formatMinorAmount(tally.valueMinor, currency, locale)}
        </span>
        {tally.unvalued > 0 && (
          <span className="block text-xs text-gray-500 dark:text-gray-400">{c.unvalued.replace('{n}', String(tally.unvalued))}</span>
        )}
      </>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="deal-value-table">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
            <th className="py-2 pr-3">{c.month}</th>
            <th className="py-2 pr-3">{c.won}</th>
            <th className="py-2 pr-3">{c.lost}</th>
            <th className="py-2 pr-3">{c.active}</th>
            <th className="py-2 pr-3">{c.value}</th>
            <th className="py-2">{c.net}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
          {months.map((m) => {
            const net = netChangeMinor(m);
            return (
              <tr key={m.month} data-testid={`deal-value-${m.month}`}>
                <td className="whitespace-nowrap py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{m.month}</td>
                <td className="py-2 pr-3" data-testid={`deal-value-${m.month}-won`}>{money(m.won)}</td>
                <td className="py-2 pr-3" data-testid={`deal-value-${m.month}-lost`}>{money(m.lost)}</td>
                <td className="py-2 pr-3" data-testid={`deal-value-${m.month}-active`}>
                  {m.activeAtEnd.count === 0 ? <span className="text-gray-500">—</span> : m.activeAtEnd.count}
                </td>
                <td className="whitespace-nowrap py-2 pr-3" data-testid={`deal-value-${m.month}-mrr`}>
                  {m.activeAtEnd.count === 0 ? (
                    <span className="text-gray-500">—</span>
                  ) : (
                    formatMinorAmount(m.activeAtEnd.valueMinor, currency, locale)
                  )}
                </td>
                <td className="whitespace-nowrap py-2" data-testid={`deal-value-${m.month}-net`}>
                  {net === null ? (
                    <span className="text-gray-500">—</span>
                  ) : (
                    <span className={net < 0 ? 'text-red-700' : net > 0 ? 'text-green-700' : undefined}>
                      {net > 0 ? '+' : ''}
                      {formatMinorAmount(net, currency, locale)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
