import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { decideUnmappedTerm } from '@/lib/skillQueue';

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
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
