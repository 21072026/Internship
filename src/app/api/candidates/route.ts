import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const skills = searchParams.get('skills');
    const graduationYear = searchParams.get('graduationYear');
    const search = searchParams.get('search');
    const pipelineStatus = searchParams.get('status');
    const city = searchParams.get('city');
    const company = searchParams.get('company');
    const project = searchParams.get('project');
    const cohortId = searchParams.get('cohort');
    const sourceId = searchParams.get('source');

    const where: Record<string, unknown> = {
      role: 'MENTEE',
    };
    if (sourceId) where.sourceId = sourceId;

    const relSome: Record<string, unknown> = {};
    if (pipelineStatus) relSome.pipelineStatus = pipelineStatus;
    if (company) relSome.company = { name: company };
    if (project) relSome.project = { name: { contains: project } };
    if (cohortId) relSome.cohortId = cohortId;
    if (Object.keys(relSome).length) where.menteeRelations = { some: relSome };
    if (city) where.city = { contains: city };

    // skills filtering is applied in-memory after fetching (MySQL JSON arrays don't support hasSome)
    const skillList = skills
      ? skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];

    if (graduationYear) {
      const year = parseInt(graduationYear, 10);
      if (!isNaN(year)) {
        where.graduationYear = year;
      }
    }

    if (search) {
      where.OR = [
        { fullName: { contains: search } },
        { email: { contains: search } },
        { university: { contains: search } },
        { department: { contains: search } },
      ];
    }

    const rawCandidates = await prisma.user.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        email: true,
        university: true,
        department: true,
        graduationYear: true,
        skills: true,
        cvUrl: true,
        phone: true,
        whatsapp: true,
        city: true,
        createdAt: true,
        isActive: true,
        source: { select: { id: true, name: true } },
        menteeRelations: {
          where: { status: 'ACTIVE' },
          include: {
            mentor: { select: { id: true, fullName: true } },
            company: { select: { id: true, name: true } },
            project: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Normalise skills (stored as JSON array) and apply optional skill filter
    const candidates = rawCandidates
      .map((c) => ({ ...c, skills: (c.skills ?? []) as string[] }))
      .filter((c) => {
        if (skillList.length === 0) return true;
        const owned = c.skills.map((k) => k.toLowerCase());
        // Every typed term must be a substring of at least one of the candidate's
        // skills (so "docke" matches "Docker"), case-insensitive.
        return skillList.every((term) => owned.some((k) => k.includes(term)));
      });

    return NextResponse.json({ candidates });
  } catch (error) {
    console.error('Get candidates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
