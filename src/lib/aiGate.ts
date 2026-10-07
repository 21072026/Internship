import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { hasConsent } from '@/lib/consent';
import { ambientOrgId } from '@/lib/tenantAmbient';
import { defaultOrgId } from '@/lib/defaultOrg';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { currentPeriod, periodRange } from '@/lib/meteringRules';
import { callProvider, isAiConfigured, trackAiCall, usageOfFailure, type AiCallUsage } from '@/lib/ai/provider';
import { AI_TASKS, type AiTaskId, type AiTaskSpec } from '@/lib/ai/tasks';
import { estimateCostMicros } from '@/lib/ai/pricing';
import { entitled } from '@/lib/entitlements';
import type { ConsentType } from '@prisma/client';
import { findCachedArtifact, type ArtifactVisibility } from '@/lib/ai/artifacts';

// Central AI gate (Faz 2, #537) — the single wrapper every AI feature goes
// through: consent check → entitlement (operator tasks) → monthly quota →
// provider configured → call → metering. Other AI tasks (#533-#536) build on
// this; none of them may call the provider directly.
//
// WHO THE TASK IS FOR decides whether the AI pack is asked for (#1738). The
// decision is made once, in the registry (`audience` in src/lib/ai/tasks.ts —
// a task cannot be registered without it), and read here from the task id:
//
//   task                  audience     route / screen                         AI_PACKAGE
//   cv_extract            participant  the mentee's own CV (B3), also when a   never
//                                      staff role with CV access triggers it
//   cv_feedback           participant  the mentee's own CV, /portal            never
//   interview_prep        participant  the mentee, for themselves, /portal     never
//   interaction_summary   participant  the mentor's own view of their own      never
//                                      mentee (/mentor/mentees/[id])
//   mentor_match          operator     admin triage, /admin/candidates         required
//   survey_summary        operator     admin, /admin/surveys/[id]              required
//   evaluation_insights   operator     admin, /admin/insights                  required
//   weekly_report_digest  operator     admin, /admin/insights                  required
//   analytics_narrative   operator     admin, /admin/analytics                 required
//
// `participant` is the free core: the gate never runs the entitlement query
// on that path (no extra read, no paywall — the denial copy stays the neutral
// "not right now", docs/ai.md § The degradation contract). `operator` asks
// `entitled(orgId, 'AI_PACKAGE')` (#1733) and answers 'not_entitled' when the
// org has neither a plan with the pack nor a grant; the operator routes turn
// that into the shared `403 { code: 'feature_locked', feature: 'AI_PACKAGE' }`.
// The check sits BEFORE the artefact cache on purpose: a locked org reads no
// stored copy of the add-on either. The orgs that existed when the gate went
// live were grandfathered by prisma/backfill-ai-package-grandfather.mjs.
//
// Quota: Setting.aiMonthlyQuota calls per calendar month (UTC, the metering
// month of src/lib/meteringRules.ts) PER ORG ('0' disables AI). The quota is a
// tenant setting, so the usage it is compared against is counted in the same
// org — `orgWhere()`, so the default org also owns legacy NULL-org rows — and
// every AiUsage row is stamped with the org whose budget it consumed. An
// unscoped count let one tenant's calls exhaust another tenant's quota.
//
// The org is passed in by the caller (`settingsOrgOf(session)`), not read from
// the bound tenant context alone: `withTenantScope` binds nothing while
// MT_ENFORCE_ISOLATION is off, which is every deployment today. A missing org
// falls back to the bound one, then to the default org — the same "no org is
// the default org's" rule as tenantWhere().
//
// Usage is recorded in AiUsage only AFTER a successful call, so
// provider failures never consume credit. Quota exhaustion degrades safely:
// callers get a typed denial and surface a clear message to the operator —
// mentees are never shown a paywall (core flows never depend on AI).

// 'provider_error' (#2024): the provider failed even after its retries, or the
// breaker is open. 'not_entitled' (#1738): an operator task in an org without
// the AI pack. Like the others each is a typed denial, never a throw.
export type AiDenialReason = 'no_consent' | 'not_entitled' | 'not_configured' | 'quota_exceeded' | 'provider_error';

/** The paid add-on an operator task needs (#1738). One name, so a route and a test cannot drift from the gate. */
export const AI_PACK_FEATURE = 'AI_PACKAGE' as const;

/** The stored artefact behind a result (#2044), when the call persisted one. */
export interface AiArtifactRef {
  id: string;
  createdAt: string;
  visibility: string;
}

export type AiGateResult<T> =
  | { ok: true; result: T; cached?: boolean; artifact?: AiArtifactRef }
  | { ok: false; reason: AiDenialReason };

/**
 * Keep what the call produced (#2044). With it, an identical request inside the
 * task's TTL (`TASK_TTL_MS`, src/lib/ai/artifacts.ts) is answered from the
 * stored artefact — no provider call, no quota — unless `force` asks for a
 * fresh one; and a successful call is written through. Persisting is
 * best-effort exactly like the meter: a failed write never breaks a result.
 */
export interface AiPersist<T> {
  subjectUserId: string | null;
  createdById: string;
  inputHash: string;
  relationId?: string | null;
  requisitionId?: string | null;
  visibility?: ArtifactVisibility;
  /** Skip the cache and generate again (the explicit Regenerate). */
  force?: boolean;
  /** How the result is stored and read back; plain text by default. */
  serialize?: (result: T) => string;
  deserialize?: (content: string) => T;
}

const refOf = (a: { id: string; createdAt: Date; visibility: string }): AiArtifactRef => ({ id: a.id, createdAt: a.createdAt.toISOString(), visibility: a.visibility });

async function quotaOrgId(orgId: string | null | undefined): Promise<string> {
  return orgId ?? ambientOrgId() ?? (await defaultOrgId());
}

