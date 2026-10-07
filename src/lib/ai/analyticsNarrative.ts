// The "what changed" paragraph on /admin/analytics (#2046), server-only. The
// figures are recomputed here from src/lib/adminAnalyticsData.ts — the same
// numbers the cards show, never numbers a client sent — and the reply is kept
// only if every figure it cites is one of them (src/lib/ai/narrativeRules.ts).
// Cached as a subject-less AiArtifact keyed on the facts and the language, so
// a page view re-reads the stored paragraph instead of regenerating it.
// An operator task (#1738): `locked` is asked once per call, of the org the
// gate meters, and a locked org reads no stored paragraph either — the gate's
// "before the cache" rule, mirrored here for the peek that bypasses the gate.

import type { Session } from 'next-auth';
import type { Locale } from '@/i18n/config';
import { AI_PACK_FEATURE, runAiGated, type AiArtifactRef, type AiDenialReason } from '@/lib/aiGate';
import { entitled } from '@/lib/entitlements';
import { findCachedArtifact, hashInput, TASK_TTL_MS } from '@/lib/ai/artifacts';
import { prisma } from '@/lib/prisma';
import { callModel, noteParseError } from '@/lib/ai/provider';
import { defaultOrgId } from '@/lib/defaultOrg';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { loadAdminAnalytics } from '@/lib/adminAnalyticsData';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { acceptNarrative, analyticsFacts, factsText, type Fact } from '@/lib/ai/narrativeRules';

const LANGUAGE: Record<Locale, string> = { en: 'English', tr: 'Turkish', de: 'German' };
const SCOPE = 'analytics_narrative' as const;

const SYSTEM = `You write a short "what changed" paragraph for the team that runs a mentoring and internship programme, from the dashboard figures you are given.
Rules:
- 3 to 5 plain sentences. No headings, no lists, no advice.
- Cite only numbers that appear in the figures, exactly as written. Never compute a difference, a percentage or a total of your own, never round.
- Describe what changed between periods and what stands out. When the figures do not show WHY something changed, say that the cause is not visible in these figures. Never invent a cause.
- Do not name or describe any person.`;

async function callProvider(facts: Fact[], locale: Locale): Promise<string | null> {
  const reply = await callModel({ task: SCOPE, system: SYSTEM, input: `Write in ${LANGUAGE[locale]}.\n\nFigures:\n${factsText(facts)}` });
  const kept = acceptNarrative(reply, facts);
  // Ungrounded or empty: metered as parse_error and never stored.
  if (!kept) noteParseError();
  return kept;
}

export interface NarrativeBody {
  narrative: string | null;
  cached: boolean;
  artifact: AiArtifactRef | null;
  reason: AiDenialReason | 'unreadable' | null;
  /** The org lacks the AI pack (#1738): no paragraph, stored or fresh; the cards still render. */
  locked: boolean;
}

async function factsFor(session: Session, params: { from: string | null; to: string | null }, locale: Locale): Promise<Fact[]> {
  const analytics = await loadAdminAnalytics(session, params, locale);
  const stages = await resolvePipelineStages((session.user as { orgId?: string | null }).orgId ?? null, locale);
  return analyticsFacts(analytics, (key) => stageLabel(stages, key, locale));
}

export async function analyticsNarrative(
  session: Session,
  params: { from: string | null; to: string | null },
  locale: Locale,
  mode: { run: false } | { run: true; regenerate?: boolean },
): Promise<NarrativeBody> {
  const orgId = await settingsOrgOf(session);
  const locked = !(await entitled(orgId, AI_PACK_FEATURE));
  const none: NarrativeBody = { narrative: null, cached: false, artifact: null, reason: null, locked };
  if (!mode.run) {
    if (locked) return none;
    // The dashboard calls this on every view, next to GET /api/admin/analytics
    // computing the very same figures. Recomputing them here only pays off
    // when a paragraph could exist at all, so the cheap question goes first:
    // an org that never wrote one (or not within the TTL) costs one indexed
    // read, not a second copy of the dashboard's queries.
    const any = await prisma.aiArtifact
      .findFirst({ where: { orgId: orgId ?? (await defaultOrgId()), taskId: SCOPE, subjectUserId: null, createdAt: { gte: new Date(Date.now() - TASK_TTL_MS[SCOPE]) } }, select: { id: true } })
      .catch(() => null);
    if (!any) return none;
  }
  const facts = await factsFor(session, params, locale);
  const inputHash = hashInput({ facts, locale });
  if (!mode.run) {
    const hit = await findCachedArtifact({ orgId: orgId ?? (await defaultOrgId()), taskId: SCOPE, subjectUserId: null, inputHash }).catch(() => null);
    return hit
      ? { narrative: hit.content, cached: true, artifact: { id: hit.id, createdAt: hit.createdAt.toISOString(), visibility: hit.visibility }, reason: null, locked }
      : none;
  }
  // The gate decides (a locked org gets 'not_entitled' before the cache); the
  // route answers that one reason with the 403, every other as today.
  const gated = await runAiGated<string | null>({
    scope: SCOPE,
    orgId,
    userId: session.user.id,
    call: () => callProvider(facts, locale),
    persist: { subjectUserId: null, createdById: session.user.id, inputHash, force: mode.regenerate, serialize: (r) => r ?? '' },
  }).catch(() => ({ ok: false as const, reason: 'provider_error' as const }));
  if (!gated.ok) return { narrative: null, cached: false, artifact: null, reason: gated.reason, locked };
  if (!gated.result) return { narrative: null, cached: false, artifact: null, reason: 'unreadable', locked };
  return { narrative: gated.result, cached: !!gated.cached, artifact: gated.artifact ?? null, reason: null, locked };
}
