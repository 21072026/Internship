import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
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
    // Pagination. `all=1` returns everything (used by CSV/Excel export so the
    // download isn't limited to the current page).
    const all = searchParams.get('all') === '1';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '24', 10) || 24));

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

    const select = {
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
        where: { status: 'ACTIVE' as const },
        include: {
          mentor: { select: { id: true, fullName: true } },
          company: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
        },
      },
    };
    const normalize = (c: { skills: unknown }) => ({ ...c, skills: (c.skills ?? []) as string[] });
    const matchesSkills = (c: { skills: string[] }) => {
      if (skillList.length === 0) return true;
      const owned = c.skills.map((k) => k.toLowerCase());
      // Every typed term must be a substring of at least one skill (so "docke"
      // matches "Docker"), case-insensitive.
      return skillList.every((term) => owned.some((k) => k.includes(term)));
    };

    let candidates;
    let total: number;
    if (skillList.length === 0) {
      // No JSON-skill filter → paginate at the database level.
      total = await prisma.user.count({ where });
      const raw = await prisma.user.findMany({
        where,
        select,
        orderBy: { createdAt: 'desc' },
        ...(all ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
      });
      candidates = raw.map(normalize);
    } else {
      // Skill filter is applied in-memory (MySQL JSON arrays don't support
      // hasSome), so fetch, filter, then slice the page from the filtered set.
      const raw = await prisma.user.findMany({ where, select, orderBy: { createdAt: 'desc' } });
      const filtered = raw.map(normalize).filter(matchesSkills);
      total = filtered.length;
      candidates = all ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize);
    }

    return NextResponse.json({ candidates, total, page, pageSize });
    });
  } catch (error) {
    console.error('Get candidates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
