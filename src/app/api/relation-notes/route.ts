import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';

const bodySchema = z.object({
  relationId: z.string().min(1),
  body: z.string().min(1).max(5000),
});

// A note is visible/writable only to the mentor of that relation, or an admin
// of the relation's own tenant. RelationNote has no orgId — its tenant is its
// relation's — so the relation is loaded for an ADMIN too (it used to be
// skipped, which let any tenant's admin read and write these notes, #2542).
// Who may ask at all (an admin, or a MENTOR) is the route guard's answer.
async function canAccessRelation(
  userId: string,
  admin: boolean,
  relationId: string,
  callerOrgId: string | null
) {
  const rel = await prisma.mentorshipRelation.findFirst({
    where: { id: relationId, ...(admin ? {} : { mentorId: userId }) },
    select: { orgId: true },
  });
  return !!rel && await inCallerTenant(rel.orgId, callerOrgId);
}

// GET ?relationId=... — mentor-private notes on a mentorship relation
// (EPIC: mentor private notes). Never exposed to the mentee.
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'program.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  return await withTenantScope(session, async () => {
    const relationId = new URL(request.url).searchParams.get('relationId');
    if (!relationId) return NextResponse.json({ error: 'relationId is required' }, { status: 400 });
    if (!(await canAccessRelation(session.user.id, admin, relationId, resolveOrgId(session)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const notes = await prisma.relationNote.findMany({
      where: { relationId },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { fullName: true } } },
    });
    return NextResponse.json({ notes });
  });
}

// POST — add a note.
export async function POST(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'relation.write', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  return await withTenantScope(session, async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { relationId, body } = parsed.data;

    if (!(await canAccessRelation(session.user.id, admin, relationId, resolveOrgId(session)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const note = await prisma.relationNote.create({
      data: { relationId, authorId: session.user.id, body },
      include: { author: { select: { fullName: true } } },
    });
    return NextResponse.json({ note }, { status: 201 });
  });
}
