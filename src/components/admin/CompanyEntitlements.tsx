'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { PREMIUM_FEATURES } from '@/lib/entitlementsCatalog';
import { useModalFocus } from '@/components/ui/useModalFocus';

type Sources = Record<string, { enabled: boolean; fromPlan: boolean; override: boolean }>;

// Where a company's premium features come from (freemium Faz 0, read-only
// since #1734). A company's access is decided by its ORGANISATION — the plan,
// or a grant on /admin/billing — and this modal only shows the source of each
// feature: the plan/grant, a pre-plan per-company row kept for grandfathering
// (hasFeature() still honours it), or nothing. It writes nothing; the per-
// company toggle that used to sell a feature to one company is gone.
export function CompanyEntitlements({
  companyId,
  companyName,
  onClose,
}: {
  companyId: string;
  companyName: string;
  onClose: () => void;
}) {
  const t = useT();
  const e = t.entitlements;
  const [sources, setSources] = useState<Sources>({});
  const [loading, setLoading] = useState(true);
  const dialogRef = useModalFocus<HTMLDivElement>(true, onClose);

  useEffect(() => {
    fetch(`/api/admin/companies/${companyId}/entitlements`)
      .then((r) => r.json())
      .then((d: { sources?: Sources }) => setSources(d.sources ?? {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [companyId]);

  const labels = e.features as Record<string, string>;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="company-entitlements-title"
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h2 id="company-entitlements-title" className="text-xl font-bold text-gray-900 dark:text-gray-100">{e.title}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{e.subtitle.replace('{name}', companyName)}</p>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-2 mb-4" data-testid="entitlements-read-only">
          {e.readOnly}{' '}
          <Link href="/admin/billing" className="font-medium text-blue-600 hover:underline dark:text-blue-400" data-testid="entitlements-billing-link">
            {e.manageLink}
          </Link>
        </p>

        {loading ? (
          <p className="text-center py-8 text-gray-400">{t.common.loading}</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {PREMIUM_FEATURES.map((f) => {
              // A tenant-scoped feature (white-label, SSO, API) is the org's
              // alone; a company row for it never granted anything (#1742).
              const orgScoped = f.scope === 'org';
              const src = sources[f.key];
              const status = orgScoped ? e.orgScoped : src?.fromPlan ? e.fromPlan : src?.override ? e.legacyOverride : e.off;
              const on = !orgScoped && !!src?.enabled;
              return (
                <li key={f.key} className="flex items-start justify-between gap-4 py-3" data-testid={`entitlement-row-${f.key}`}>
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${on ? 'text-gray-800 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400'}`}>
                      {labels[f.key] ?? f.key}
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        {(e.phase as string).replace('{n}', String(f.phase))}
                      </span>
                    </p>
                    <p
                      data-testid={orgScoped ? `entitlement-org-scoped-${f.key}` : src?.fromPlan ? `entitlement-from-plan-${f.key}` : `entitlement-status-${f.key}`}
                      className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
                    >
                      {status}
                    </p>
                  </div>
                  <span aria-hidden className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${on ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onClose}>{e.done}</Button>
        </div>
      </div>
    </div>
  );
}
