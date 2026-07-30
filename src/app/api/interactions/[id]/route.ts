import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';

const updateInteractionSchema = z.object({
  date: z.string().optional(),
  notes: z.string().min(1).max(TEXT_LIMITS.interactionNotes).optional(),
  type: z.enum(['Meeting', 'Feedback', 'Email']).optional(),
});

async function getInteractionAndVerifyAccess(id: string, userId: string, role: string) {
  const interaction = await prisma.interactionLog.findUnique({
    where: { id },
    include: { relation: true },
  });

  if (!interaction) return { interaction: null, authorized: false };

  const authorized =
    role === 'ADMIN' || interaction.relation.mentorId === userId;

  return { interaction, authorized };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { interaction, authorized } = await getInteractionAndVerifyAccess(
      id,
      session.user.id,
      session.user.role
    );

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    if (!authorized && interaction.relation.menteeId !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json({ interaction });
  } catch (error) {
    console.error('Get interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { interaction, authorized } = await getInteractionAndVerifyAccess(
      id,
      session.user.id,
      session.user.role
    );

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateInteractionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await prisma.interactionLog.update({
      where: { id },
      data: {
        ...parsed.data,
        date: parsed.data.date ? new Date(parsed.data.date) : undefined,
      },
    });

    return NextResponse.json({ interaction: updated });
  } catch (error) {
    console.error('Update interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { interaction, authorized } = await getInteractionAndVerifyAccess(
      id,
      session.user.id,
      session.user.role
    );

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await prisma.interactionLog.delete({ where: { id } });

    return NextResponse.json({ message: 'Interaction deleted successfully' });
  } catch (error) {
    console.error('Delete interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
