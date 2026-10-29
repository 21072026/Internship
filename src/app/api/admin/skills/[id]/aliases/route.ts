import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { addAlias } from '@/lib/skillCuration';
import { requirePermission } from '@/lib/authz';

// Add a spelling to a skill (#1817). A spelling another skill already owns —
// as its key or an alias — is refused (409 duplicate): that is a merge.
const bodySchema = z.object({ alias: z.string().min(1).max(200) });

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
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_alias' }, { status: 400 });
    const result = await addAlias(orgId, id, parsed.data.alias);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    await logActivity({
      action: 'skill.alias_added',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'skill',
      targetId: id,
      detail: result.alias.key,
      request,
    });
    return NextResponse.json({ alias: result.alias }, { status: 201 });
  });
}
