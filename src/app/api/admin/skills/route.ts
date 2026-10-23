import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { createSkill, listSkills } from '@/lib/skillCuration';

// The org's canonical skill vocabulary (#1817). ADMIN only, checked here; the
// org always comes from the session.
const STATUSES = new Set(['ACTIVE', 'RETIRED', 'MERGED', 'ALL']);

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The skill vocabulary feeds mentor and requisition matching — an internship module.
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ skills: [], total: 0 });
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? 'ACTIVE';
    return NextResponse.json(
      await listSkills(orgId, {
        q: url.searchParams.get('q') ?? '',
        status: (STATUSES.has(status) ? status : 'ACTIVE') as 'ACTIVE' | 'RETIRED' | 'MERGED' | 'ALL',
        page: Number(url.searchParams.get('page') ?? 1) || 1,
      }),
    );
  });
}

const createSchema = z.object({
  labelEn: z.string().min(1).max(200),
  labelTr: z.string().max(200).optional(),
  labelDe: z.string().max(200).optional(),
  category: z.string().max(32).optional().nullable(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The skill vocabulary feeds mentor and requisition matching — an internship module.
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization', code: 'no_org' }, { status: 400 });
    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_label' }, { status: 400 });
    const result = await createSkill(orgId, parsed.data, session.user.id);
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    await logActivity({
      action: 'skill.created',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'skill',
      targetId: result.skill.id,
      detail: result.skill.key,
      request,
    });
    return NextResponse.json({ skill: result.skill }, { status: 201 });
  });
}