export async function getAiQuota(
  orgId?: string | null,
): Promise<{ orgId: string; quota: number; used: number; remaining: number }> {
  const org = await quotaOrgId(orgId);
  const quota = parseInt(await getSetting('aiMonthlyQuota', org), 10) || 0;
  // A provider failure is recorded (#2024) but never consumes quota.
  const used = await prisma.aiUsage.count({
    where: withinTenant({ createdAt: periodRange(currentPeriod()), outcome: { not: 'provider_error' } }, await orgWhere(org)),
  });
  return { orgId: org, quota, used, remaining: Math.max(0, quota - used) };
}

export async function runAiGated<T>(opts: {
  // The task's registry key (src/lib/ai/tasks.ts), recorded per call as
  // `AiUsage.scope` AND `AiUsage.taskId`. A string outside the registry does
  // not compile (#2022) — a typo used to open a new metering bucket silently.
  scope: AiTaskId;
  // Whose consent gates the call (the person whose data is processed) — omit
  // only for features that process no personal data.
  consent?: { userId: string; type: ConsentType };
  // The tenant whose quota the call consumes — `settingsOrgOf(session)`. Required
  // so a new AI feature cannot silently meter against the default org.
  orgId: string | null;
  // Recorded for metering/attribution (companyId prepares per-company quotas).
  userId?: string | null;
  companyId?: string | null;
  call: () => Promise<T>;
  persist?: AiPersist<T>;
}): Promise<AiGateResult<T>> {
  if (opts.consent && !(await hasConsent(opts.consent.userId, opts.consent.type))) {
    return { ok: false, reason: 'no_consent' };
  }
  // The add-on, for operator tasks only (#1738, the table in the header). A
  // participant task never reaches this read. Before the cache: a locked org
  // is not answered from a stored copy either.
  const task: AiTaskSpec = AI_TASKS[opts.scope];
  if (task.audience === 'operator' && !(await entitled(await quotaOrgId(opts.orgId), AI_PACK_FEATURE))) {
    return { ok: false, reason: 'not_entitled' };
  }
  // Consent first, cache second: a withdrawn consent is not answered from a
  // stored copy either. A hit costs nothing — no provider call, no quota.
  const persist = opts.persist;
  const decode = persist?.deserialize ?? ((c: string) => c as unknown as T);
  if (persist && !persist.force) {
    const hit = await findCachedArtifact({ orgId: await quotaOrgId(opts.orgId), taskId: opts.scope, subjectUserId: persist.subjectUserId, inputHash: persist.inputHash }).catch(() => null);
    // A stored copy that no longer decodes (a format change, a hand-edited
    // row) is a miss, not an error: the provider answers instead.
    if (hit) {
      try {
        return { ok: true, result: decode(hit.content), cached: true, artifact: refOf(hit) };
      } catch {
        /* fall through to a fresh call */
      }
    }
  }
  // Quota before configuration (the issue's order: consent → flag → quota →
  // provider): quota 0 means "AI off" regardless of key, and quota behaviour
  // stays testable in environments without a provider key.
  const { orgId, quota, used } = await getAiQuota(opts.orgId);
  if (quota <= 0 || used >= quota) return { ok: false, reason: 'quota_exceeded' };
  if (!isAiConfigured()) return { ok: false, reason: 'not_configured' };

  // One logical task is one metered call, however many attempts the retries
  // took (src/lib/ai/provider.ts). A failure is recorded, at no cost to the
  // quota, and comes back as a typed denial — never a thrown 500. The row
  // carries what the provider answered with (#2022): the model, both token
  // counts, the list-price cost and the latency — null when the task never
  // reached `callModel` (a stub in a test) or the model is not priced.
  const record = (outcome: 'ok' | 'parse_error' | 'provider_error', usage: AiCallUsage | null) =>
    prisma.aiUsage
      .create({
        data: {
          scope: opts.scope,
          taskId: opts.scope,
          orgId,
          userId: opts.userId ?? null,
          companyId: opts.companyId ?? null,
          outcome,
          provider: usage?.provider ?? null,
          model: usage?.model ?? null,
          inputTokens: usage && usage.completed > 0 ? usage.inputTokens : null,
          outputTokens: usage && usage.completed > 0 ? usage.outputTokens : null,
          costMicros: usage && usage.completed > 0 ? estimateCostMicros(usage.model, usage.inputTokens, usage.outputTokens) : null,
          latencyMs: usage && usage.completed > 0 ? usage.latencyMs : null,
        },
      })
      .catch(() => {}); // metering must never break the call
  try {
    const { result, parseError, usage } = await trackAiCall(() => callProvider(opts.call));
    await record(parseError ? 'parse_error' : 'ok', usage);
    // A fallback result (the reply was not what was asked for) is not worth
    // keeping: it would answer the next identical request with the fallback.
    if (!persist || parseError) return { ok: true, result };
    const stored = await prisma.aiArtifact
      .create({
        data: {
          orgId,
          taskId: opts.scope,
          subjectUserId: persist.subjectUserId,
          createdById: persist.createdById,
          relationId: persist.relationId ?? null,
          requisitionId: persist.requisitionId ?? null,
          inputHash: persist.inputHash,
          content: persist.serialize ? persist.serialize(result) : String(result),
          visibility: persist.visibility ?? 'PRIVATE',
        },
        select: { id: true, createdAt: true, visibility: true },
      })
      .catch(() => null); // persisting must never break a successful call
    return { ok: true, result, ...(stored ? { artifact: refOf(stored) } : {}) };
  } catch (error) {
    console.error('[ai] provider call failed', { scope: opts.scope, error: String(error) });
    await record('provider_error', usageOfFailure(error));
    return { ok: false, reason: 'provider_error' };
  }
}
