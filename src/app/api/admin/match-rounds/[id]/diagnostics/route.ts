import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { loadMentorPool } from '@/lib/matching/pool';
import { startingHeadroom } from '@/lib/matching/assign';
import { SEAT_HOLDING_STATES } from '@/lib/matching/round';
import { roundDiagnostics } from '@/lib/matching/roundDiagnostics';

// GET — the round board's unmatched panel (#1796): unmatched mentees by
// reason, the hard rule that blocked the most pairs in the pass, and the
// skills more unmatched mentees need than mentors with room hold. The rule is
// pure (src/lib/matching/roundDiagnostics.ts); headroom here is the pool's
// live headroom minus this round's own seat-holding proposals.
const textList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('program.read', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;
    const { id } = await params;

    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const round = await prisma.matchRound.findFirst({ where: withinTenant({ id }, tenant), select: { id: true, stats: true } });
      if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const proposals = await prisma.matchProposal.findMany({
        where: { roundId: round.id },
        select: { menteeId: true, mentorId: true, state: true, unmatchedReason: true },
      });
      const unmatchedIds = proposals.filter((p) => p.mentorId === null).map((p) => p.menteeId);
      const [mentees, pool] = await Promise.all([
        unmatchedIds.length
          ? prisma.user.findMany({ where: withinTenant({ id: { in: unmatchedIds } }, tenant), select: { id: true, skills: true } })
          : Promise.resolve([]),
        loadMentorPool(tenant),
      ]);
      const seats = new Map<string, number>();
      for (const p of proposals) {
        if (p.mentorId && (SEAT_HOLDING_STATES as readonly string[]).includes(p.state)) seats.set(p.mentorId, (seats.get(p.mentorId) ?? 0) + 1);
      }
      const stats = round.stats && typeof round.stats === 'object' && !Array.isArray(round.stats) ? (round.stats as Record<string, unknown>) : {};
      const blocked = stats.blockedPairsByRule;

      const diagnostics = roundDiagnostics({
        proposals,
        menteeSkills: new Map(mentees.map((m) => [m.id, textList(m.skills)])),
        mentors: pool
          .filter((m) => m.acceptingMentees !== false)
          .map((m) => {
            const start = startingHeadroom(m);
            return { id: m.id, skills: textList(m.skills), headroomLeft: start === null ? null : start - (seats.get(m.id) ?? 0) };
          }),
        blockedPairsByRule: blocked && typeof blocked === 'object' && !Array.isArray(blocked) ? (blocked as Record<string, number>) : null,
      });
      return NextResponse.json({ diagnostics });
    });
  });
}
