'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import { PROSPECT_RETENTION_MONTHS } from '@/lib/postCampaignTemplates';

interface ProspectRow {
  id: string;
  name: string;
  lastContactAt: string;
}

interface ProspectPayload {
  applies: boolean;
  total: number;
  items: ProspectRow[];
}

/**
 * Prospects past the 24-month retention period (MKT-4).
 *
 * The list the letters' promise needs: accounts with no customer history, no
 * live contact permission and no contact for longer than the letter says. It
 * renders nothing outside the sales-surface vertical. Erasure is per row and
 * by hand — there is no job behind this list — and the account itself stays.
 */
export function ProspectRetentionPanel() {
  const t = useT();
  const p = t.prospectRetention;
  const [data, setData] = useState<ProspectPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [erasing, setErasing] = useState<string | null>(null);
  const [eraseFailed, setEraseFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/retention/prospects');
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setFailed(false);
    } catch {
      setData(null);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const erase = async (row: ProspectRow) => {
    if (!window.confirm(p.eraseConfirm.replace('{name}', row.name))) return;
    setErasing(row.id);
    setEraseFailed(false);
    try {
      const res = await fetch(`/api/admin/retention/prospects/${encodeURIComponent(row.id)}/erase`, { method: 'POST' });
      if (!res.ok) setEraseFailed(true);
    } catch {
      setEraseFailed(true);
    } finally {
      setErasing(null);
      await load();
    }
  };

  // Outside the sales-surface vertical there are no prospects to review.
  if (!loading && !failed && data && !data.applies) return null;

  return (
    <section className="mt-10" data-testid="prospect-retention">
      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-gray-100">
          <Archive className="h-5 w-5 text-gray-400" aria-hidden />
          {p.title}
          {data && data.total > 0 && (
            <span
              data-testid="prospect-retention-count"
              className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              {data.total}
            </span>
          )}
        </h2>
        <p className="mt-1 text-sm text-gray-500">{p.subtitle.replace('{months}', String(PROSPECT_RETENTION_MONTHS))}</p>
        {eraseFailed && (
          <p role="alert" data-testid="prospect-retention-erase-failed" className="mt-2 text-sm text-red-700 dark:text-red-300">
            {p.eraseFailed}
          </p>
        )}
      </div>

      {loading && !data ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <SkeletonRows rows={3} />
        </div>
      ) : failed ? (
        <div
          data-testid="prospect-retention-error"
          className="rounded-2xl border border-red-200 bg-red-50 p-10 text-center text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
        >
          <p>{p.loadFailed}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
            {p.loadRetry}
          </Button>
        </div>
      ) : !data || data.total === 0 ? (
        <div
          data-testid="prospect-retention-empty"
          className="rounded-2xl border border-gray-200 bg-white p-10 text-center text-gray-400 dark:border-gray-800 dark:bg-gray-900"
        >
          {p.none}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800">
                  <th className="px-4 py-3 font-medium">{p.colAccount}</th>
                  <th className="px-4 py-3 font-medium">{p.colLastContact}</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`prospect-retention-row-${row.id}`}
                    className="border-b border-gray-100 last:border-0 dark:border-gray-800/60"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{row.name}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      <RelativeTime date={row.lastContactAt} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={erasing !== null}
                        onClick={() => void erase(row)}
                        data-testid={`prospect-retention-erase-${row.id}`}
                      >
                        {erasing === row.id ? p.erasing : p.erase}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.items.length < data.total && (
            <p className="mt-2 text-xs text-gray-500">
              {p.truncated.replace('{shown}', String(data.items.length)).replace('{total}', String(data.total))}
            </p>
          )}
        </>
      )}
    </section>
  );
}
