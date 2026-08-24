import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { scopeForRole, logScopeDenial } from '@/lib/authzScope';
import { z } from 'zod';
import { dispatchWebhook } from '@/lib/webhooks';
import { notifyIfAllowed } from '@/lib/notify';
import { TEXT_LIMITS } from '@/lib/textLimits';

const createInteractionSchema = z.object({
  relationId: z.string().min(1),
  date: z.string().min(1),
  subject: z.string().max(TEXT_LIMITS.interactionSubject).optional(),
  notes: z.string().min(1, 'Notes are required').max(TEXT_LIMITS.interactionNotes),
  type: z.enum(['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp']),
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const { searchParams } = new URL(request.url);
    const relationId = searchParams.get('relationId');

    const where: Record<string, unknown> = {};
    if (relationId) {
      where.relationId = relationId;
    }

    // Fail-closed scoping (#847): COMPANY and SOURCE used to fall past this
    // chain with an empty `where` and read every mentee's interaction log.
    // A role with no defined scope is now denied outright.
    const relationScope = await scopeForRole(session.user, 'relation');
    if (!relationScope) {
      await logScopeDenial(session.user, 'GET /api/interactions');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (Object.keys(relationScope).length > 0) {
      where.relation = relationScope;
    }

    const interactions = await prisma.interactionLog.findMany({
      where,
      include: {
        relation: {
          include: {
            mentor: { select: { id: true, fullName: true } },
            mentee: { select: { id: true, fullName: true } },
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    return NextResponse.json({ interactions });
    });
  } catch (error) {
    console.error('Get interactions error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const body = await request.json();
    const parsed = createInteractionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { relationId, date, subject, notes, type } = parsed.data;

    const relation = await prisma.mentorshipRelation.findUnique({
      where: { id: relationId },
    });

    if (!relation) {
      return NextResponse.json({ error: 'Mentorship relation not found' }, { status: 404 });
    }

    const isAuthorized =
      session.user.role === 'ADMIN' || relation.mentorId === session.user.id;

    if (!isAuthorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const interaction = await prisma.interactionLog.create({
      data: {
        relationId,
        date: new Date(date),
        subject: subject || null,
        notes,
        type,
      },
    });

    await dispatchWebhook('interaction.logged', { relationId, type, date: interaction.date.toISOString() });
    // The mentee learns their mentor logged something (#924) — previously this
    // was completely silent. No echo: only a mentor/admin can reach this point,
    // but the guard stays cheap insurance against future role changes. The
    // notification carries no note content, just the fact.
    if (relation.menteeId !== session.user.id) {
      await notifyIfAllowed(relation.menteeId, 'interactions', 'interaction.logged', {}, '/portal/journey');
    }
    return NextResponse.json({ interaction }, { status: 201 });
    });
  } catch (error) {
    console.error('Create interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
