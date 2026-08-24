import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { resolveStageSlas } from '@/lib/stageSla';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';

// Per-stage service levels (#817).
//
// NOT gated behind a plan: custom pipeline STAGES are premium, but "how long
// may somebody wait here" is about candidate experience, which this product
// keeps in the free core. It is also why the SLA lives in its own table rather
// than as a column on PipelineStage — that editor is premium and rewrites its
// whole set on every save.

const schema = z.object({
  slas: z
    .array(
      z.object({
        stageKey: z.string().min(1).max(60),
        // 0 or null removes the SLA for that stage — an org can always go back
        // to "no rule here" without deleting anything else.
        days: z.number().int().min(0).max(365).nullable(),
      })
    )
    .max(60),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    const stages = await resolvePipelineStages(orgId);
    const slas = await resolveStageSlas(orgId);
    // Every stage is listed, configured or not, so the form shows the whole
    // pipeline rather than only the rules that already exist.
    return NextResponse.json({
      stages: stages.map((s) => ({
        key: s.key,
        label: s.label,
        isOffPath: s.isOffPath,
        isTerminal: s.isTerminal,
        days: slas.get(s.key) ?? null,
      })),
    });
  });
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const known = new Set((await resolvePipelineStages(orgId)).map((s) => s.key));
    const unknown = parsed.data.slas.filter((s) => !known.has(s.stageKey)).map((s) => s.stageKey);
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Validation failed', details: { formErrors: [`Unknown stages: ${unknown.join(', ')}`] } },
        { status: 400 }
      );
    }

    const keep = parsed.data.slas.filter((s) => s.days != null && s.days > 0) as { stageKey: string; days: number }[];
    const drop = parsed.data.slas.filter((s) => s.days == null || s.days === 0).map((s) => s.stageKey);

    await prisma.$transaction([
      ...(drop.length > 0
        ? [prisma.stageSla.deleteMany({ where: { orgId, stageKey: { in: drop } } })]
        : []),
      ...keep.map((s) =>
        prisma.stageSla.upsert({
          where: { orgId_stageKey: { orgId, stageKey: s.stageKey } },
          update: { days: s.days },
          create: { orgId, stageKey: s.stageKey, days: s.days },
        })
      ),
    ]);

    await logActivity({
      action: 'stage_sla.updated',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'organization',
      targetId: orgId,
      detail: `${keep.length} configured, ${drop.length} cleared`,
      request,
    });

    return NextResponse.json({ ok: true, configured: keep.length });
  });
}
