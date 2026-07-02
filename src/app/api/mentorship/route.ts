import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { dispatchWebhook } from '@/lib/webhooks';

const createRelationSchema = z.object({
  mentorId: z.string().min(1),
  menteeId: z.string().min(1),
  companyId: z.string().optional(),
  projectId: z.string().optional(),
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
    const search = searchParams.get('search');
    // Pagination is opt-in: only applied when `page` is explicitly passed, so
    // the many callers that expect the full list (board views, mentee/mentor
    // dashboards, meeting/email composers) keep working unchanged.
    const pageParam = searchParams.get('page');
    const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10) || 20));

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
    if (search) {
      where.OR = [
        { mentor: { fullName: { contains: search } } },
        { mentee: { fullName: { contains: search } } },
        { company: { name: { contains: search } } },
      ];
    }

    const include = {
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
    };

    if (!pageParam) {
      const relations = await prisma.mentorshipRelation.findMany({ where, include, orderBy: { startDate: 'desc' } });
      return NextResponse.json({ relations });
    }

    const [total, relations] = await Promise.all([
      prisma.mentorshipRelation.count({ where }),
      prisma.mentorshipRelation.findMany({
        where,
        include,
        orderBy: { startDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({ relations, total, page, pageSize });
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

    const { mentorId, menteeId, companyId, projectId, startDate } = parsed.data;

    const [mentor, mentee] = await Promise.all([
      prisma.user.findUnique({ where: { id: mentorId } }),
      prisma.user.findUnique({ where: { id: menteeId } }),
    ]);

    // Admins can also mentor, so they're valid mentors too.
    if (!mentor || (mentor.role !== 'MENTOR' && mentor.role !== 'ADMIN')) {
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
        projectId: projectId || null,
        startDate: startDate ? new Date(startDate) : new Date(),
      },
      include: {
        mentor: { select: { id: true, fullName: true, email: true } },
        mentee: { select: { id: true, fullName: true, email: true } },
        company: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    await dispatchWebhook('mentorship.created', { relationId: relation.id, mentorId, menteeId, companyId: companyId || null });
    return NextResponse.json({ relation }, { status: 201 });
  } catch (error) {
    console.error('Create mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
