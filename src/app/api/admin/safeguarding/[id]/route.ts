import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { logActivity } from '@/lib/activity';

// PATCH /api/admin/safeguarding/[id] — record the review of one flag (#2056):
// NO_ACTION, REVIEWED or ESCALATED, with who and when. `reopen: true` clears
// it again (a misclick must be undoable). ADMIN only, and only a flag of the
// caller's own org — another tenant's id answers 404, never 403, so the route
// does not confirm that the id exists.
const schema = z.union([
  z.object({ outcome: z.enum(['NO_ACTION', 'REVIEWED', 'ESCALATED']) }),
  z.object({ reopen: z.literal(true) }),
]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('safeguarding.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { id } = await params;
  const orgId = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    const flag = await prisma.safeguardingFlag.findFirst({ where: { id, orgId }, select: { id: true } });
    if (!flag) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const data =
      'outcome' in parsed.data
        ? { outcome: parsed.data.outcome, reviewedAt: new Date(), reviewedById: session.user.id }
        : { outcome: null, reviewedAt: null, reviewedById: null };
    const updated = await prisma.safeguardingFlag.update({
      where: { id },
      data,
      select: { id: true, outcome: true, reviewedAt: true },
    });

    // The review is itself part of the duty-of-care record: who looked, when,
    // and what they decided. Never the message text.
    await logActivity({
      action: 'outcome' in parsed.data ? 'safeguarding.reviewed' : 'safeguarding.reopened',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'safeguardingFlag',
      targetId: id,
      detail: 'outcome' in parsed.data ? parsed.data.outcome : null,
      request,
      orgId,
    });
    return NextResponse.json({ flag: updated });
  });
}
