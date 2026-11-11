import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { decideUnmappedTerm } from '@/lib/skillQueue';
import { requirePermission } from '@/lib/authz';

// Decide one queued skill term (#1819): promote it to a canonical skill, alias
// it onto an existing one, or discard it. Promote and alias link everybody whose
// free text already carries the term. ADMIN only; org from the session; a term
// of another org answers 404 like a missing one.
const bodySchema = z.object({
  action: z.enum(['promote', 'alias', 'discard']),
  skillId: z.string().min(1).max(64).optional(),
  labelEn: z.string().max(200).optional(),
  labelTr: z.string().max(200).optional(),
  labelDe: z.string().max(200).optional(),
});

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
    if (!orgId) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', code: 'invalid_body' }, { status: 400 });
    }

    const result = await decideUnmappedTerm(orgId, id, parsed.data, session.user.id);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });

    await logActivity({
      action: `skill.unmapped.${parsed.data.action}`,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'unmappedSkillTerm',
      targetId: id,
      detail: result.skillId ? `skill ${result.skillId}` : null,
      request,
    });
    return NextResponse.json(result);
  });
}
