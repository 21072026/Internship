import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PipelineStatus } from '@prisma/client';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';

// Pipeline stages that count as a successful outcome for conversion stats.
const HIRED: PipelineStatus[] = [PipelineStatus.HIRED_660, PipelineStatus.EMPLOYED_700];

// GET — all sources with mentee counts + conversion (hired) breakdown (admin).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const sources = await prisma.source.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { users: true } } },
  });

  // For each source, how many of its mentees reached a "hired" stage.
  const hiredRows = await prisma.user.groupBy({
    by: ['sourceId'],
    where: {
      role: 'MENTEE',
      sourceId: { not: null },
      menteeRelations: { some: { pipelineStatus: { in: HIRED } } },
    },
    _count: { _all: true },
  });
  const hiredBySource: Record<string, number> = {};
  for (const r of hiredRows) if (r.sourceId) hiredBySource[r.sourceId] = r._count?._all ?? 0;

  return NextResponse.json({
    sources: sources.map((s) => {
      const mentees = s._count.users;
      const hired = hiredBySource[s.id] ?? 0;
      return {
        id: s.id,
        name: s.name,
        contactName: s.contactName,
        contactEmail: s.contactEmail,
        mentees,
        hired,
        conversion: mentees > 0 ? Math.round((hired / mentees) * 100) : 0,
      };
    }),
  });
  });
}

const schema = z.object({
  name: z.string().min(1).max(120),
  contactName: z.string().max(120).optional(),
  contactEmail: z.string().email().max(160).optional().or(z.literal('')),
});

// POST — create a source (admin).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { name, contactName, contactEmail } = parsed.data;
  const existing = await prisma.source.findUnique({ where: { name } });
  if (existing) return NextResponse.json({ error: 'A source with that name already exists' }, { status: 409 });
  const source = await prisma.source.create({
    data: { name, contactName: contactName || null, contactEmail: contactEmail || null },
  });
  return NextResponse.json({ source }, { status: 201 });
  });
}
