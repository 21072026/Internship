import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { programWriteGate } from '@/lib/programWriteGate';
import { z } from 'zod';

// Both verbs go through programWriteGate (#3576): the programme must be in the
// caller's tenant and, for a PROGRAM_ADMIN, inside a grant — anything else is a
// 404 and nothing is written.

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  term: z.string().max(60).nullable().optional(),
});

// PATCH — rename / re-term a cohort (admin).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await programWriteGate(request, await getServerSession(authOptions), id);
  if ('error' in g) return g.error;
  return await withTenantScope(g.session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const cohort = await prisma.cohort.update({
      where: { id: g.program.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.term !== undefined ? { term: parsed.data.term || null } : {}),
      },
    });
    return NextResponse.json({ cohort });
  });
}

// DELETE — remove a cohort (admin). Relations keep their record; their cohortId
// is cleared so no mentee is orphaned.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await programWriteGate(request, await getServerSession(authOptions), id);
  if ('error' in g) return g.error;
  return await withTenantScope(g.session, async () => {
    // The programme is verified to be this tenant's, so every relation that
    // points at it is this programme's — a legacy NULL-org row included.
    await prisma.mentorshipRelation.updateMany({ where: { cohortId: g.program.id }, data: { cohortId: null } });
    await prisma.cohort.delete({ where: { id: g.program.id } }).catch(() => null);
    return NextResponse.json({ ok: true });
  });
}
