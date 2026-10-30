import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { AI_PACK_FEATURE, runAiGated } from '@/lib/aiGate';
import { aiRankMentors, type MatchCandidate } from '@/lib/aiMentorMatch';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { matchRuleSetTag } from '@/lib/matchFeedback';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hashInput } from '@/lib/ai/artifacts';
import { skillOverlap } from '@/lib/skillTaxonomyRule';
import { loadMentees, loadMentorPool } from '@/lib/matching/pool';
import { isEligible } from '@/lib/eligibility';
import { resolveRuleSet } from '@/lib/matching/ruleSet';
import { suggestMentors } from '@/lib/matching/suggest';
import { skillGraphFor, skillIdsByUser } from '@/lib/matching/skillContext';
import { getLocale } from '@/i18n/server';
import { requirePermission } from '@/lib/authz';

const schema = z.object({
  menteeId: z.string().min(1),
  // A pending mentorship request of this mentee (#1787): its preferences feed
  // the score, and its preferred mentor comes back so the queue can pin it.
  requestId: z.string().min(1).max(64).optional(),
  // The explicit Regenerate: skip the stored rationale for the same input (#2044).
  regenerate: z.boolean().optional(),
});

type Ranking = { label: string; reason: string }[];

// A stored ranking is only trusted in the shape the provider returned it.
function decodeRanking(content: string): Ranking {
  const v: unknown = JSON.parse(content);
  if (!Array.isArray(v) || !v.every((r) => r && typeof r.label === 'string' && typeof r.reason === 'string')) {
    throw new Error('stale ranking');
  }
  return v as Ranking;
}

