import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { runAiGated } from '@/lib/aiGate';
import { aiRankMentors, type MatchCandidate } from '@/lib/aiMentorMatch';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { MATCH_RULESET_VERSION } from '@/lib/matchFeedback';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';

const schema = z.object({ menteeId: z.string().min(1) });

// POST — mentor suggestions for a mentee (Faz 2, #533). Always computes the
// rule-based ranking (skill overlap + load); when the AI gate allows (quota +
// provider), the top candidates are re-ranked by AI with a one-sentence
// rationale each. With no provider or quota the rule-based result is returned
// unchanged (aiUsed: false) — the feature degrades, never breaks.
//
// Since #2040 every returned suggestion is also RECORDED (MatchFeedback, one
// SHOWN row per suggestion, all sharing one `batchId` that goes back to the
// client). Without that record the ranking can never be measured, let alone
// improved. The write is strictly best-effort: same discipline as the AI
// metering in src/lib/aiGate.ts — a bookkeeping failure must never cost the
// admin their suggestions.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', {
      ...AI_RATE_LIMITS.org_burst,
      subject: session.user.orgId,
    });
    if (orgLimited) return orgLimited;
  }
  const userLimited = enforceRateLimit(request, 'ai:mentor_match', {
    ...AI_RATE_LIMITS.mentor_match,
    subject: session.user.id,
  });
  if (userLimited) return userLimited;

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const mentee = await prisma.user.findUnique({
    where: { id: parsed.data.menteeId },
    select: { id: true, role: true, skills: true, targetPosition: true, interests: true },
  });
  if (!mentee || mentee.role !== 'MENTEE') return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
          ruleSetVersion: MATCH_RULESET_VERSION,
          aiUsed,
          action: 'SHOWN' as const,
        })),
        skipDuplicates: true,
      })
      .catch(() => {}); // bookkeeping must never break a good suggestion
  };

  const mentors = await prisma.user.findMany({
    where: { role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
    select: {
      id: true,
      fullName: true,
      skills: true,
      interests: true,
      mentorCapacity: true,
      _count: { select: { mentorRelations: { where: { status: 'ACTIVE' } } } },
    },
  });

  // Rule-based ranking: skill overlap first, then the lighter load.
  const menteeSkills = new Set(
    (Array.isArray(mentee.skills) ? (mentee.skills as string[]) : []).map((s) => s.toLowerCase())
  );
  const scored = mentors
    .map((m) => {
      const skills = Array.isArray(m.skills) ? (m.skills as string[]) : [];
      const overlap = skills.filter((s) => menteeSkills.has(s.toLowerCase()));
      const overCapacity = m.mentorCapacity != null && m._count.mentorRelations >= m.mentorCapacity;
      return { mentor: m, overlap, overCapacity };
    })
    .filter((x) => !x.overCapacity)
    .sort((a, b) => b.overlap.length - a.overlap.length || a.mentor._count.mentorRelations - b.mentor._count.mentorRelations)
    .slice(0, 5);

  const base = scored.map((x) => ({
    mentorId: x.mentor.id,
    fullName: x.mentor.fullName,
    activeMentees: x.mentor._count.mentorRelations,
    capacity: x.mentor.mentorCapacity,
    sharedSkills: x.overlap,
    // The number the rule set actually ranked by, stored with the row so a
    // future ranking can be compared against this one.
    score: x.overlap.length,
    reason: null as string | null,
  }));

  if (base.length === 0) return NextResponse.json({ batchId, suggestions: [], aiUsed: false });

  // AI deepening — anonymous labels only; personal identifiers never leave.
  const labels = 'ABCDE';
  const candidates: MatchCandidate[] = scored.map((x, i) => ({
    label: labels[i],
    skills: Array.isArray(x.mentor.skills) ? (x.mentor.skills as string[]) : [],
    interests: x.mentor.interests,
    activeMentees: x.mentor._count.mentorRelations,
    capacity: x.mentor.mentorCapacity,
  }));

  const gated = await runAiGated({
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
  });

  if (!gated.ok) {
    // Graceful fallback: rule-based order, no rationale text.
    await recordShown(base, false);
    return NextResponse.json({ batchId, suggestions: base, aiUsed: false });
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
  return NextResponse.json({ batchId, suggestions, aiUsed: true });
  });
}
