import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { updateSkill } from '@/lib/skillCuration';

// Relabel, recategorise, retire or reactivate one skill (#1817). ADMIN only;
// another org's skill answers 404 like a missing one.
const patchSchema = z.object({
  labelEn: z.string().max(200).optional(),
  labelTr: z.string().max(200).optional(),
  labelDe: z.string().max(200).optional(),
  category: z.string().max(32).optional().nullable(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The skill vocabulary feeds mentor and requisition matching — an internship module.
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'not_found', code: 'not_found' }, { status: 404 });
    const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_body' }, { status: 400 });
    const result = await updateSkill(orgId, id, parsed.data);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    await logActivity({
      action: parsed.data.status === 'RETIRED' ? 'skill.retired' : parsed.data.status === 'ACTIVE' ? 'skill.reactivated' : 'skill.updated',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'skill',
      targetId: id,
      detail: Object.keys(parsed.data).join(','),
      request,
    });
    return NextResponse.json({ skill: result.skill });
  });
}
