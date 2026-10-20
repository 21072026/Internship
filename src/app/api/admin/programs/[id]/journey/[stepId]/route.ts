import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { readStepPayload, readStepTranslations } from '@/lib/programJourneyRule';
import { STEP_SELECT, journeyProgramFor, serializeStep, stepColumns, stepInputSchema } from '@/lib/programJourneyAdmin';


async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

// One step of a programme's journey (#1853).
//   PATCH  — edit any field, and/or { published } / { archived }
//   DELETE — archive (never a hard delete: the runs it delivered stay readable
//            in the pair's journey, #1855)
// Unpublishing stops FUTURE delivery only — the sweep reads published steps,
// and the runs already recorded are left exactly as they are.

const patchSchema = stepInputSchema.partial().extend({
  published: z.boolean().optional(),
  archived: z.boolean().optional(),
});

async function loadStep(programId: string, stepId: string) {
  return prisma.programStep.findFirst({ where: { id: stepId, programId }, select: STEP_SELECT });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const { id, stepId } = await params;
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const auth = await journeyProgramFor(session, id);
  if ('refusal' in auth) return auth.refusal;
  const { program } = auth;
  return await withTenantScope(session, async () => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });
    const current = await loadStep(program.id, stepId);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { published, archived, ...fields } = parsed.data;
    const data: Record<string, unknown> = {};
    if (Object.keys(fields).length > 0) {
      const payload = readStepPayload(current.payload);
      const merged = stepInputSchema.safeParse({
        milestone: current.milestone,
        anchor: current.anchor,
        offsetDays: current.offsetDays,
        audience: current.audience,
        action: current.action,
        translations: readStepTranslations(current.translations),
        stageKey: payload.stageKey ?? null,
        url: payload.url ?? null,
        skipIf: payload.skipIf ?? null,
        ...fields,
      });
      if (!merged.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });
      const columns = await stepColumns(merged.data, program.orgId);
      if (!columns.ok) return NextResponse.json({ error: 'Validation failed', code: columns.code }, { status: 400 });
      Object.assign(data, columns.data);
    }
    if (published !== undefined) data.publishedAt = published ? current.publishedAt ?? new Date() : null;
    if (archived !== undefined) data.archivedAt = archived ? current.archivedAt ?? new Date() : null;

    const step = await prisma.programStep.update({ where: { id: current.id }, data, select: STEP_SELECT });
    return NextResponse.json({ step: serializeStep(step) });
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const { id, stepId } = await params;
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const auth = await journeyProgramFor(session, id);
  if ('refusal' in auth) return auth.refusal;
  const { program } = auth;
  return await withTenantScope(session, async () => {
    const current = await loadStep(program.id, stepId);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const step = await prisma.programStep.update({ where: { id: current.id }, data: { archivedAt: current.archivedAt ?? new Date() }, select: STEP_SELECT });
    return NextResponse.json({ step: serializeStep(step) });
  });
}
