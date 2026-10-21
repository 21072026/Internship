'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { ArrowUpCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useLocale, useT } from '@/i18n/client';
import { formatEur } from '@/lib/money';
import { liftFor, type GateError } from '@/lib/upgradePrompt';
import type { PlanAudience } from '@/lib/plans';

// The one door on every paywall (#1745): renders a parsed 403 body
// (`plan_limit_reached` or `feature_locked`, src/lib/upgradePrompt.ts) as what
// is blocked, the plan that lifts it at its published price, the promise that
// nothing existing is cut off, and the next step.
//
// Every word comes from the `upgrade` dictionary — never from the server's
// English `error`. Presentation only: the request button posts to
// POST /api/org/plan-change, which checks the role and the org itself.
//
// Never mount this for a MENTEE: a participant never sees a plan or a price
// (the one mentee-facing gate, /api/apply, answers a capacity message instead).

export function UpgradePrompt({
  gate,
  audience = 'PROGRAM',
  className = '',
}: {
  gate: GateError;
  audience?: PlanAudience;
  className?: string;
}) {
  const t = useT();
  const u = t.upgrade;
  const locale = useLocale();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const lift = liftFor(gate, audience);
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');

  const featureLabel = gate.feature ? ((t.entitlements.features as Record<string, string>)[gate.feature] ?? gate.feature) : '';
  const blocked =
    gate.code === 'plan_limit_reached'
      ? u.limitReached.replace('{usage}', String(gate.usage ?? '?')).replace('{limit}', String(gate.limit ?? '?'))
      : u.featureLocked.replace('{feature}', featureLabel);

  const offer =
    lift.kind === 'plan'
      ? (lift.monthlyEur == null ? u.liftPlanNoPrice : u.liftPlan)
          .replace('{plan}', lift.name)
          .replace('{price}', lift.monthlyEur == null ? '' : formatEur(lift.monthlyEur, locale))
      : lift.kind === 'addon'
        ? u.liftAddon.replace('{price}', formatEur(lift.monthlyEur, locale))
        : u.liftContact;

  const request = async () => {
    if (lift.kind !== 'plan') return;
    setState('busy');
    try {
      const res = await fetch('/api/org/plan-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestedPlan: lift.planKey,
          billingCycle: 'YEARLY',
          reason: gate.code === 'plan_limit_reached' ? `plan_limit_reached ${gate.usage ?? '?'}/${gate.limit ?? '?'}` : `feature_locked ${gate.feature ?? ''}`,
        }),
      });
      setState(res.ok ? 'sent' : 'failed');
    } catch {
      setState('failed');
    }
  };

  const canRequest = isAdmin && lift.kind === 'plan' && lift.requestable;

  return (
    <div
      className={`rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-700 ${className}`}
      data-testid="upgrade-prompt"
      data-code={gate.code}
      role="status"
    >
      <div className="flex items-start gap-3">
        <ArrowUpCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-600" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-gray-900 dark:text-gray-100" data-testid="upgrade-prompt-blocked">
            {blocked}
          </p>
          <p className="text-gray-700 dark:text-gray-200" data-testid="upgrade-prompt-offer">
            {offer}
          </p>
          <p className="text-gray-600 dark:text-gray-300">{u.reassurance}</p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            {canRequest && state !== 'sent' && (
              <Button size="sm" onClick={request} disabled={state === 'busy'} data-testid="upgrade-prompt-request">
                {u.request}
              </Button>
            )}
            {state === 'sent' && <span className="text-gray-700 dark:text-gray-200" data-testid="upgrade-prompt-sent">{u.requested}</span>}
            {state === 'failed' && <span className="text-gray-700 dark:text-gray-200">{u.requestFailed}</span>}
            {!isAdmin && (
              <span className="text-gray-600 dark:text-gray-300" data-testid="upgrade-prompt-admin-note">
                {gate.adminsNotified ? u.adminNotified : u.askAdmin}
              </span>
            )}
            <Link href="/pricing" className="font-medium text-blue-600 hover:underline dark:text-blue-400" data-testid="upgrade-prompt-pricing">
              {u.seePricing}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
