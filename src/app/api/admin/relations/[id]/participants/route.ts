import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { AlreadyMentoredError, alreadyMentoredBody } from '@/lib/activeMentorship';
import { announceNewRelation } from '@/lib/relationCreate';
import { addSeat, leaveSeat, menteesOf, participantsOf } from '@/lib/relationParticipants';
import { GROUP_MAX_MENTEES, isParticipantRole } from '@/lib/relationShapes';
import { assertNotMentored, assertSeatableMentee, assertSeatableMentor, GroupRefusal } from '@/lib/groupRelations';
import { notify } from '@/lib/notify';
import { getLocale } from '@/i18n/server';

// The seats of one relation (#1804): who is and was in it (GET), seat someone
// in a GROUP (POST), or let a seat go (DELETE — `leftAt`, never a delete; the
// history is the record). The scalar pair is not a seat here: it is changed by
// the mentor transfer (#2289), never by unseating, so a relation always keeps
// a mentor and a mentee. Admin-only, the admin's own tenant; another tenant's
// relation is a 404.

type Ctx = { params: Promise<{ id: string }> };

const RELATION_SELECT = { id: true, mentorId: true, menteeId: true, status: true, relationType: true, orgId: true } as const;

async function gateFor(request: Request, permission: 'program.read' | 'relation.write') {
  const gate = await requirePermission(permission, { request });
  if ('error' in gate) return { error: gate.error } as const;
  const denied = await requireCapability(gate.session.user.orgId, 'mentorship');
  if (denied) return { error: denied } as const;
  return { session: gate.session } as const;
}

export async function GET(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const g = await gateFor(request, 'program.read');
    if ('error' in g) return g.error;
    return withTenantScope(g.session, async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: withinTenant({ id }, await tenantWhere(g.session)), select: RELATION_SELECT });
      if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ relationType: relation.relationType, status: relation.status, participants: await participantsOf(relation) });
    });
  });
}

const addSchema = z.object({ userId: z.string().min(1), role: z.string().max(16) });

export async function POST(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const g = await gateFor(request, 'relation.write');
    if ('error' in g) return g.error;
    const { session } = g;
    const parsed = addSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !isParticipantRole(parsed.data.role)) {
      return NextResponse.json({ error: 'Validation failed', code: 'invalid_role' }, { status: 400 });
    }
    const { userId, role } = parsed.data;

    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const relation = await prisma.mentorshipRelation.findFirst({ where: withinTenant({ id }, tenant), select: RELATION_SELECT });
      if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      // Only a group takes more seats: a one-to-one stays two people.
      if (relation.relationType !== 'GROUP') return NextResponse.json({ error: 'Only a group takes more members', code: 'not_group' }, { status: 409 });
      if (relation.status !== 'ACTIVE') return NextResponse.json({ error: 'The group has ended', code: 'not_active' }, { status: 409 });
      if (userId === relation.mentorId || userId === relation.menteeId) {
        return NextResponse.json({ error: 'Already in the group', code: 'already_member' }, { status: 409 });
      }
      const user = await prisma.user.findFirst({ where: withinTenant({ id: userId }, tenant) });

      try {
        if (role === 'MENTEE') await assertSeatableMentee(user ?? undefined, userId);
        else assertSeatableMentor(user ?? undefined, userId);
      } catch (e) {
        if (e instanceof GroupRefusal) return NextResponse.json({ error: 'Refused', code: e.code, ...e.detail }, { status: e.status });
        throw e;
      }

      try {
        await prisma.$transaction(async (tx) => {
          const open = await tx.relationParticipant.findFirst({ where: { relationId: relation.id, userId, leftAt: null, isPrimaryPair: false }, select: { id: true } });
          if (open) throw new GroupRefusal('already_member', 409);
          if (role === 'MENTEE') {
            if ((await menteesOf(relation, tx)).length >= GROUP_MAX_MENTEES) throw new GroupRefusal('too_many', 409);
            await assertNotMentored(tx, userId);
          }
          await addSeat(tx, relation.id, userId, role);
        });
      } catch (e) {
        if (e instanceof GroupRefusal) return NextResponse.json({ error: 'Refused', code: e.code, ...e.detail }, { status: e.status });
        if (e instanceof AlreadyMentoredError) {
          return NextResponse.json({ ...(await alreadyMentoredBody(prisma, e.existingRelationId)), menteeId: e.menteeId }, { status: 409 });
        }
        throw e;
      }

      // A seated mentee is told who mentors them, as any paired mentee is; a
      // co-mentor or facilitator is told which mentee's group they joined.
      if (role === 'MENTEE') {
        const mentor = await prisma.user.findUnique({ where: { id: relation.mentorId } });
        if (mentor && user) {
          await announceNewRelation({
            relation,
            mentor,
            mentee: user,
            companyId: null,
            actor: { id: session.user.id, orgId: session.user.orgId ?? null },
            decision: { source: 'ADMIN_DIRECT', note: null, locale: await getLocale() },
            seat: true,
          });
        }
      } else {
        const pairMentee = await prisma.user.findUnique({ where: { id: relation.menteeId }, select: { fullName: true } });
        await notify(userId, 'mentorship_request.menteeAssigned', { menteeName: pairMentee?.fullName ?? '' }, `/mentor/mentees/${relation.id}`);
      }

      return NextResponse.json({ participants: await participantsOf(relation) }, { status: 201 });
    });
  });
}

export async function DELETE(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const g = await gateFor(request, 'relation.write');
    if ('error' in g) return g.error;
    const userId = new URL(request.url).searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });

    return withTenantScope(g.session, async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: withinTenant({ id }, await tenantWhere(g.session)), select: RELATION_SELECT });
      if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (userId === relation.mentorId || userId === relation.menteeId) {
        return NextResponse.json({ error: 'The primary pair is changed by a transfer, not by leaving', code: 'primary_pair' }, { status: 409 });
      }
      if (!(await leaveSeat(prisma, relation.id, userId))) return NextResponse.json({ error: 'No open seat', code: 'not_member' }, { status: 404 });
      return NextResponse.json({ participants: await participantsOf(relation) });
    });
  });
}
