import { NextResponse } from 'next/server';
import { getServerSession, type Session } from 'next-auth';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { mayManageOrgRequirements } from '@/lib/documentRequirementAccess';

// Deliberately not wrapped in withTenantScope: the org is an explicit
// parameter a super admin may point at any tenant. The authorisation is
// mayManageOrgRequirements() (#2542), and every query names `orgId` itself.

const labelsSchema = z.object({
  en: z.string().trim().min(1).max(200),
  tr: z.string().trim().min(1).max(200),
  de: z.string().trim().min(1).max(200),
}).strict();
const roleSchema = z.enum(['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE']);
const bodySchema = z.object({
  orgId: z.string().min(1),
  key: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  labels: labelsSchema,
  appliesToStage: z.string().trim().min(1).max(60).nullable().optional(),
  appliesToRole: roleSchema.nullable().optional(),
  mandatory: z.boolean().optional(),
  order: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
}).strict();

async function adminSession() {
  const session = await getServerSession(authOptions);
  return session?.user.role === 'ADMIN' ? session : null;
}

async function validOrgStage(session: Session, route: string, orgId: string, stage?: string | null) {
  // Refused before the lookup, with the same answer as a missing org, so it
  // cannot confirm that a foreign org id exists.
  if (!(await mayManageOrgRequirements(session, orgId, route))) return { error: 'Organization not found', status: 404 } as const;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return { error: 'Organization not found', status: 404 } as const;
  if (stage) {
    const stages = await resolvePipelineStages(orgId);
    if (!stages.some((candidate) => candidate.key === stage)) return { error: 'Invalid pipeline stage', status: 400 } as const;
  }
  return { org } as const;
}

export async function GET(request: Request) {
  const session = await adminSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = new URL(request.url).searchParams.get('orgId');
  if (!orgId) return NextResponse.json({ error: 'orgId is required' }, { status: 400 });
  const gate = await validOrgStage(session, 'GET /api/admin/document-requirements', orgId);
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const requirements = await prisma.documentRequirement.findMany({
    where: { orgId },
    orderBy: [{ order: 'asc' }, { key: 'asc' }],
  });
  return NextResponse.json({ requirements });
}

export async function POST(request: Request) {
  const session = await adminSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const gate = await validOrgStage(session, 'POST /api/admin/document-requirements', parsed.data.orgId, parsed.data.appliesToStage);
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  try {
    const requirement = await prisma.documentRequirement.create({
      data: {
        ...parsed.data,
        labels: parsed.data.labels,
        appliesToStage: parsed.data.appliesToStage ?? null,
        appliesToRole: parsed.data.appliesToRole ?? null,
        mandatory: parsed.data.mandatory ?? true,
        order: parsed.data.order ?? 0,
        active: parsed.data.active ?? true,
      },
    });
    await logActivity({ action: 'document_requirement.create', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'document_requirement', targetId: requirement.id, detail: requirement.key, request });
    return NextResponse.json({ requirement }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'A requirement with this key already exists' }, { status: 409 });
    }
    throw error;
  }
}
