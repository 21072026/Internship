import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { writeSetting } from '@/lib/settingsWrite';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { logActivity } from '@/lib/activity';
import { requireCapability } from '@/lib/capabilityGate';
import { SCREENING_ITEMS, parseRequired, serializeRequired } from '@/lib/mentorScreeningRule';

// The org's screening policy (#1807): which checklist items must be done
// before a mentor application may be approved. An ordinary per-tenant setting
// (`mentorScreeningRequired`), written to the CALLER's org row only (#2628).
// Empty = none required = approval as before. Enforced in the approve handler,
// never by a disabled button. ADMIN only, checked here.

async function guard() {
  const session = await getServerSession(authOptions);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return { error: capGate };
  return { session, orgId: await settingsOrgOf(session) };
}

export async function GET() {
  const g = await guard();
  if ('error' in g) return g.error;
  return NextResponse.json({ required: parseRequired(await resolveSettingRaw('mentorScreeningRequired', { orgId: g.orgId })) });
}

const schema = z.object({ required: z.array(z.enum(SCREENING_ITEMS)).max(SCREENING_ITEMS.length) }).strict();

export async function PUT(request: Request) {
  const g = await guard();
  if ('error' in g) return g.error;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const value = serializeRequired(parsed.data.required);
  return withTenantScope(g.session, async () => {
    await writeSetting('mentorScreeningRequired', value, g.orgId, { actor: { id: g.session.user.id, email: g.session.user.email } });
    await logActivity({
      action: 'mentor_application.screening_policy',
      actorId: g.session.user.id,
      actorEmail: g.session.user.email ?? null,
      detail: value || 'none',
      request,
      orgId: g.orgId,
    });
    return NextResponse.json({ required: parseRequired(value) });
  });
}
