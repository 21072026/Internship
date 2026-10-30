import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { setBench } from '@/lib/bench';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { parseEndDate } from '@/lib/relationSchedule';

// PATCH /api/admin/users/<id>/bench — put one person on the bench or bring
// them back (#1778). ADMIN (user.write) of their tenant; another tenant's id
// changes nothing and reads as 404. A bench is not a deactivation: it never
// touches isActive, sessionsValidFrom or consentAt (src/lib/bench.ts).

const schema = z
  .object({
    benched: z.boolean(),
    reason: z.string().max(TEXT_LIMITS.benchReason).optional(),
    // When to write to them again — only with their own pool consent.
    reEngageAt: z.string().max(40).refine((v) => parseEndDate(v) !== null, 'invalid date').optional(),
  })
  .strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const user = await prisma.user.findFirst({ where: withinTenant({ id }, tenant), select: { id: true, participantState: true } });
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const result = await setBench({
      tenant,
      userIds: [id],
      benched: parsed.data.benched,
      reason: parsed.data.reason ?? null,
      reEngageAt: parsed.data.reEngageAt ? parseEndDate(parsed.data.reEngageAt) : null,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      request,
    });
    return NextResponse.json({ ...result, participantState: parsed.data.benched ? 'BENCHED' : 'ACTIVE' });
  });
}
