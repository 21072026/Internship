import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { MAX_EDGES_PER_SKILL, setEdges } from '@/lib/skillCuration';

// Replace a skill's neighbours (#1817): what adjacency-aware matching counts
// as "close enough", with a weight 0..1 each.
const bodySchema = z.object({
  edges: z
    .array(
      z.object({
        skillId: z.string().min(1).max(64),
        weight: z.number().min(0).max(1),
        kind: z.enum(['ADJACENT', 'BROADER', 'NARROWER']).optional(),
      }),
    )
    .max(MAX_EDGES_PER_SKILL),
});

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_body' }, { status: 400 });
    const result = await setEdges(orgId, id, parsed.data.edges);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    await logActivity({
      action: 'skill.edges_set',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'skill',
      targetId: id,
      detail: `${result.count} neighbour(s)`,
      request,
    });
    return NextResponse.json({ count: result.count });
  });
}
