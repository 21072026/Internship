// The "what changed" paragraph on /admin/analytics (#2046), server-only. The
// figures are recomputed here from src/lib/adminAnalyticsData.ts — the same
// numbers the cards show, never numbers a client sent — and the reply is kept
// only if every figure it cites is one of them (src/lib/ai/narrativeRules.ts).
// Cached as a subject-less AiArtifact keyed on the facts and the language, so
// a page view re-reads the stored paragraph instead of regenerating it.

import Anthropic from '@anthropic-ai/sdk';
import type { Session } from 'next-auth';
import type { Locale } from '@/i18n/config';
import { runAiGated, type AiArtifactRef, type AiDenialReason } from '@/lib/aiGate';
import { findCachedArtifact, hashInput } from '@/lib/ai/artifacts';
import { noteParseError } from '@/lib/ai/provider';
import { defaultOrgId } from '@/lib/defaultOrg';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { loadAdminAnalytics } from '@/lib/adminAnalyticsData';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { acceptNarrative, analyticsFacts, factsText, type Fact } from '@/lib/ai/narrativeRules';

const AI_TIMEOUT_MS = 60_000;
const MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || process.env.ANTHROPIC_CV_MODEL || 'claude-opus-4-8';
const LANGUAGE: Record<Locale, string> = { en: 'English', tr: 'Turkish', de: 'German' };
const SCOPE = 'analytics_narrative';

const SYSTEM = `You write a short "what changed" paragraph for the team that runs a mentoring and internship programme, from the dashboard figures you are given.
Rules:
- 3 to 5 plain sentences. No headings, no lists, no advice.
- Cite only numbers that appear in the figures, exactly as written. Never compute a difference, a percentage or a total of your own, never round.
- Describe what changed between periods and what stands out. When the figures do not show WHY something changed, say that the cause is not visible in these figures. Never invent a cause.
- Do not name or describe any person.`;

async function callProvider(facts: Fact[], locale: Locale): Promise<string | null> {
  const client = new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: 0 }); // retries are runAiGated's (src/lib/ai/provider.ts, #2024)
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Write in ${LANGUAGE[locale]}.\n\nFigures:\n${factsText(facts)}` }],
  });
  const block = res.content.find((b) => b.type === 'text');
  const kept = acceptNarrative(block && block.type === 'text' ? block.text : '', facts);
  // Ungrounded or empty: metered as parse_error and never stored.
  if (!kept) noteParseError();
  return kept;
}

export interface NarrativeBody {
  narrative: string | null;
  cached: boolean;
  artifact: AiArtifactRef | null;
  reason: AiDenialReason | 'unreadable' | null;
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
  const facts = await factsFor(session, params, locale);
  const orgId = await settingsOrgOf(session);
  const inputHash = hashInput({ facts, locale });
  if (!mode.run) {
    const hit = await findCachedArtifact({ orgId: orgId ?? (await defaultOrgId()), taskId: SCOPE, subjectUserId: null, inputHash }).catch(() => null);
    return hit
      ? { narrative: hit.content, cached: true, artifact: { id: hit.id, createdAt: hit.createdAt.toISOString(), visibility: hit.visibility }, reason: null }
      : { narrative: null, cached: false, artifact: null, reason: null };
  }
  const gated = await runAiGated<string | null>({
    scope: SCOPE,
    orgId,
    userId: session.user.id,
    call: () => callProvider(facts, locale),
    persist: { subjectUserId: null, createdById: session.user.id, inputHash, force: mode.regenerate, serialize: (r) => r ?? '' },
  }).catch(() => ({ ok: false as const, reason: 'provider_error' as const }));
  if (!gated.ok) return { narrative: null, cached: false, artifact: null, reason: gated.reason };
  if (!gated.result) return { narrative: null, cached: false, artifact: null, reason: 'unreadable' };
  return { narrative: gated.result, cached: !!gated.cached, artifact: gated.artifact ?? null, reason: null };
}
