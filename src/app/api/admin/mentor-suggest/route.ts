import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { runAiGated } from '@/lib/aiGate';
import { aiRankMentors, type MatchCandidate } from '@/lib/aiMentorMatch';
import { withTenantScope } from '@/lib/orgContext';

const schema = z.object({ menteeId: z.string().min(1) });

// POST — mentor suggestions for a mentee (Faz 2, #533). Always computes the
// rule-based ranking (skill overlap + load); when the AI gate allows (quota +
// provider), the top candidates are re-ranked by AI with a one-sentence
// rationale each. With no provider or quota the rule-based result is returned
// unchanged (aiUsed: false) — the feature degrades, never breaks.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const mentee = await prisma.user.findUnique({
    where: { id: parsed.data.menteeId },
    select: { id: true, role: true, skills: true, targetPosition: true, interests: true },
  });
  if (!mentee || mentee.role !== 'MENTEE') return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
    reason: null as string | null,
  }));

  if (base.length === 0) return NextResponse.json({ suggestions: [], aiUsed: false });

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
    return NextResponse.json({ suggestions: base, aiUsed: false });
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

  return NextResponse.json({ suggestions: [...ranked, ...rest], aiUsed: true });
  });
}
