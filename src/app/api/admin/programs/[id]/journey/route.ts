import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { journeyTemplate } from '@/lib/programJourneyRule';
import { STEP_SELECT, authorizeJourneyAdmin, serializeStep, stepColumns, stepInputSchema } from '@/lib/programJourneyAdmin';

// The journey builder's collection (#1853): the programme's steps, its pairs
// for the preview picker, and the journey as a template a clone can copy.
//   GET   — everything the builder renders
//   POST  — add a step (a draft until published)
//   PATCH — { order: id[] } reorders; { publish: 'all' } publishes every draft
// Authorization is server-side on every verb (src/lib/programJourneyAdmin.ts).

const MAX_STEPS = 200;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeJourneyAdmin((await params).id);
  if ('refusal' in auth) return auth.refusal;
  const { session, program } = auth;
  return await withTenantScope(session, async () => {
    const [steps, relations] = await Promise.all([
      prisma.programStep.findMany({ where: { programId: program.id }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }], select: STEP_SELECT }),
      prisma.mentorshipRelation.findMany({
        where: { cohortId: program.id, status: 'ACTIVE' },
        orderBy: { startDate: 'desc' },
        take: 200,
        select: { id: true, startDate: true, mentee: { select: { fullName: true } }, mentor: { select: { fullName: true } } },
      }),
    ]);
    return NextResponse.json({
      program: { id: program.id, name: program.name, term: program.term },
      steps: steps.map(serializeStep),
      relations: relations.map((r) => ({ id: r.id, startDate: r.startDate.toISOString(), menteeName: r.mentee.fullName, mentorName: r.mentor.fullName })),
      template: journeyTemplate(steps),
    });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeJourneyAdmin((await params).id);
  if ('refusal' in auth) return auth.refusal;
  const { session, program } = auth;
  return await withTenantScope(session, async () => {
    const parsed = stepInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });
    const columns = await stepColumns(parsed.data, program.orgId);
    if (!columns.ok) return NextResponse.json({ error: 'Validation failed', code: columns.code }, { status: 400 });
    const count = await prisma.programStep.count({ where: { programId: program.id } });
    if (count >= MAX_STEPS) return NextResponse.json({ error: 'Too many steps', code: 'too_many' }, { status: 400 });
    const last = await prisma.programStep.aggregate({ where: { programId: program.id }, _max: { order: true } });
    const step = await prisma.programStep.create({
      data: { ...columns.data, orgId: program.orgId, programId: program.id, order: (last._max.order ?? -1) + 1 },
      select: STEP_SELECT,
    });
    return NextResponse.json({ step: serializeStep(step) }, { status: 201 });
  });
}

const patchSchema = z.union([
  z.object({ order: z.array(z.string().min(1).max(40)).min(1).max(MAX_STEPS) }),
  z.object({ publish: z.literal('all') }),
]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeJourneyAdmin((await params).id);
  if ('refusal' in auth) return auth.refusal;
  const { session, program } = auth;
  return await withTenantScope(session, async () => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    if ('publish' in parsed.data) {
      const r = await prisma.programStep.updateMany({ where: { programId: program.id, publishedAt: null, archivedAt: null }, data: { publishedAt: new Date() } });
      return NextResponse.json({ published: r.count });
    }
    const ids = parsed.data.order;
    const owned = await prisma.programStep.findMany({ where: { programId: program.id, id: { in: ids } }, select: { id: true } });
    // Every id must be one of this programme's steps; a foreign id is not reordered into it.
    if (owned.length !== new Set(ids).size) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await prisma.$transaction(ids.map((id, order) => prisma.programStep.updateMany({ where: { id, programId: program.id }, data: { order } })));
    return NextResponse.json({ ok: true });
  });
}
