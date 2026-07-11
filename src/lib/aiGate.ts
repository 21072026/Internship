import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { hasConsent } from '@/lib/consent';
import { isAiConfigured } from '@/lib/cvExtractAi';
import type { ConsentType } from '@prisma/client';

// Central AI gate (Faz 2, #537) — the single wrapper every AI feature goes
// through: consent check → provider configured → monthly quota → call →
// metering. Other AI tasks (#533-#536) build on this; none of them may call
// the provider directly.
//
// Quota: Setting.aiMonthlyQuota calls per calendar month across the org ('0'
// disables AI). Usage is recorded in AiUsage only AFTER a successful call, so
// provider failures never consume credit. Quota exhaustion degrades safely:
// callers get a typed denial and surface a clear message to the operator —
// mentees are never shown a paywall (core flows never depend on AI).

export type AiDenialReason = 'no_consent' | 'not_configured' | 'quota_exceeded';

export type AiGateResult<T> =
  | { ok: true; result: T }
  | { ok: false; reason: AiDenialReason };

export async function getAiQuota(): Promise<{ quota: number; used: number; remaining: number }> {
  const quota = parseInt(await getSetting('aiMonthlyQuota'), 10) || 0;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const used = await prisma.aiUsage.count({ where: { createdAt: { gte: monthStart } } });
  return { quota, used, remaining: Math.max(0, quota - used) };
}

export async function runAiGated<T>(opts: {
  // Feature identifier recorded per call, e.g. 'cv_extract'.
  scope: string;
  // Whose consent gates the call (the person whose data is processed) — omit
  // only for features that process no personal data.
  consent?: { userId: string; type: ConsentType };
  // Recorded for metering/attribution (companyId prepares per-company quotas).
  userId?: string | null;
  companyId?: string | null;
  call: () => Promise<T>;
}): Promise<AiGateResult<T>> {
  if (opts.consent && !(await hasConsent(opts.consent.userId, opts.consent.type))) {
    return { ok: false, reason: 'no_consent' };
  }
  // Quota before configuration (the issue's order: consent → flag → quota →
  // provider): quota 0 means "AI off" regardless of key, and quota behaviour
  // stays testable in environments without a provider key.
  const { quota, used } = await getAiQuota();
  if (quota <= 0 || used >= quota) return { ok: false, reason: 'quota_exceeded' };
  if (!isAiConfigured()) return { ok: false, reason: 'not_configured' };

  const result = await opts.call();
  await prisma.aiUsage
    .create({ data: { scope: opts.scope, userId: opts.userId ?? null, companyId: opts.companyId ?? null } })
    .catch(() => {}); // metering must never break a successful call
  return { ok: true, result };
}
