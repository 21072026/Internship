import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { dispatchWebhook } from '@/lib/webhooks';

const createInteractionSchema = z.object({
  relationId: z.string().min(1),
  date: z.string().min(1),
  notes: z.string().min(1, 'Notes are required'),
  type: z.enum(['Meeting', 'Feedback', 'Email']),
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const relationId = searchParams.get('relationId');

    const where: Record<string, unknown> = {};
    if (relationId) {
      where.relationId = relationId;
    }

    if (session.user.role === 'MENTOR') {
      where.relation = { mentorId: session.user.id };
    } else if (session.user.role === 'MENTEE') {
      where.relation = { menteeId: session.user.id };
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

    const body = await request.json();
    const parsed = createInteractionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { relationId, date, notes, type } = parsed.data;

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
        notes,
        type,
      },
    });

    await dispatchWebhook('interaction.logged', { relationId, type, date: interaction.date.toISOString() });
    return NextResponse.json({ interaction }, { status: 201 });
  } catch (error) {
    console.error('Create interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