// POST — mentor suggestions for a mentee (Faz 2, #533). Always computes the
// rule-based ranking (skill overlap + load); when the AI gate allows (quota +
// provider), the top candidates are re-ranked by AI with a one-sentence
// rationale each. With no provider or quota the rule-based result is returned
// unchanged (aiUsed: false) — the feature degrades, never breaks.
//
// The AI re-rank is an operator task behind the AI pack (#1738); the ranking
// is not AI. So an org without the pack is NOT refused — it gets the same
// rule-based list, and `locked: 'AI_PACKAGE'` names the add-on the rationale
// would need. The other denials stay silent, exactly as before.
//
// Since #2040 every returned suggestion is also RECORDED (MatchFeedback, one
// SHOWN row per suggestion, all sharing one `batchId` that goes back to the
// client). Without that record the ranking can never be measured, let alone
// improved. The write is strictly best-effort: same discipline as the AI
// metering in src/lib/aiGate.ts — a bookkeeping failure must never cost the
// admin their suggestions.
export async function POST(request: Request) {
  const gate = await requirePermission('program.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  const userLimited = enforceRateLimit(request, 'ai:mentor_match', {
    ...AI_RATE_LIMITS.mentor_match,
    subject: session.user.id,
  });
  if (userLimited) return userLimited;

  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', {
      ...AI_RATE_LIMITS.org_burst,
      subject: session.user.orgId,
    });
    if (orgLimited) return orgLimited;
  }

  // Internship-only surface: closed for an org without mentorship (#2647).
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  // The mentee and the mentor pool are both the caller's tenant's (#2542
  // follow-up): with MT_ENFORCE_ISOLATION off this suggested every tenant's
  // mentors, names and skills included, and scored another tenant's mentee.
  const tenant = await tenantWhere(session);
  const mentee = await prisma.user.findFirst({
    where: withinTenant({ id: parsed.data.menteeId }, tenant),
    select: {
      id: true,
      role: true,
      skills: true,
      targetPosition: true,
      interests: true,
      skillRows: { select: { skillId: true } },
    },
  });
  if (!mentee || mentee.role !== 'MENTEE') return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Programme eligibility (#1945): no suggestion list for a mentee who could
  // not be enrolled — the same answer POST /api/mentorship would give.
  const eligibility = await isEligible({ id: mentee.id, orgId: resolveOrgId(session) });
  if (!eligibility.ok) {
    return NextResponse.json(
      { error: 'This mentee is not eligible for the programme', code: 'not_eligible', reason: eligibility.reason, ruleId: eligibility.ruleId ?? null },
      { status: 403 },
    );
  }

  // One id for this whole call. The client echoes it back with the outcome, so
  // an accept/dismiss lands on exactly the suggestions that were on screen.
  const batchId = randomUUID();
  const orgId = resolveOrgId(session);

  // Record the list exactly as it is about to be returned — after the AI
  // re-rank, not before, because rank 1 must mean "the one we put on top".
  const recordShown = async (
    list: { mentorId: string; score: number }[],
    aiUsed: boolean
  ): Promise<void> => {
    if (list.length === 0) return;
    await prisma.matchFeedback
      .createMany({
        data: list.map((s, i) => ({
          orgId,
          menteeId: mentee.id,
          mentorId: s.mentorId,
          batchId,
          rank: i + 1,
          score: s.score,
          ruleSetVersion: matchRuleSetTag(ruleSet),
          aiUsed,
          action: 'SHOWN' as const,
        })),
        skipDuplicates: true,
      })
      .catch(() => {}); // bookkeeping must never break a good suggestion
  };

  // The pool and the mentee in the scorer's shape (#1787), plus each side's
  // canonical skill ids — the `skills` dimension reads them with the org's
  // skill graph, i.e. the adjacency-weighted overlap of #1821.
  const [menteeRow] = await loadMentees(tenant, [mentee.id]);
  if (!menteeRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const pool = await loadMentorPool(tenant);
  const idsOf = await skillIdsByUser(pool.map((m) => m.id));
  const mentors = pool.map((m) => ({ ...m, skillIds: idsOf.get(m.id) ?? [] }));

  // A mentorship request's preferences feed the score (#1787): the field and
  // languages the mentee asked for read in the `field` / `language`
  // dimensions. The request must be this mentee's — anything else is a 404.
  let mentReq: { preferredField: string | null; preferredLanguages: unknown; preferredMentorId: string | null } | null = null;
  if (parsed.data.requestId) {
    mentReq = await prisma.mentorshipRequest.findFirst({
      where: { id: parsed.data.requestId, menteeId: mentee.id },
      select: { preferredField: true, preferredLanguages: true, preferredMentorId: true },
    });
    if (!mentReq) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const menteeSkillIds = mentee.skillRows.map((r) => r.skillId);
  // The same graph the decision record scores with (#1789), loaded once.
  const skillGraph = await skillGraphFor(orgId, menteeSkillIds, await getLocale());
  const edges = skillGraph?.edges ?? [];
  const label = skillGraph?.label ?? ((id: string) => id);

  const ruleSet = await resolveRuleSet(orgId);
  const scoreMentee = {
    ...menteeRow,
    skillIds: menteeSkillIds,
    preferredField: mentReq?.preferredField ?? null,
    preferredLanguages: mentReq?.preferredLanguages ?? [],
  };
  const { suggestions: rankedPool, blocked, blockedTotal } = suggestMentors(scoreMentee, mentors, ruleSet, {
    now: new Date(),
    // Canonical skills with adjacency when the mentee has any; a mentee not
    // backfilled yet falls back to the free-text comparison, so nobody's
    // suggestions go blank mid-migration.
    ...(skillGraph ? { skillGraph } : {}),
  });

  const ruleSetInfo = { ruleSetId: ruleSet.id, ruleSetVersion: ruleSet.version, ruleSetName: ruleSet.name };
  const base = rankedPool.map(({ mentor, match }) => {
    // Kept for the screens that list skills (#1821): exact ones, and the
    // neighbours that stood in for a mentee skill, each named.
    const overlap = menteeSkillIds.length > 0 ? skillOverlap(menteeSkillIds, mentor.skillIds, edges) : null;
    return {
      mentorId: mentor.id,
      fullName: mentor.fullName,
      activeMentees: mentor.activeMenteeCount,
      capacity: mentor.mentorCapacity ?? null,
      sharedSkills: overlap ? overlap.direct.map(label) : (match.breakdown.find((e) => e.dimension === 'skills')?.detail ?? []),
      adjacentSkills: overlap ? overlap.adjacent.map((a) => ({ skill: label(a.skillId), via: label(a.via), weight: a.weight })) : [],
      // The engine's 0-100 score and the per-rule rows behind it — the
      // explanation travels with the number, always (#1779).
      score: Math.round(match.score * 10) / 10,
      match,
      reason: null as string | null,
    };
  });
  const blockedOut = {
    blocked: blocked.map(({ mentor, match }) => ({ mentorId: mentor.id, fullName: mentor.fullName, match })),
    blockedTotal,
  };
  const scored = rankedPool;

  if (base.length === 0) return NextResponse.json({ batchId, suggestions: [], aiUsed: false, ...ruleSetInfo, ...blockedOut, preferredMentorId: mentReq?.preferredMentorId ?? null });

  // AI deepening — anonymous labels only; personal identifiers never leave.
  const anonLabels = 'ABCDE';
  const candidates: MatchCandidate[] = scored.map((x, i) => ({
    label: anonLabels[i],
    skills: Array.isArray(x.mentor.skills) ? (x.mentor.skills as string[]) : [],
    interests: x.mentor.interests,
    activeMentees: x.mentor.activeMenteeCount,
    capacity: x.mentor.mentorCapacity ?? null,
  }));

  const gated = await runAiGated({
    orgId: await settingsOrgOf(session),
    scope: 'mentor_match',
    userId: session.user.id,
    call: () =>
      aiRankMentors(
        {
          skills: Array.isArray(mentee.skills) ? (mentee.skills as string[]) : [],
          targetPosition: mentee.targetPosition,
          interests: mentee.interests,
        },
        candidates
      ),
    // Kept (#2044): the same mentee profile against the same candidates — the
    // same mentors, in the same order, with the same skills, interests and
    // load — inside the TTL reuses the stored rationale. The mentor ids are
    // hashed (they never reach the provider) because the anonymous labels are
    // positions: a stored "A" is only the same person while the list is.
    persist: {
      subjectUserId: mentee.id,
      createdById: session.user.id,
      inputHash: hashInput({
        mentee: { skills: mentee.skills, targetPosition: mentee.targetPosition ?? '', interests: mentee.interests ?? '' },
        candidates: candidates.map((c, i) => ({ ...c, mentorId: base[i].mentorId })),
      }),
      force: parsed.data.regenerate,
      serialize: (r) => JSON.stringify(r),
      deserialize: decodeRanking,
    },
  });

  if (!gated.ok) {
    // Graceful fallback: rule-based order, no rationale text.
    await recordShown(base, false);
    const fallback: { batchId: string; suggestions: typeof base; aiUsed: false; locked?: typeof AI_PACK_FEATURE } & typeof ruleSetInfo & typeof blockedOut & { preferredMentorId: string | null } = {
      batchId, suggestions: base, aiUsed: false, ...ruleSetInfo, ...blockedOut, preferredMentorId: mentReq?.preferredMentorId ?? null,
    };
    if (gated.reason === 'not_entitled') fallback.locked = AI_PACK_FEATURE;
    return NextResponse.json(fallback);
  }

  // Map the AI ranking (labels) back to mentors; anything unranked keeps its
  // rule-based position after the ranked ones.
  const byLabel = new Map(candidates.map((c, i) => [c.label, base[i]]));
  const ranked = gated.result
    .map((r) => {
      const hit = byLabel.get(r.label);
      return hit ? { ...hit, reason: r.reason } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const rankedIds = new Set(ranked.map((r) => r.mentorId));
  const rest = base.filter((b) => !rankedIds.has(b.mentorId));

  const suggestions = [...ranked, ...rest];
  await recordShown(suggestions, true);
  // The AI re-orders and explains; it never rewrites a score (#1787).
  return NextResponse.json({
    batchId, suggestions, aiUsed: true, cached: !!gated.cached, artifact: gated.artifact ?? null,
    ...ruleSetInfo, ...blockedOut, preferredMentorId: mentReq?.preferredMentorId ?? null,
  });
  });
}
