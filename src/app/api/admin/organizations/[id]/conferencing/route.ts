import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { recordOrgWrite } from '@/lib/orgAudit';
import { orgAdminRefusal } from '@/lib/orgAdminGate';
import { CONFERENCING_POLICIES, conferencingPolicyOf } from '@/lib/conferencingRule';

// /api/admin/organizations/[id]/conferencing (#2007) — the tenant's
// conferencing policy: which video room its meetings get. The rule the
// policy feeds is src/lib/conferencingRule.ts; the meeting paths read it
// through resolveMeetingLink (src/lib/meetingRoom.ts).
//
// WHO: that organization's ADMIN, or a super admin of its world (orgAdminGate)
// — the same door as the other per-organization setup routes.
//
// Its own route rather than a field on PATCH /api/admin/organizations: the
// policy is a setup choice an org admin makes about their own tenant, while
// that handler's fields (plan, branding, SSO) are plan- and super-admin-gated.

const bodySchema = z.object({ policy: z.enum(CONFERENCING_POLICIES) }).strict();

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const refusal = await orgAdminRefusal(session, id, 'GET /api/admin/organizations/[id]/conferencing');
  if (refusal) return refusal;
  const org = await prisma.organization.findUnique({ where: { id }, select: { conferencingPolicy: true } });
  return NextResponse.json({ policy: conferencingPolicyOf(org?.conferencingPolicy) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const refusal = await orgAdminRefusal(session, id, 'PATCH /api/admin/organizations/[id]/conferencing');
  if (refusal) return refusal;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });

  const before = await prisma.organization.findUnique({ where: { id }, select: { conferencingPolicy: true } });
  const updated = await prisma.organization.update({
    where: { id },
    data: { conferencingPolicy: parsed.data.policy },
    select: { conferencingPolicy: true },
  });
  if (before?.conferencingPolicy !== updated.conferencingPolicy) {
    await recordOrgWrite({
      orgId: id,
      action: 'organization.conferencing_policy',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      detail: `${before?.conferencingPolicy ?? 'BUILTIN'} -> ${updated.conferencingPolicy}`,
      request: req,
    });
  }
  return NextResponse.json({ policy: conferencingPolicyOf(updated.conferencingPolicy) });
}
