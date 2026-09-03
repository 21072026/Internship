import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isHexColor } from '@/lib/branding';
import { resolvePipelineStages, defaultPipelineStages } from '@/lib/pipelineStages';
import { isSuperAdmin, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';

// Per-tenant pipeline-stage management (#747). Admin-only; premium-gated (custom
// stages require a paid plan). Phase A: label / order / color / on-path grouping
// over the canonical keys — an org with no rows uses the built-in defaults.

async function requireAdminOrg(id: string, route: string) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return { error: 'Unauthorized' as const, status: 401 };
  // Same rule as the parent route (#1535): a super admin may manage any tenant,
  // a plain ADMIN only their own — and the refusal comes before the lookup, so
  // it cannot confirm whether a foreign org id exists.
  if (!(await isSuperAdmin(session))) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== id) {
      await logCrossTenantDenial(session, route, id);
      return { error: 'Forbidden' as const, status: 403 };
    }
  }
  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) return { error: 'Organization not found' as const, status: 404 };
  return { org };
}

// GET — the org's resolved stages plus whether they are customized.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAdminOrg(id, 'GET /api/admin/organizations/[id]/pipeline-stages');
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const count = await prisma.pipelineStage.count({ where: { orgId: id } });
  const stages = await resolvePipelineStages(id);
  return NextResponse.json({ stages, custom: count > 0, plan: gate.org.plan });
}

const stageSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[A-Za-z0-9_]+$/, 'Key must be alphanumeric/underscore'),
  label: z.string().min(1).max(120),
  order: z.number().int().min(0).max(1000),
  isTerminal: z.boolean().optional(),
  isOffPath: z.boolean().optional(),
  color: z.string().optional().nullable(),
});
const putSchema = z.object({ stages: z.array(stageSchema).min(1).max(50) });

// PUT — replace the org's stage set. Premium-gated (not FREE). Keys must be unique.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAdminOrg(id, 'PUT /api/admin/organizations/[id]/pipeline-stages');
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (gate.org.plan === 'FREE') {
    return NextResponse.json({ error: 'Custom pipeline stages require a paid plan' }, { status: 403 });
  }

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const stages = parsed.data.stages;

  const keys = stages.map((s) => s.key);
  if (new Set(keys).size !== keys.length) {
    return NextResponse.json({ error: 'Stage keys must be unique' }, { status: 400 });
  }
  for (const s of stages) {
    if (s.color && s.color.trim() && !isHexColor(s.color)) {
      return NextResponse.json({ error: `Color for "${s.key}" must be a hex value like #2563eb` }, { status: 400 });
    }
  }

  // Replace the whole set atomically so order/keys stay consistent.
  await prisma.$transaction([
    prisma.pipelineStage.deleteMany({ where: { orgId: id } }),
    prisma.pipelineStage.createMany({
      data: stages.map((s) => ({
        orgId: id,
        key: s.key,
        label: s.label.trim(),
        order: s.order,
        isTerminal: s.isTerminal ?? false,
        isOffPath: s.isOffPath ?? false,
        color: s.color && s.color.trim() ? s.color.trim() : null,
      })),
    }),
  ]);

  const resolved = await resolvePipelineStages(id);
  return NextResponse.json({ stages: resolved, custom: true });
}

// DELETE — reset to the built-in canonical stages (drop all custom rows).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAdminOrg(id, 'DELETE /api/admin/organizations/[id]/pipeline-stages');
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });

  await prisma.pipelineStage.deleteMany({ where: { orgId: id } });
  return NextResponse.json({ stages: defaultPipelineStages(), custom: false });
}
