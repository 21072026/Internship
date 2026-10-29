import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { matchRuleSetDraftSchema } from '@/lib/matching/ruleSetSchema';
import { loadMentees, loadMentorPool } from '@/lib/matching/pool';
import { simulateRuleSet } from '@/lib/matching/simulate';
import { requirePermission } from '@/lib/authz';

// POST — dry-run a rule set (#1783). Takes the DRAFT body (no save needed)
// and one mentee, a cohort, or the unmatched mentees, and answers who could
// match whom under those rules. READ-ONLY by definition: nothing here writes a
// relation, a proposal, a decision or a feedback row.

const MAX_MENTEES = 200;

const schema = z
  .object({
    ruleSet: matchRuleSetDraftSchema,
    menteeId: z.string().min(1).optional(),
    cohortId: z.string().min(1).optional(),
    // Every MENTEE without an ACTIVE relation — "the next intake".
    unmatched: z.boolean().optional(),
    topN: z.number().int().min(1).max(10).optional(),
  })
  .refine((b) => [b.menteeId, b.cohortId, b.unmatched || undefined].filter(Boolean).length === 1, {
    message: 'Pick exactly one of menteeId, cohortId, unmatched',
  });

export async function POST(request: Request) {
  const gate = await requirePermission('program.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const refusal = await requireCapability(session.user.orgId, 'mentorship');
  if (refusal) return refusal;

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
    const body = parsed.data;
    const tenant = await tenantWhere(session);

    let menteeIds: string[];
    if (body.menteeId) {
      menteeIds = [body.menteeId];
    } else if (body.cohortId) {
      const cohort = await prisma.cohort.findFirst({ where: withinTenant({ id: body.cohortId }, tenant), select: { id: true } });
      if (!cohort) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const rels = await prisma.mentorshipRelation.findMany({
        where: { cohortId: cohort.id },
        select: { menteeId: true },
        distinct: ['menteeId'],
        take: MAX_MENTEES,
      });
      menteeIds = rels.map((r) => r.menteeId);
    } else {
      const rows = await prisma.user.findMany({
        where: withinTenant({ role: 'MENTEE' as const, isActive: true, menteeRelations: { none: { status: 'ACTIVE' as const } } }, tenant),
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_MENTEES,
      });
      menteeIds = rows.map((r) => r.id);
    }

    const [mentees, mentors] = await Promise.all([loadMentees(tenant, menteeIds), loadMentorPool(tenant)]);
    if (body.menteeId && mentees.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { results, summary } = simulateRuleSet(
      mentees,
      mentors,
      { id: null, name: body.ruleSet.name, version: 0, rules: body.ruleSet.rules },
      { topN: body.topN ?? 5 }
    );
    return NextResponse.json({ results, summary, truncated: menteeIds.length >= MAX_MENTEES });
  });
}
