'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { INVITATION_FUNNEL_STAGES, funnelRate, type FunnelCounts } from '@/lib/invitationFunnelRule';

// The invitation funnel on the invitation board (#1921): sent → opened →
// registered → signed in, for the invitations sent in the board's date range.
// The numbers come from GET /api/admin/invitations/funnel; the stages are
// src/lib/invitationFunnelRule.ts. Every step is an in-app event, so the card
// says so — there is no mail pixel behind any of it.

interface FunnelResponse {
  total: FunnelCounts;
  byRole: ({ role: string } & FunnelCounts)[];
  byInviter: ({ invitedById: string | null; inviterName: string | null } & FunnelCounts)[];
  revoked: number;
}

/** How many inviters the card lists; the API returns up to 50. */
const INVITER_ROWS = 10;

export function InvitationFunnelCard({ from, to }: { from: string; to: string }) {
  const t = useT();
  const v = t.invitations.funnel;
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    fetch(`/api/admin/invitations/funnel?${p.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((d: FunnelResponse) => {
        if (!live) return;
        setData(d);
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [from, to]);

  const roleLabel = (role: string) => (t.reports.role as Record<string, string>)[role] ?? role;

  const table = (rows: (FunnelCounts & { key: string; label: string })[], head: string, testId: string) => (
    <table className="mt-2 w-full text-sm" data-testid={testId}>
      <thead>
        <tr className="text-left text-gray-500 dark:text-gray-400">
          <th className="py-1 pr-3 font-medium">{head}</th>
          {INVITATION_FUNNEL_STAGES.map((s) => (
            <th key={s} className="py-1 pr-3 text-right font-medium">
              {v.stage[s]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-gray-100 dark:border-gray-700" data-testid={`${testId}-${r.key}`}>
            <td className="py-1 pr-3">{r.label}</td>
            {INVITATION_FUNNEL_STAGES.map((s) => (
              <td key={s} className="py-1 pr-3 text-right tabular-nums" data-testid={`${testId}-${r.key}-${s}`}>
                {r[s]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <section className="mb-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="invitation-funnel">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.title}</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{v.note}</p>
      {failed && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-300" data-testid="invitation-funnel-error">
          {v.failed}
        </p>
      )}
      {data && (
        <>
          <ol className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {INVITATION_FUNNEL_STAGES.map((s, i) => {
              const rate = i > 0 ? funnelRate(data.total[s], data.total[INVITATION_FUNNEL_STAGES[i - 1]]) : null;
              return (
                <li key={s} className="rounded-md border border-gray-200 p-3 dark:border-gray-700" data-testid={`invitation-funnel-${s}`}>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{v.stage[s]}</div>
                  <div className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100" data-testid={`invitation-funnel-${s}-count`}>
                    {data.total[s]}
                  </div>
                  {rate !== null && <div className="text-xs text-gray-500 dark:text-gray-400">{v.ofPrevious.replace('{rate}', String(rate))}</div>}
                </li>
              );
            })}
          </ol>
          {data.byRole.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{v.byRole}</h3>
              {table(
                data.byRole.map((r) => ({ ...r, key: r.role, label: roleLabel(r.role) })),
                v.role,
                'invitation-funnel-role',
              )}
            </div>
          )}
          {data.byInviter.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{v.byInviter}</h3>
              {table(
                data.byInviter.slice(0, INVITER_ROWS).map((r) => ({ ...r, key: r.invitedById ?? 'none', label: r.inviterName ?? v.unknownInviter })),
                v.inviter,
                'invitation-funnel-inviter',
              )}
            </div>
          )}
          {data.revoked > 0 && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400" data-testid="invitation-funnel-revoked">
              {v.revoked.replace('{count}', String(data.revoked))}
            </p>
          )}
        </>
      )}
    </section>
  );
}
