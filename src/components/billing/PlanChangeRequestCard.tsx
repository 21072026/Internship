'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useT } from '@/i18n/client';
import { BILLING_INTERVALS, getPlan, type BillingInterval } from '@/lib/plans';
import { PLAN_CHANGE_REASON_MAX, REQUESTABLE_PLAN_KEYS } from '@/lib/planChangeRule';

// "Change plan" on /admin/billing (#1743): files the org's one open request
// with POST /api/org/plan-change (a second submit updates it) and shows the
// latest request's state — waiting, applied, or declined with the operator's
// note. There is no checkout, so this request is the whole upgrade path.

interface RequestRow {
  id: string;
  requestedPlan: string;
  billingCycle: string;
  status: 'NEW' | 'APPLIED' | 'REJECTED';
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export function PlanChangeRequestCard({ currentPlan, initialPlan }: { currentPlan: string; initialPlan?: string }) {
  const t = useT();
  const c = t.billing.planChange;
  const [latest, setLatest] = useState<RequestRow | null>(null);
  const [plan, setPlan] = useState<string>(initialPlan ?? REQUESTABLE_PLAN_KEYS.find((k) => k !== currentPlan) ?? REQUESTABLE_PLAN_KEYS[0]);
  const [cycle, setCycle] = useState<BillingInterval>('YEARLY');
  const [reason, setReason] = useState('');
  const [educationClaim, setEducationClaim] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/org/plan-change')
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((d: { requests: RequestRow[] }) => setLatest(d.requests[0] ?? null))
      .catch(() => setLatest(null));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/org/plan-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedPlan: plan, billingCycle: cycle, reason: reason || null, educationClaim }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage(c.sent);
        load();
      } else if (res.status === 429) {
        setMessage(c.tooMany);
      } else {
        setMessage(c.refusals[d.code as keyof typeof c.refusals] ?? t.common.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const planName = (key: string) => getPlan(key)?.name ?? key;
  const cycleName = (k: string) => c.cycles[k as keyof typeof c.cycles] ?? k;

  return (
    <Card data-testid="plan-change-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="h-5 w-5 text-blue-600" aria-hidden />
          <CardTitle>{c.title}</CardTitle>
        </div>
      </CardHeader>

      {latest && (
        <div className="mb-4 rounded-lg border border-gray-200 p-3 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-200" data-testid={`plan-change-latest-${latest.status}`}>
          <p>
            {fillTemplate(c.latest[latest.status], { plan: planName(latest.requestedPlan), cycle: cycleName(latest.billingCycle) })}{' '}
            <RelativeTime date={latest.status === 'NEW' ? latest.createdAt : latest.updatedAt} />
          </p>
          {latest.status === 'REJECTED' && latest.note && <p className="mt-1 text-gray-600 dark:text-gray-300">{latest.note}</p>}
        </div>
      )}

      <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">
        {c.intro}{' '}
        <Link href="/pricing" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
          {c.seePricing}
        </Link>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-gray-700 dark:text-gray-200">{c.plan}</span>
          <select
            className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            data-testid="plan-change-plan"
          >
            {REQUESTABLE_PLAN_KEYS.map((k) => (
              <option key={k} value={k}>
                {planName(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-gray-700 dark:text-gray-200">{c.cycle}</span>
          <select
            className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            value={cycle}
            onChange={(e) => setCycle(e.target.value as BillingInterval)}
            data-testid="plan-change-cycle"
          >
            {BILLING_INTERVALS.map((k) => (
              <option key={k} value={k}>
                {cycleName(k)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="text-gray-700 dark:text-gray-200">{c.reason}</span>
        <textarea
          className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          rows={3}
          maxLength={PLAN_CHANGE_REASON_MAX}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="plan-change-reason"
        />
      </label>
      <label className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input type="checkbox" checked={educationClaim} onChange={(e) => setEducationClaim(e.target.checked)} data-testid="plan-change-education" />
        {c.educationClaim}
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={busy} data-testid="plan-change-submit">
          {latest?.status === 'NEW' ? c.update : c.submit}
        </Button>
        {message && (
          <span className="text-sm text-gray-700 dark:text-gray-200" role="status" data-testid="plan-change-message">
            {message}
          </span>
        )}
      </div>
    </Card>
  );
}
