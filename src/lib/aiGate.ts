import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { hasConsent } from '@/lib/consent';
import { isAiConfigured } from '@/lib/cvExtractAi';
import { ambientOrgId } from '@/lib/tenantAmbient';
import { defaultOrgId } from '@/lib/defaultOrg';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { currentPeriod, periodRange } from '@/lib/meteringRules';
import type { ConsentType } from '@prisma/client';

// Central AI gate (Faz 2, #537) — the single wrapper every AI feature goes
// through: consent check → provider configured → monthly quota → call →
// metering. Other AI tasks (#533-#536) build on this; none of them may call
// the provider directly.
//
// Quota: Setting.aiMonthlyQuota calls per calendar month (UTC, the metering
// month of src/lib/meteringRules.ts) PER ORG ('0' disables AI). The quota is a
// tenant setting, so the usage it is compared against is counted in the same
// org — `orgWhere()`, so the default org also owns legacy NULL-org rows — and
// every AiUsage row is stamped with the org whose budget it consumed. An
// unscoped count let one tenant's calls exhaust another tenant's quota.
//
// The org is passed in by the caller (`resolveOrgId(session)`), not read from
// the bound tenant context alone: `withTenantScope` binds nothing while
// MT_ENFORCE_ISOLATION is off, which is every deployment today. A missing org
// falls back to the bound one, then to the default org — the same "no org is
// the default org's" rule as tenantWhere().
//
// Usage is recorded in AiUsage only AFTER a successful call, so
// provider failures never consume credit. Quota exhaustion degrades safely:
// callers get a typed denial and surface a clear message to the operator —
// mentees are never shown a paywall (core flows never depend on AI).

export type AiDenialReason = 'no_consent' | 'not_configured' | 'quota_exceeded';

export type AiGateResult<T> =
  | { ok: true; result: T }
  | { ok: false; reason: AiDenialReason };

async function quotaOrgId(orgId: string | null | undefined): Promise<string> {
  return orgId ?? ambientOrgId() ?? (await defaultOrgId());
}

export async function getAiQuota(
  orgId?: string | null,
): Promise<{ orgId: string; quota: number; used: number; remaining: number }> {
  const org = await quotaOrgId(orgId);
  const quota = parseInt(await getSetting('aiMonthlyQuota', org), 10) || 0;
  const used = await prisma.aiUsage.count({
    where: withinTenant({ createdAt: periodRange(currentPeriod()) }, await orgWhere(org)),
  });
  return { orgId: org, quota, used, remaining: Math.max(0, quota - used) };
}

export async function runAiGated<T>(opts: {
  // Feature identifier recorded per call, e.g. 'cv_extract'.
  scope: string;
  // Whose consent gates the call (the person whose data is processed) — omit
  // only for features that process no personal data.
  consent?: { userId: string; type: ConsentType };
  // The tenant whose quota the call consumes — `resolveOrgId(session)`. Required
  // so a new AI feature cannot silently meter against the default org.
  orgId: string | null;
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
  const { orgId, quota, used } = await getAiQuota(opts.orgId);
  if (quota <= 0 || used >= quota) return { ok: false, reason: 'quota_exceeded' };
  if (!isAiConfigured()) return { ok: false, reason: 'not_configured' };

  const result = await opts.call();
  await prisma.aiUsage
    .create({ data: { scope: opts.scope, orgId, userId: opts.userId ?? null, companyId: opts.companyId ?? null } })
    .catch(() => {}); // metering must never break a successful call
  return { ok: true, result };
}
