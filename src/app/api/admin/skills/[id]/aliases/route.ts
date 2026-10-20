import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { addAlias } from '@/lib/skillCuration';

// Add a spelling to a skill (#1817). A spelling another skill already owns —
// as its key or an alias — is refused (409 duplicate): that is a merge.
const bodySchema = z.object({ alias: z.string().min(1).max(200) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
