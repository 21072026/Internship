'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { PREMIUM_FEATURES } from '@/lib/entitlementsCatalog';

// Admin modal to toggle a company's premium features (freemium Faz 0). Purely
// enables/disables entitlements; the features themselves ship in later phases.
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
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/companies/${companyId}/entitlements`)
      .then((r) => r.json())
      .then((d) => setFeatures(d.features ?? {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [companyId]);

  const toggle = async (feature: string, enabled: boolean) => {
    setBusy(feature);
    setFeatures((s) => ({ ...s, [feature]: enabled })); // optimistic
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/entitlements`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature, enabled }),
      });
      const d = await res.json();
      if (res.ok) setFeatures(d.features ?? {});
      else setFeatures((s) => ({ ...s, [feature]: !enabled }));
    } catch {
      setFeatures((s) => ({ ...s, [feature]: !enabled }));
    } finally {
      setBusy(null);
    }
  };

  const labels = e.features as Record<string, string>;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">{e.title}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-4">{e.subtitle.replace('{name}', companyName)}</p>

        {loading ? (
          <p className="text-center py-8 text-gray-400">{t.common.loading}</p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {PREMIUM_FEATURES.map((f) => (
              <label key={f.key} className="flex items-start justify-between gap-4 py-3 cursor-pointer">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {labels[f.key] ?? f.key}
                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                      {(e.phase as string).replace('{n}', String(f.phase))}
                    </span>
                  </p>
                </div>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 flex-shrink-0"
                  checked={!!features[f.key]}
                  disabled={busy === f.key}
                  onChange={(ev) => toggle(f.key, ev.target.checked)}
                />
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onClose}>{e.done}</Button>
        </div>
      </div>
    </div>
  );
}
