import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { acknowledgeBreaches } from '@/lib/slaBreach';

// Acknowledge an open SLA breach (#1722): somebody has it in hand, so the
// escalation ladder climbs no further. The breach stays open until the stage
// moves. ADMIN only; the tenant comes from the session and is part of the
// WHERE, so another tenant's breach answers 404 like one that does not exist.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('program.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const done = await acknowledgeBreaches([id], await tenantWhere(session), { id: session.user.id, email: session.user.email }, request);
    if (done.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
