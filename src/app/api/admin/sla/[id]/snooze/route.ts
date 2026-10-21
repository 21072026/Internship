import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { snoozeBreach } from '@/lib/slaBreach';
import { validSnooze } from '@/lib/slaLadderRule';

// Snooze an open SLA breach (#1722): no escalation before `until`, after which
// the ladder resumes where it stood. Takes a reason, which goes to the audit
// log only. ADMIN only, org from the session — see ../acknowledge/route.ts.
const schema = z.object({
  until: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const until = new Date(parsed.data.until);
  if (!validSnooze(until, new Date())) {
    return NextResponse.json({ error: 'Validation failed', code: 'invalid_snooze' }, { status: 400 });
  }
  return await withTenantScope(session, async () => {
    const result = await snoozeBreach(
      id,
      await tenantWhere(session),
      { id: session.user.id, email: session.user.email },
      until,
      parsed.data.reason,
      request
    );
    if (result === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
