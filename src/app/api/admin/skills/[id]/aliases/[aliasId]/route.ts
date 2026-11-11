import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { removeAlias } from '@/lib/skillCuration';
import { requirePermission } from '@/lib/authz';

// Remove one spelling from a skill (#1817). The people already linked keep
// their rows; the spelling simply stops resolving.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; aliasId: string }> }) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // The skill vocabulary feeds mentor and requisition matching — an internship module.
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  const { id, aliasId } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'not_found', code: 'not_found' }, { status: 404 });
    const result = await removeAlias(orgId, id, aliasId);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    await logActivity({
      action: 'skill.alias_removed',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'skill',
      targetId: id,
      detail: aliasId,
      request,
    });
    return NextResponse.json({ ok: true });
  });
}
