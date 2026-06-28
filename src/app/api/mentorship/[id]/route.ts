import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { PIPELINE_STATUSES } from '@/lib/pipeline';

const updateRelationSchema = z.object({
  status: z.enum(['ACTIVE', 'COMPLETED']).optional(),
  pipelineStatus: z.enum(PIPELINE_STATUSES).optional(),
  companyId: z.string().nullable().optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const relation = await prisma.mentorshipRelation.findUnique({
      where: { id },
      include: {
        mentor: { select: { id: true, fullName: true, email: true, department: true } },
        mentee: {
          select: {
            id: true,
            fullName: true,
            email: true,
            university: true,
            graduationYear: true,
            skills: true,
            phone: true,
            whatsapp: true,
            city: true,
            birthDate: true,
            referralSource: true,
            cvUrl: true,
          },
        },
        company: true,
        interactions: { orderBy: { date: 'desc' } },
        statusChanges: {
          orderBy: { createdAt: 'desc' },
          include: { changedBy: { select: { fullName: true } } },
        },
      },
    });

    if (!relation) {
      return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    }

    const isAuthorized =
      session.user.role === 'ADMIN' ||
      relation.mentorId === session.user.id ||
      relation.menteeId === session.user.id;

    if (!isAuthorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json({ relation });
  } catch (error) {
    console.error('Get mentorship error:', error);
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

    const relation = await prisma.mentorshipRelation.findUnique({
      where: { id },
    });

    if (!relation) {
      return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    }

    const isAuthorized =
      session.user.role === 'ADMIN' || relation.mentorId === session.user.id;

    if (!isAuthorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateRelationSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await prisma.mentorshipRelation.update({
      where: { id },
      data: parsed.data as Prisma.MentorshipRelationUncheckedUpdateInput,
      include: {
        mentor: { select: { id: true, fullName: true, email: true } },
        mentee: { select: { id: true, fullName: true, email: true } },
        company: { select: { id: true, name: true } },
      },
    });

    // Record an audit entry when the pipeline stage actually changes.
    if (parsed.data.pipelineStatus && parsed.data.pipelineStatus !== relation.pipelineStatus) {
      await prisma.statusChange.create({
        data: {
          relationId: id,
          fromStatus: relation.pipelineStatus,
          toStatus: parsed.data.pipelineStatus,
          changedById: session.user.id,
        },
      });
      await logActivity({
        action: 'pipeline.stage_change',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'relation',
        targetId: id,
        detail: `${relation.pipelineStatus} → ${parsed.data.pipelineStatus}`,
      });
    }

    return NextResponse.json({ relation: updated });
  } catch (error) {
    console.error('Update mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
