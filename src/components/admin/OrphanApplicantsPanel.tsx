'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Ghost, MailPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { UserEraseForm } from '@/components/UserEraseForm';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

interface OrphanRow {
  id: string;
  fullName: string;
  email: string;
  createdAt: string;
  declinedAt: string | null;
  declinedBy: string | null;
  ageDays: number;
  daysUntilAnonymize: number;
}

interface OrphanPayload {
  graceDays: number;
  total: number;
  due: number;
  truncated: boolean;
  items: OrphanRow[];
}

/**
 * The orphan-applicant dry run (#1780).
 *
 * Sits under the consent-based retention review because it answers the same
 * question — "whose data are we still holding, and why?" — for the accounts the
 * consent rule can never see: a /apply account has no `consentAt` to age.
 *
 * The list is deliberately a PREVIEW of an automatic, irreversible job. Nothing
 * here erases on its own; what it shows is what the 03:20 sweep will take, with
 * the days each account has left, so an admin can intervene before it happens.
 * Both per-row actions go to endpoints that already existed: the erasure gates
 * of `UserEraseForm` (name + the admin's own password) and the admin
 * send-a-link endpoint for the case where the decline was a mistake or the
 * address was simply wrong.
 */
export function OrphanApplicantsPanel() {
  const t = useT();
  const o = t.orphanApplicants;
  const locale = useLocale();
  const [data, setData] = useState<OrphanPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [erasing, setErasing] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, 'ok' | 'failed'>>({});
  const [sending, setSending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/orphan-applicants');
      setData(res.ok ? await res.json() : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendActivation = async (row: OrphanRow) => {
    setSending(row.id);
    try {
      const res = await fetch(`/api/admin/users/${row.id}/reset-password`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      // The endpoint reports what the transport actually did, so a demo-mode or
      // no-SMTP install does not get told the mail went out.
      setSent((prev) => ({ ...prev, [row.id]: res.ok && body.emailSent !== false ? 'ok' : 'failed' }));
    } catch {
      setSent((prev) => ({ ...prev, [row.id]: 'failed' }));
    } finally {
      setSending(null);
    }
  };

  return (
    <section className="mt-10" data-testid="orphan-applicants">
      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-gray-100">
          <Ghost className="h-5 w-5 text-gray-400" aria-hidden />
          {o.title}
          {data && data.total > 0 && (
            <span
              data-testid="orphan-applicants-count"
              className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              {data.total}
            </span>
          )}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          {o.subtitle.replace('{grace}', String(data?.graceDays ?? '—'))}
        </p>
        {data && data.due > 0 && (
          <p data-testid="orphan-applicants-due" className="mt-2 text-sm font-medium text-red-700 dark:text-red-300">
            {o.dueNow.replace('{n}', String(data.due))}
          </p>
        )}
      </div>

      {loading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <SkeletonRows rows={3} />
        </div>
      ) : !data || data.total === 0 ? (
        <div
          data-testid="orphan-applicants-empty"
          className="rounded-2xl border border-gray-200 bg-white p-10 text-center text-gray-400 dark:border-gray-800 dark:bg-gray-900"
        >
          {o.none}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800">
                <th className="px-4 py-3 font-medium">{o.colApplicant}</th>
                <th className="px-4 py-3 font-medium">{o.colApplied}</th>
                <th className="px-4 py-3 font-medium">{o.colDeclinedBy}</th>
                <th className="px-4 py-3 font-medium">{o.colDeleteIn}</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`orphan-row-${row.id}`}
                  className="border-b border-gray-100 last:border-0 dark:border-gray-800/60"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/candidates/${row.id}`}
                      className="font-medium text-gray-900 hover:underline dark:text-gray-100"
                    >
                      {row.fullName}
                    </Link>
                    <div className="text-xs text-gray-400">{row.email}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {formatDate(row.createdAt, locale)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {row.declinedBy ?? o.noDecision}
                    {row.declinedAt && (
                      <div className="text-xs text-gray-400">{formatDate(row.declinedAt, locale)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.daysUntilAnonymize === 0
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
                      }`}
                    >
                      {row.daysUntilAnonymize === 0
                        ? o.dueLabel
                        : o.daysLeft.replace('{n}', String(row.daysUntilAnonymize))}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {erasing === row.id ? (
                      <UserEraseForm
                        userId={row.id}
                        fullName={row.fullName}
                        allowAnonymize
                        onCancel={() => setErasing(null)}
                        onDone={() => {
                          setErasing(null);
                          void load();
                        }}
                      />
                    ) : (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {sent[row.id] && (
                          <span
                            className={`text-xs ${
                              sent[row.id] === 'ok'
                                ? 'text-green-700 dark:text-green-300'
                                : 'text-red-700 dark:text-red-300'
                            }`}
                          >
                            {sent[row.id] === 'ok' ? o.activationSent : o.activationFailed}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          loading={sending === row.id}
                          onClick={() => sendActivation(row)}
                          data-testid={`orphan-activate-${row.id}`}
                        >
                          <MailPlus className="mr-1 h-4 w-4" />
                          {o.sendActivation}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setErasing(row.id)}
                          data-testid={`orphan-erase-${row.id}`}
                        >
                          {o.erase}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.truncated && (
            <p className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500 dark:border-gray-800/60">
              {o.truncated.replace('{shown}', String(data.items.length)).replace('{total}', String(data.total))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
