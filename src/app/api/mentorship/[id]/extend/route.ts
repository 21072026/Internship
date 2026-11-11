import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { extendRelation } from '@/lib/relationExtend';
import { MAX_EXTEND_MONTHS } from '@/lib/relationEnding';

// Extend a pairing's agreed end date (#1786): ADMIN (relation.write) or the
// relation's own mentor, checked here on the server. A mentee — or any other
// mentor — gets 403; another tenant's pairing reads as 404. Without `months`
// or `until` it extends by the pairing's original length. The write itself is
// src/lib/relationExtend.ts, shared with the one-click mail link.

const schema = z.object({
  months: z.number().int().min(1).max(MAX_EXTEND_MONTHS).optional(),
  until: z.string().max(40).optional(),
  note: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const actor = await actorFromSession(session);
  const isAdmin = !!actor && (await can(actor, 'relation.write', undefined, session));

  return withTenantScope(session, async () => {
    const relation = await prisma.mentorshipRelation.findFirst({
      where: withinTenant({ id }, await tenantWhere(session)),
      select: { id: true, mentorId: true },
    });
    if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!isAdmin && relation.mentorId !== session.user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });
    if (parsed.data.months !== undefined && parsed.data.until !== undefined) {
      return NextResponse.json({ error: 'Send months or until, not both', code: 'invalid' }, { status: 400 });
    }

    const result = await extendRelation({ relationId: relation.id, actorId: session.user.id, ...parsed.data });
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    return NextResponse.json(result);
  });
}
