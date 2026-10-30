import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { setBench } from '@/lib/bench';
import { BENCH_BATCH_MAX } from '@/lib/participantState';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { parseEndDate } from '@/lib/relationSchedule';

// POST /api/admin/users/bench — the bulk bench (#1778): a list of people, or
// `{ cohortId }` for every mentee with a pairing in that programme. ADMIN
// (user.write), the caller's tenant only, at most BENCH_BATCH_MAX people in
// one call. One activity entry per person (`user.benched` / `user.unbenched`).

const schema = z
  .object({
    userIds: z.array(z.string().min(1).max(64)).min(1).max(BENCH_BATCH_MAX).optional(),
    cohortId: z.string().min(1).max(64).optional(),
    benched: z.boolean(),
    reason: z.string().max(TEXT_LIMITS.benchReason).optional(),
    reEngageAt: z.string().max(40).refine((v) => parseEndDate(v) !== null, 'invalid date').optional(),
  })
  .strict()
  .refine((b) => !!b.userIds !== !!b.cohortId, 'Send userIds or cohortId, not both');

export async function POST(request: Request) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const body = parsed.data;
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    let userIds = body.userIds ?? [];
    if (body.cohortId) {
      // Another tenant's programme reads as missing.
      const cohort = await prisma.cohort.findFirst({ where: withinTenant({ id: body.cohortId }, tenant), select: { id: true } });
      if (!cohort) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const rows = await prisma.mentorshipRelation.findMany({
        where: withinTenant({ cohortId: cohort.id }, tenant),
        select: { menteeId: true },
        distinct: ['menteeId'],
        take: BENCH_BATCH_MAX + 1,
      });
      if (rows.length > BENCH_BATCH_MAX) return NextResponse.json({ error: 'Too many people for one bench', code: 'too_many' }, { status: 400 });
      userIds = rows.map((r) => r.menteeId);
    }
    const result = await setBench({
      tenant,
      userIds,
      benched: body.benched,
      reason: body.reason ?? null,
      reEngageAt: body.reEngageAt ? parseEndDate(body.reEngageAt) : null,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      request,
    });
    return NextResponse.json({ ...result, requested: userIds.length });
  });
}
