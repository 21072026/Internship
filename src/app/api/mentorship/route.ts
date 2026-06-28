import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const createRelationSchema = z.object({
  mentorId: z.string().min(1),
  menteeId: z.string().min(1),
  companyId: z.string().optional(),
  startDate: z.string().optional(),
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    const where: Record<string, unknown> = {};

    if (session.user.role === 'MENTOR') {
      where.mentorId = session.user.id;
    } else if (session.user.role === 'MENTEE') {
      where.menteeId = session.user.id;
    } else if (session.user.role === 'COMPANY') {
      // Read-only: only relations linked to this company.
      where.companyId = session.user.companyId ?? '__none__';
    }

    if (status) {
      where.status = status;
    }

    const relations = await prisma.mentorshipRelation.findMany({
      where,
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
          },
        },
        company: { select: { id: true, name: true, industry: true } },
        _count: { select: { interactions: true } },
      },
      orderBy: { startDate: 'desc' },
    });

    return NextResponse.json({ relations });
  } catch (error) {
    console.error('Get mentorships error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = createRelationSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { mentorId, menteeId, companyId, startDate } = parsed.data;

    const [mentor, mentee] = await Promise.all([
      prisma.user.findUnique({ where: { id: mentorId } }),
      prisma.user.findUnique({ where: { id: menteeId } }),
    ]);

    if (!mentor || mentor.role !== 'MENTOR') {
      return NextResponse.json({ error: 'Invalid mentor' }, { status: 400 });
    }

    if (!mentee || mentee.role !== 'MENTEE') {
      return NextResponse.json({ error: 'Invalid mentee' }, { status: 400 });
    }

    const existingActive = await prisma.mentorshipRelation.findFirst({
      where: { menteeId, status: 'ACTIVE' },
    });

    if (existingActive) {
      return NextResponse.json(
        { error: 'This mentee already has an active mentorship relation' },
        { status: 409 }
      );
    }

    const relation = await prisma.mentorshipRelation.create({
      data: {
        mentorId,
        menteeId,
        companyId: companyId || null,
        startDate: startDate ? new Date(startDate) : new Date(),
      },
      include: {
        mentor: { select: { id: true, fullName: true, email: true } },
        mentee: { select: { id: true, fullName: true, email: true } },
        company: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({ relation }, { status: 201 });
  } catch (error) {
    console.error('Create mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
