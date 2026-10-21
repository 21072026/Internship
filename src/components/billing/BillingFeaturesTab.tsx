'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, CreditCard, Sparkles } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { KNOWN_GRANTABLE_FEATURES } from '@/lib/plans';
import { useOrgBilling } from '@/components/billing/OrgBillingContext';

// The "included features" tab of /admin/billing (#1734): what the plan
// includes and what was granted on top, each marked with its source. Reads the
// same GET /api/org/billing payload as the plan tab (OrgBillingProvider), so
// the page still makes one billing request. A super admin of this world also
// gets the grant form; its endpoint (POST /api/admin/billing/entitlements)
// decides on every write — the form being shown is never the control.

const GRANTABLE = [...KNOWN_GRANTABLE_FEATURES];

export function BillingFeaturesTab() {
  const t = useT();
  const f = t.billing.features;
  const labels = t.entitlements.features as Record<string, string>;
  const locale = useLocale();
  const { data, failed, reload } = useOrgBilling();

  if (failed) return <LoadErrorCard onRetry={reload} testId="billing-load-error" />;
  if (!data) return <SkeletonRows rows={4} />;

  const trialing = data.trialEndsAt && new Date(data.trialEndsAt).getTime() > Date.now();

  return (
    <div className="space-y-6">
      {trialing && (
        <div className="rounded-lg border border-gray-200 p-3 text-sm text-gray-800 dark:border-gray-700 dark:text-gray-100" data-testid="billing-trial-banner">
          {fillTemplate(f.trialEnds, { date: formatDate(data.trialEndsAt!, locale) })}
        </div>
      )}
      {data.cancelAtPeriodEnd && (
        <div className="rounded-lg border border-gray-200 p-3 text-sm text-gray-800 dark:border-gray-700 dark:text-gray-100" data-testid="billing-cancel-notice">
          {data.renewsAt ? fillTemplate(f.cancelsOn, { date: formatDate(data.renewsAt, locale) }) : f.cancels}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" aria-hidden />
            <CardTitle>{f.title}</CardTitle>
          </div>
        </CardHeader>
        {data.features.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="billing-features-empty">
            {f.none}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="billing-features">
            {data.features.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`billing-feature-${row.key}`}>
                <span className="text-sm text-gray-900 dark:text-gray-100">{labels[row.key] ?? row.key}</span>
                <span className="flex items-center gap-2">
                  {row.expiresAt && (
                    <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                      {fillTemplate(f.until, { date: formatDate(row.expiresAt, locale) })}
                    </span>
                  )}
                  <Badge variant={row.source === 'plan' ? 'info' : 'purple'} data-testid={`billing-feature-source-${row.key}`}>
                    {row.source === 'plan' ? f.sourcePlan : f.sourceOverride}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">{t.billing.freeCore}</p>
      </Card>

      {/* The slot the card-billing portal fills once a payment provider exists. */}
      <Card data-testid="billing-manage-slot">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-blue-600" aria-hidden />
            <CardTitle>{f.manageTitle}</CardTitle>
          </div>
        </CardHeader>
        <p className="text-sm text-gray-600 dark:text-gray-300">{f.manageSoon}</p>
      </Card>

      {data.canGrant && <GrantForm onDone={reload} />}
    </div>
  );
}

function GrantForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const f = t.billing.features;
  const labels = t.entitlements.features as Record<string, string>;
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [orgId, setOrgId] = useState('');
  const [feature, setFeature] = useState(GRANTABLE[0]);
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // The orgs of this super admin's world — the same list /admin/organizations shows.
    fetch('/api/admin/organizations')
      .then((r) => (r.ok ? r.json() : { organizations: [] }))
      .then((d: { organizations?: { id: string; name: string }[] }) => {
        const list = d.organizations ?? [];
        setOrgs(list);
        setOrgId((cur) => cur || list[0]?.id || '');
      })
      .catch(() => setOrgs([]));
  }, []);

  const submit = async (action: 'grant' | 'revoke') => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/billing/entitlements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId,
          feature,
          action,
          note: note || null,
          expiresAt: action === 'grant' && until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage(action === 'grant' ? f.granted : f.revoked);
        onDone();
      } else {
        setMessage(d.code === 'expiry_in_past' ? f.expiryInPast : (d.error ?? t.common.error));
      }
    } finally {
      setBusy(false);
    }
  };

  const field = 'mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';

  return (
    <Card data-testid="billing-grant-form">
      <CardHeader>
        <CardTitle>{f.grantTitle}</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{f.grantIntro}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-gray-700 dark:text-gray-200">{f.org}</span>
          <select className={field} value={orgId} onChange={(e) => setOrgId(e.target.value)} data-testid="billing-grant-org">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-gray-700 dark:text-gray-200">{f.feature}</span>
          <select className={field} value={feature} onChange={(e) => setFeature(e.target.value)} data-testid="billing-grant-feature">
            {GRANTABLE.map((k) => (
              <option key={k} value={k}>
                {labels[k] ?? k}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-gray-700 dark:text-gray-200">{f.expiry}</span>
          <input type="date" className={field} value={until} onChange={(e) => setUntil(e.target.value)} data-testid="billing-grant-until" />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700 dark:text-gray-200">{f.note}</span>
          <input type="text" maxLength={1000} className={field} value={note} onChange={(e) => setNote(e.target.value)} data-testid="billing-grant-note" />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => submit('grant')} disabled={busy || !orgId} data-testid="billing-grant-submit">
          {f.grant}
        </Button>
        <Button variant="outline" onClick={() => submit('revoke')} disabled={busy || !orgId} data-testid="billing-grant-revoke">
          {f.revoke}
        </Button>
        {message && (
          <span className="text-sm text-gray-700 dark:text-gray-200" role="status" data-testid="billing-grant-message">
            {message}
          </span>
        )}
      </div>
    </Card>
  );
}
