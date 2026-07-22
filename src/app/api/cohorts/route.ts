import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { z } from 'zod';

// GET — all cohorts with intern counts + per-stage distribution (admin).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const cohorts = await prisma.cohort.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { relations: true } } } });
  const dist = await prisma.mentorshipRelation.groupBy({
    by: ['cohortId', 'pipelineStatus'],
    where: { cohortId: { not: null } },
    _count: { _all: true },
  });
  const byCohort: Record<string, Record<string, number>> = {};
  for (const d of dist) {
    if (!d.cohortId) continue;
    (byCohort[d.cohortId] ||= {})[d.pipelineStatus] = d._count._all;
  }
  return NextResponse.json({ cohorts: cohorts.map((c) => ({ id: c.id, name: c.name, term: c.term, interns: c._count.relations, distribution: byCohort[c.id] ?? {} })) });
  });
}

const schema = z.object({ name: z.string().min(1).max(120), term: z.string().max(60).optional() });

// POST — create a cohort (admin).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  // Trim so a whitespace-only term is stored as null (shows as "—") rather than
  // a blank string. Term is free-text (e.g. "Fall 2026"), so no format check.
  const cohort = await prisma.cohort.create({ data: { name: parsed.data.name.trim(), term: parsed.data.term?.trim() || null } });
  return NextResponse.json({ cohort }, { status: 201 });
  });
}
