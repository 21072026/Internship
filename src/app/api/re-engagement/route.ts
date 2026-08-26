import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { hasPoolConsent, joinPool, leavePool } from '@/lib/reEngagement';

// The pool, from the admin/mentor side (#834).

// GET — who is in the pool, soonest first. Its own list rather than a filter on
// the candidate table: the question "who are we writing to next" is asked on
// its own, and the aging report deliberately no longer shows these people.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    const people = await prisma.user.findMany({
      where: {
        role: 'MENTEE',
        reEngageAt: { not: null },
        ...(orgId ? { orgId } : {}),
        ...(session.user.role === 'MENTOR'
          ? { menteeRelations: { some: { mentorId: session.user.id } } }
          : {}),
      },
      orderBy: { reEngageAt: 'asc' },
      select: { id: true, fullName: true, email: true, reEngageAt: true, reEngageNote: true, reEngageNotifiedAt: true },
    });
    return NextResponse.json({ people });
  });
}

const schema = z.object({
  userId: z.string().min(1),
  action: z.enum(['join', 'leave']),
  at: z.string().optional().nullable(),
  note: z.string().max(500).optional().nullable(),
});

// POST — put someone in the pool, or take them out.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const orgId = resolveOrgId(session);
    const person = await prisma.user.findFirst({
      where: { id: parsed.data.userId, role: 'MENTEE', ...(orgId ? { orgId } : {}) },
      select: { id: true, fullName: true, consentAt: true },
    });
    if (!person) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (parsed.data.action === 'leave') {
      // An admin clearing a date is not the person withdrawing permission, so
      // the consent stays; only the one-click e-mail link revokes.
      await leavePool(person.id);
      await logActivity({
        action: 're_engagement.removed', actorId: session.user.id, actorEmail: session.user.email ?? null,
        targetType: 'user', targetId: person.id, detail: person.fullName, request,
      });
      return NextResponse.json({ ok: true, pooled: false });
    }

    if (!(await hasPoolConsent(person.id))) {
      // Not an error to hide: the caller's next move is to invite the person,
      // and they need to know that is what is missing.
      return NextResponse.json(
        { error: 'This person has not agreed to be contacted again', code: 'consent_missing' },
        { status: 409 }
      );
    }

    const at = parsed.data.at ? new Date(parsed.data.at) : undefined;
    if (at && Number.isNaN(at.getTime())) {
      return NextResponse.json({ error: 'Validation failed', details: { at: 'Invalid date' } }, { status: 400 });
    }
    await joinPool(person.id, { at, note: parsed.data.note ?? null });
    await logActivity({
      action: 're_engagement.pooled', actorId: session.user.id, actorEmail: session.user.email ?? null,
      targetType: 'user', targetId: person.id,
      detail: `${person.fullName} · ${(at ?? new Date()).toISOString().slice(0, 10)}`,
      request,
    });
    return NextResponse.json({ ok: true, pooled: true });
  });
}
