import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { resolvePipelineStages } from '@/lib/pipelineStages';

const labelsSchema = z.object({ en: z.string().trim().min(1).max(200), tr: z.string().trim().min(1).max(200), de: z.string().trim().min(1).max(200) }).strict();
const patchSchema = z.object({
  orgId: z.string().min(1),
  key: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  labels: labelsSchema.optional(),
  appliesToStage: z.string().trim().min(1).max(60).nullable().optional(),
  appliesToRole: z.enum(['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE']).nullable().optional(),
  mandatory: z.boolean().optional(), order: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional(),
}).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const current = await prisma.documentRequirement.findUnique({ where: { id }, select: { id: true, orgId: true, key: true } });
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (current.orgId !== parsed.data.orgId) return NextResponse.json({ error: 'Organization mismatch' }, { status: 403 });
  if (parsed.data.appliesToStage) {
    const stages = await resolvePipelineStages(current.orgId);
    if (!stages.some((stage) => stage.key === parsed.data.appliesToStage)) return NextResponse.json({ error: 'Invalid pipeline stage' }, { status: 400 });
  }
  const { orgId: _orgId, ...data } = parsed.data;
  try {
    const requirement = await prisma.documentRequirement.update({ where: { id }, data });
    await logActivity({ action: 'document_requirement.update', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'document_requirement', targetId: id, detail: requirement.key, request });
    return NextResponse.json({ requirement });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return NextResponse.json({ error: 'A requirement with this key already exists' }, { status: 409 });
    throw error;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const orgId = new URL(request.url).searchParams.get('orgId');
  if (!orgId) return NextResponse.json({ error: 'orgId is required' }, { status: 400 });
  const current = await prisma.documentRequirement.findUnique({ where: { id }, select: { orgId: true, key: true } });
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (current.orgId !== orgId) return NextResponse.json({ error: 'Organization mismatch' }, { status: 403 });
  await prisma.documentRequirement.delete({ where: { id } });
  await logActivity({ action: 'document_requirement.delete', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'document_requirement', targetId: id, detail: current.key, request });
  return NextResponse.json({ ok: true });
}
