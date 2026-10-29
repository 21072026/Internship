'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useLocale, useT } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { planDisplayName, upgradeOffer, type GateInfo } from '@/lib/upgradePrompt';
import type { PlanAudience } from '@/lib/plans';

// The one door on every plan wall (#1745): a 403 `plan_limit_reached` or
// `feature_locked`, parsed by src/lib/upgradePrompt.ts, rendered as what is
// blocked, the plan that lifts it with its published price, and the next step.
//
// Every word comes from the dictionary — never from the server's English
// `error` field. Presentation only: POST /api/org/plan-change does its own role
// and org checks, and the gate itself stays on the server.
//
// `viewer` decides the action, never the copy of the blocker:
//   admin   — may file the upgrade request (programme wallet only);
//   staff   — a mentor or a non-request admin surface: told to ask an admin;
//   company — an employer account: pointed at the pricing page.
// NEVER rendered for a mentee (FREE CORE): the mentee-facing gate answers a
// capacity message instead (POST /api/apply → `program_full`).
export function UpgradePrompt({
  gate,
  viewer,
  audience = 'PROGRAM',
  className = '',
}: {
  gate: GateInfo;
  viewer: 'admin' | 'staff' | 'company';
  audience?: PlanAudience;
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const u = t.upgrade;
  const [request, setRequest] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const offer = upgradeOffer(gate, audience);
  const money = (eur: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(eur);

  const featureName = gate.code === 'feature_locked' ? t.entitlements.features[gate.feature] : '';
  const title = gate.code === 'feature_locked' ? fillTemplate(u.featureTitle, { feature: featureName }) : u.limitTitle;
  const body =
    gate.code === 'feature_locked'
      ? offer
        ? fillTemplate(u.featureBody, { feature: featureName, plan: offer.planName })
        : u.featureNoPlan
      : fillTemplate(u.limitBody, {
          usage: String(gate.usage ?? '?'),
          limit: String(gate.limit ?? '?'),
          plan: planDisplayName(gate.plan) ?? '?',
        });
  const price = offer
    ? offer.yearly !== null
      ? fillTemplate(u.priceYearly, { plan: offer.planName, price: money(offer.yearly) })
      : offer.monthly !== null
        ? fillTemplate(u.priceMonthly, { plan: offer.planName, price: money(offer.monthly) })
        : null
    : null;

  // The request names the offered plan on its yearly price when it has one
  // (Enterprise is annual-only); the operator confirms the rest.
  const canRequest = viewer === 'admin' && audience === 'PROGRAM' && !!offer;
  const send = async () => {
    if (!offer) return;
    setRequest('sending');
    try {
      const res = await fetch('/api/org/plan-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedPlan: offer.planKey, billingCycle: offer.yearly !== null ? 'YEARLY' : 'MONTHLY' }),
      });
      setRequest(res.ok ? 'sent' : 'failed');
    } catch {
      setRequest('failed');
    }
  };

  return (
    <Card className={`border-amber-200 dark:border-amber-800 ${className}`} data-testid="upgrade-prompt" data-gate={gate.code}>
      <div className="flex items-start gap-3">
        <Lock className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
          <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="upgrade-prompt-body">{body}</p>
          {price && <p className="text-sm font-medium text-gray-900 dark:text-gray-100" data-testid="upgrade-prompt-price">{price}</p>}
          {gate.code === 'plan_limit_reached' && <p className="text-xs text-gray-500 dark:text-gray-400">{u.reassurance}</p>}
          {viewer === 'staff' && <p className="text-xs text-gray-500 dark:text-gray-400">{u.askAdmin}</p>}
          {viewer === 'company' && <p className="text-xs text-gray-500 dark:text-gray-400">{u.contactSales}</p>}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {canRequest && request !== 'sent' && (
              <Button size="sm" onClick={send} disabled={request === 'sending'} data-testid="upgrade-prompt-request">
                {request === 'sending' ? u.requesting : u.request}
              </Button>
            )}
            <Link href="/pricing" className="text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="upgrade-prompt-pricing">
              {u.seePricing}
            </Link>
          </div>
          {request === 'sent' && (
            <p className="text-sm text-green-700 dark:text-green-400" role="status">
              {u.requested}{' '}
              <Link href="/admin/billing" className="underline">{u.openBilling}</Link>
            </p>
          )}
          {request === 'failed' && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {u.requestFailed}{' '}
              <Link href="/admin/billing" className="underline">{u.openBilling}</Link>
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
