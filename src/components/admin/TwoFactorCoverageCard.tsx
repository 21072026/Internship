'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';
import type { RoleCoverage, TwoFactorRole } from '@/lib/twoFactorPolicyRule';

// The two-factor enrolment coverage of the tenant (#1644), rendered next to
// the policy select on /admin/settings: per role, how many active accounts
// have 2FA on, and the list of those who do not — exactly the people a
// stricter policy would hold at the setup gate on their next page load. The
// numbers come from GET /api/admin/2fa-coverage (org-scoped server-side); the
// rows are handed up through `onRows` so the form can say, before an admin
// switches to a stricter mode, how many accounts that locks out.

export interface CoverageResponse {
  policy: string;
  roles: RoleCoverage[];
  overall: { total: number; enabled: number; percentage: number };
  missing: {
    total: number;
    page: number;
    perPage: number;
    items: { id: string; fullName: string; email: string; role: string; lastLoginAt: string | null }[];
  };
}

export function TwoFactorCoverageCard({
  onRows,
  reloadKey = 0,
}: {
  onRows?: (rows: RoleCoverage[]) => void;
  /** Bump to refetch (after the policy was saved). */
  reloadKey?: number;
}) {
  const t = useT();
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async (p: number) => {
    setState('loading');
    try {
      const res = await fetch(`/api/admin/2fa-coverage?page=${p}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as CoverageResponse;
      setData(body);
      setState('ready');
      onRows?.(body.roles);
    } catch {
      setState('error');
    }
  }, [onRows]);

  useEffect(() => {
    void load(page);
  }, [load, page, reloadKey]);

  const roleLabel = (role: string) => {
    const labels: Record<TwoFactorRole, string> = {
      ADMIN: t.personCard.roleAdmin,
      MENTOR: t.personCard.roleMentor,
      MENTEE: t.personCard.roleMentee,
      COMPANY: t.personCard.roleCompany,
      SOURCE: t.personCard.roleSource,
      AFFILIATE: t.personCard.roleAffiliate,
    };
    return labels[role as TwoFactorRole] ?? role;
  };

  const pages = data ? Math.max(1, Math.ceil(data.missing.total / data.missing.perPage)) : 1;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3" data-testid="two-factor-coverage" data-state={state}>
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.settings.twoFactorCoverage}</p>
        <p className="text-xs text-gray-500 mt-0.5">{t.settings.twoFactorCoverageHint}</p>
      </div>
      {state === 'error' && <p className="text-sm text-red-600" role="alert">{t.settings.twoFactorCoverageLoadFailed}</p>}
      {data && (
        <>
          <table className="w-full text-sm" data-testid="two-factor-coverage-roles">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-1 pr-2 font-medium">{t.settings.twoFactorCoverageRole}</th>
                <th className="py-1 pr-2 font-medium">{t.settings.twoFactorCoverageEnabled}</th>
                <th className="py-1 font-medium">{t.settings.twoFactorCoverageShare}</th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.role} data-testid={`two-factor-coverage-role-${r.role}`} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1 pr-2 text-gray-700 dark:text-gray-300">{roleLabel(r.role)}</td>
                  <td className="py-1 pr-2 tabular-nums text-gray-700 dark:text-gray-300">{r.enabled} / {r.total}</td>
                  <td className="py-1 tabular-nums text-gray-700 dark:text-gray-300">{r.percentage}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{t.settings.twoFactorCoverageMissing}</p>
            {data.missing.total > 0 && (
              <a
                href="/api/admin/2fa-coverage?format=csv"
                className="text-xs text-blue-600 hover:underline"
                data-testid="two-factor-coverage-export"
              >
                {t.settings.twoFactorCoverageExport}
              </a>
            )}
          </div>
          {data.missing.total === 0 ? (
            <p className="text-xs text-gray-500" data-testid="two-factor-coverage-none">{t.settings.twoFactorCoverageNone}</p>
          ) : (
            <>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800 text-sm" data-testid="two-factor-coverage-missing">
                {data.missing.items.map((u) => (
                  <li key={u.id} className="py-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="min-w-0">
                      <span className="text-gray-800 dark:text-gray-200">{u.fullName}</span>
                      <span className="text-gray-500"> · {u.email}</span>
                    </span>
                    <span className="text-xs text-gray-500 sm:whitespace-nowrap">
                      {roleLabel(u.role)} · {t.settings.twoFactorCoverageLastSignIn}{' '}
                      {u.lastLoginAt ? <RelativeTime date={u.lastLoginAt} /> : t.settings.twoFactorCoverageNever}
                    </span>
                  </li>
                ))}
              </ul>
              {pages > 1 && (
                <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
                  <span>{fillTemplate(t.settings.twoFactorCoveragePage, { page: data.missing.page, pages, total: data.missing.total })}</span>
                  <span className="flex gap-1">
                    <Button type="button" size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                      {t.settings.twoFactorCoveragePrev}
                    </Button>
                    <Button type="button" size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                      {t.settings.twoFactorCoverageNext}
                    </Button>
                  </span>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
