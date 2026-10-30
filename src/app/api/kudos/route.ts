import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { notifyIfAllowed } from '@/lib/notify';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { canReadKudos, isKudoPreset, kudoSendRefusal } from '@/lib/kudosRule';

// Kudos (#1868) — a written, attributed thank-you inside a pairing. Who may
// send to whom and who reads is src/lib/kudosRule.ts; this route only resolves
// the relation inside the caller's tenant and the caller's admin reach.

const kudoSelect = {
  id: true,
  relationId: true,
  reason: true,
  presetKey: true,
  createdAt: true,
  senderId: true,
  recipientId: true,
  sender: { select: { id: true, fullName: true } },
  recipient: { select: { id: true, fullName: true } },
} as const;

async function relationInTenant(relationId: string, callerOrgId: string | null) {
  const rel = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    select: { id: true, mentorId: true, menteeId: true, orgId: true },
  });
  // Another tenant's relation answers like a missing one (#2542).
  if (!rel || !(await inCallerTenant(rel.orgId, callerOrgId))) return null;
  return rel;
}

// GET ?relationId= — the pairing's kudos, both directions (pair + admins).
// GET (no relationId) — the kudos the caller has received, for their account.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const actor = await actorFromSession(session);
  const isAdmin = !!actor && (await can(actor, 'program.read', undefined, session));

  return await withTenantScope(session, async () => {
    const relationId = new URL(request.url).searchParams.get('relationId');
    if (!relationId) {
      const kudos = await prisma.kudo.findMany({
        where: { recipientId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: kudoSelect,
      });
      return NextResponse.json({ kudos });
    }
    const rel = await relationInTenant(relationId, resolveOrgId(session));
    if (!rel) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    if (!canReadKudos(rel, session.user.id, isAdmin)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const kudos = await prisma.kudo.findMany({
      where: { relationId: rel.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: kudoSelect,
    });
    return NextResponse.json({ kudos });
  });
}

const sendSchema = z.object({
  relationId: z.string().min(1),
  recipientId: z.string().min(1),
  reason: z.string().trim().min(1).max(TEXT_LIMITS.kudoReason),
  presetKey: z.string().max(40).nullable().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const actor = await actorFromSession(session);
  const isAdmin = !!actor && (await can(actor, 'relation.write', undefined, session));

  return await withTenantScope(session, async () => {
    const parsed = sendSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { relationId, recipientId, reason, presetKey } = parsed.data;
    if (presetKey != null && !isKudoPreset(presetKey)) {
      return NextResponse.json({ error: 'Unknown preset', code: 'invalid_preset' }, { status: 400 });
    }

    const rel = await relationInTenant(relationId, resolveOrgId(session));
    if (!rel) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    const refusal = kudoSendRefusal(rel, session.user.id, recipientId, isAdmin);
    if (refusal) return NextResponse.json({ error: 'Forbidden', code: refusal }, { status: 403 });

    const kudo = await prisma.kudo.create({
      data: { relationId: rel.id, senderId: session.user.id, recipientId, reason, presetKey: presetKey ?? null },
      select: kudoSelect,
    });

    // The recipient's own preference for mentorship news decides; the link
    // fits their side of the pair.
    const link = recipientId === rel.menteeId ? '/portal' : `/mentor/mentees/${rel.id}`;
    await notifyIfAllowed(recipientId, 'mentorship', 'kudo.received', { from: kudo.sender.fullName }, link);

    return NextResponse.json({ kudo }, { status: 201 });
  });
}
