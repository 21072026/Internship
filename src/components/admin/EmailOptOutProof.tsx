'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

// "Show me this person's opt-out was honoured" (#2054). Every bulk path now
// leaves a SKIPPED `Unsubscribed: <group>` row for each recipient it did not
// mail; this reads them back — a per-group and per-category breakdown for a
// window, and a lookup by address. Super-admin only, like the log it reads
// (GET /api/admin/email-log enforces it).

interface Entry { id: string; to: string; subject: string; category: string | null; status: string; error: string | null; createdAt: string }
interface Body {
  entries: Entry[];
  suppression: { days: number; total: number; byGroup: { group: string; count: number }[]; byCategory: { category: string; count: number }[] };
}

const WINDOWS = [1, 7, 30, 90] as const;

export function EmailOptOutProof() {
  const t = useT();
  const o = t.emailOptOut;
  const locale = useLocale();
  const [days, setDays] = useState<number>(7);
  const [address, setAddress] = useState('');
  const [query, setQuery] = useState('');
  const [body, setBody] = useState<Body | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ suppressed: '1', days: String(days), limit: '50' });
    if (query) params.set('to', query);
    const res = await fetch(`/api/admin/email-log?${params.toString()}`);
    if (res.ok) setBody(await res.json());
  }, [days, query]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="email-optout-proof">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{o.title}</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">{o.hint}</p>
        </div>
        <label className="text-xs text-gray-600 dark:text-gray-400">
          {o.window}{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800" data-testid="email-optout-days">
            {WINDOWS.map((d) => <option key={d} value={d}>{o.days.replace('{n}', String(d))}</option>)}
          </select>
        </label>
      </div>

      {body && (
        <>
          <p className="mt-2 text-sm text-gray-800 dark:text-gray-200" data-testid="email-optout-total">
            {o.total.replace('{n}', String(body.suppression.total)).replace('{days}', String(body.suppression.days))}
          </p>
          {body.suppression.total > 0 && (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <table className="w-full text-xs" data-testid="email-optout-by-group">
                <thead><tr className="text-left text-gray-500"><th className="py-1">{o.group}</th><th className="py-1 text-right">{o.count}</th></tr></thead>
                <tbody>{body.suppression.byGroup.map((g) => <tr key={g.group} className="border-t border-gray-100 dark:border-gray-800"><td className="py-1">{g.group}</td><td className="py-1 text-right tabular-nums">{g.count}</td></tr>)}</tbody>
              </table>
              <table className="w-full text-xs" data-testid="email-optout-by-category">
                <thead><tr className="text-left text-gray-500"><th className="py-1">{o.category}</th><th className="py-1 text-right">{o.count}</th></tr></thead>
                <tbody>{body.suppression.byCategory.map((c) => <tr key={c.category} className="border-t border-gray-100 dark:border-gray-800"><td className="py-1">{c.category}</td><td className="py-1 text-right tabular-nums">{c.count}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}

      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(address.trim().toLowerCase()); }}>
        <input type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={o.lookupPlaceholder} aria-label={o.lookupPlaceholder} className="w-64 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800" data-testid="email-optout-address" />
        <button type="submit" className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" data-testid="email-optout-lookup">{o.lookup}</button>
        {query && <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => { setQuery(''); setAddress(''); }}>{o.clear}</button>}
      </form>

      {body && (query || body.entries.length > 0) && (
        body.entries.length === 0 ? (
          <p className="mt-2 text-xs text-gray-500" data-testid="email-optout-none">{o.none}</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 text-xs dark:divide-gray-800" data-testid="email-optout-entries">
            {body.entries.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5" data-testid="email-optout-entry">
                <span className="truncate">{e.to} · {e.category ?? '—'}</span>
                <span className="text-gray-500">{e.error} · {formatDateTime(e.createdAt, locale)}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
