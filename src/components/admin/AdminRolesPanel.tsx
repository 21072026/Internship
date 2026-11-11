'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';

// Admin tiers & scope grants (#1579), on /admin/users. Reads and writes
// /api/admin/roles, which only an ORG_ADMIN may open (`admin.grant`); for
// anyone else the API answers 403 and this panel renders nothing. Every guard
// — no self-change, never above one's own tier, the last active ORG_ADMIN
// stays — is server-side (src/lib/adminTierRule.ts); this page shows the
// refusal the API names, it does not decide anything itself.

interface Grant { id: string; cohortName: string | null; companyName: string | null; grantedBy: string | null; grantedAt: string }
interface AdminRow { id: string; fullName: string; email: string; isActive: boolean; tier: string | null; grants: Grant[] }
interface Data { me: string; tiers: string[]; admins: AdminRow[]; cohorts: { id: string; name: string }[]; companies: { id: string; name: string }[] }

const inputClass = 'rounded-lg border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900';

export function AdminRolesPanel() {
  const t = useT();
  const r = t.adminRoles;
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/roles');
    setData(res.ok ? await res.json() : null);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const call = async (init: RequestInit, url = '/api/admin/roles') => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((r.errors as Record<string, string>)[body.code] ?? r.errors.generic);
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const tierLabel = (tier: string | null) => (tier ? (r.tiers as Record<string, string>)[tier] ?? tier : '—');

  return (
    <Card className="mb-6" data-testid="admin-roles-panel">
      <CardHeader><CardTitle>{r.title}</CardTitle></CardHeader>
      <p className="mb-3 text-sm text-gray-500">{r.subtitle}</p>
      {error && <p className="mb-2 text-sm text-red-600" role="alert" data-testid="admin-roles-error">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="py-1 pr-3">{r.person}</th>
              <th className="py-1 pr-3">{r.tier}</th>
              <th className="py-1 pr-3">{r.scope}</th>
            </tr>
          </thead>
          <tbody>
            {data.admins.map((a) => (
              <tr key={a.id} data-testid={`admin-roles-row-${a.id}`} className="border-t border-gray-100 align-top dark:border-gray-800">
                <td className="py-2 pr-3">
                  <div className="font-medium text-gray-900 dark:text-gray-100">{a.fullName}</div>
                  <div className="text-xs text-gray-500 break-all">{a.email}</div>
                  {!a.isActive && <Badge variant="warning">{r.inactive}</Badge>}
                </td>
                <td className="py-2 pr-3">
                  {a.id === data.me ? (
                    <span title={r.selfHint}>{tierLabel(a.tier)}</span>
                  ) : (
                    <select
                      aria-label={r.tier}
                      data-testid={`admin-roles-tier-${a.id}`}
                      className={inputClass}
                      value={a.tier ?? ''}
                      disabled={busy}
                      onChange={(e) => call({ method: 'PATCH', body: JSON.stringify({ userId: a.id, tier: e.target.value }) })}
                    >
                      {data.tiers.map((tier) => <option key={tier} value={tier}>{tierLabel(tier)}</option>)}
                    </select>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {a.tier !== 'PROGRAM_ADMIN' ? (
                    <span className="text-xs text-gray-500">{a.tier === 'OBSERVER' ? r.scopeAllRead : r.scopeAll}</span>
                  ) : (
                    <div className="space-y-1">
                      {a.grants.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{r.noGrants}</p>}
                      {a.grants.map((g) => (
                        <div key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-medium">{[g.cohortName, g.companyName].filter(Boolean).join(' · ')}</span>
                          <span className="text-gray-500">
                            {g.grantedBy ? `${g.grantedBy} · ` : ''}<RelativeTime date={g.grantedAt} />
                          </span>
                          <button type="button" className="text-red-600 hover:underline" disabled={busy} onClick={() => call({ method: 'DELETE' }, `/api/admin/roles?grantId=${encodeURIComponent(g.id)}`)}>
                            {r.revoke}
                          </button>
                        </div>
                      ))}
                      <div className="flex flex-wrap items-center gap-2">
                        <select aria-label={r.addScope} data-testid={`admin-roles-scope-${a.id}`} className={inputClass} value={pick[a.id] ?? ''} onChange={(e) => setPick({ ...pick, [a.id]: e.target.value })}>
                          <option value="">{r.addScope}</option>
                          {data.cohorts.map((c) => <option key={c.id} value={`cohort:${c.id}`}>{r.cohort}: {c.name}</option>)}
                          {data.companies.map((c) => <option key={c.id} value={`company:${c.id}`}>{r.company}: {c.name}</option>)}
                        </select>
                        <button
                          type="button"
                          className="text-blue-600 hover:underline disabled:opacity-50"
                          disabled={busy || !pick[a.id]}
                          onClick={() => {
                            const [kind, id] = (pick[a.id] ?? '').split(':');
                            void call({ method: 'POST', body: JSON.stringify({ userId: a.id, ...(kind === 'cohort' ? { cohortId: id } : { companyId: id }) }) });
                            setPick({ ...pick, [a.id]: '' });
                          }}
                        >
                          {r.grant}
                        </button>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-gray-500">{r.signOutNote}</p>
    </Card>
  );
}
