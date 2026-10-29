import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { mergePreview, mergeSkill } from '@/lib/skillCuration';
import { requirePermission } from '@/lib/authz';

// Merge one skill into another (#1817). GET ?targetId= previews how many
// people and requisitions move — the dialog states it before anything is
// written; POST { targetId } does it in one transaction. The losing row is
// never deleted, so every old reference keeps resolving.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // The skill vocabulary feeds mentor and requisition matching — an internship module.
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'not_found', code: 'not_found' }, { status: 404 });
    const targetId = new URL(request.url).searchParams.get('targetId') ?? '';
    const result = await mergePreview(orgId, id, targetId);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    return NextResponse.json({ users: result.users, requisitions: result.requisitions, alreadyBoth: result.alreadyBoth });
  });
}

const bodySchema = z.object({ targetId: z.string().min(1).max(64) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // The skill vocabulary feeds mentor and requisition matching — an internship module.
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'not_found', code: 'not_found' }, { status: 404 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_body' }, { status: 400 });
    const result = await mergeSkill(orgId, id, parsed.data.targetId);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    await logActivity({
      action: 'skill.merged',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'skill',
      targetId: id,
      detail: `into ${parsed.data.targetId} · users ${result.movedUsers} · requisitions ${result.movedRequisitions}`,
      request,
    });
    return NextResponse.json({ movedUsers: result.movedUsers, movedRequisitions: result.movedRequisitions });
  });
}
