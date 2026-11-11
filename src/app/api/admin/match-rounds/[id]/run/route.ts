import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { getLocale } from '@/i18n/server';
import { COHORT_PASS_MAX_MENTEES } from '@/lib/matching/assign';
import { runCohortPass } from '@/lib/matching/cohortPass';
import { cohortPassLoaders } from '@/lib/matching/cohortPassStore';

// POST — the cohort pass over one DRAFT round (#1794): every mentee in scope
// scored against every mentor in scope, one proposal per mentee written in one
// transaction, the round's stats and rule set stamped. A re-run of a DRAFT
// round replaces its proposals; any other status is 409. Over the size cap is
// 413 before anything is scored. Creates no relation — publishing (#1796) is
// the only path that pairs. Strategy and reasons: src/lib/matching/assign.ts.
const bodySchema = z
  .object({
    // Narrow the pass to these mentees (still only the tenant's waiting ones).
    menteeIds: z.array(z.string().min(1).max(64)).min(1).max(COHORT_PASS_MAX_MENTEES).optional(),
    // The round's minimum score: a best pair under it is `below_threshold`.
    minScore: z.number().min(0).max(100).optional(),
  })
  .strict();

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('relation.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;
    const { id } = await params;
    // An empty body runs the default scope; a body that is not JSON is a 400.
    const raw = await request.text();
    let body: unknown = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
      }
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const round = await prisma.matchRound.findFirst({
        where: withinTenant({ id }, tenant),
        select: { id: true, status: true, orgId: true, cohortId: true, createdAt: true },
      });
      if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (round.status !== 'DRAFT') {
        return NextResponse.json({ error: 'Only a draft round can be run', code: 'round_not_draft' }, { status: 409 });
      }

      const orgId = round.orgId ?? resolveOrgId(session) ?? null;
      const outcome = await runCohortPass(
        cohortPassLoaders({ tenant, orgId, locale: await getLocale(), menteeIds: parsed.data.menteeIds, programId: round.cohortId }),
        // The round's own instant, so a re-run on the same data is identical.
        { now: round.createdAt, minScore: parsed.data.minScore },
      );
      if (!outcome.ok) {
        return NextResponse.json(
          {
            error: `Too large for one pass: at most ${outcome.maxMentees} mentees and ${outcome.maxMentors} mentors`,
            code: 'round_too_large',
            mentees: outcome.mentees,
            mentors: outcome.mentors,
            maxMentees: outcome.maxMentees,
            maxMentors: outcome.maxMentors,
          },
          { status: 413 },
        );
      }

      const { result, ruleSet, durationMs } = outcome;
      const stats = { ...result.stats, durationMs, ranAt: new Date().toISOString(), ranById: session.user.id };
      const written = await prisma.$transaction(
        async (tx) => {
          // Guarded on DRAFT: a round moved to review (or discarded) while the
          // pass ran keeps what it had.
          const claimed = await tx.matchRound.updateMany({
            where: { id: round.id, status: 'DRAFT' },
            data: { ruleSetId: ruleSet.id, ruleSetVersion: ruleSet.version, stats },
          });
          if (claimed.count !== 1) return false;
          await tx.matchProposal.deleteMany({ where: { roundId: round.id } });
          await tx.matchProposal.createMany({
            data: result.proposals.map((p) => ({
              orgId: round.orgId,
              roundId: round.id,
              menteeId: p.menteeId,
              mentorId: p.mentorId,
              score: p.score,
              breakdown: p.breakdown as object[],
              blockedBy: p.blockedBy,
              rank: p.rank,
              alternatives: p.alternatives as object[],
              unmatchedReason: p.unmatchedReason,
              updatedById: session.user.id,
            })),
          });
          return true;
        },
        { timeout: 30_000 },
      );
      if (!written) return NextResponse.json({ error: 'Changed meanwhile', code: 'round_conflict' }, { status: 409 });
      return NextResponse.json({
        roundId: round.id,
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
        stats,
      });
    });
  });
}
