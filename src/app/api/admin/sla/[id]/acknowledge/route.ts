import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { acknowledgeBreach } from '@/lib/slaBreach';

// Acknowledge an open SLA breach (#1722): somebody has it in hand, so the
// escalation ladder climbs no further. The breach stays open until the stage
// moves. ADMIN only; the org comes from the session and is part of the write's
// WHERE, so another tenant's breach answers 404 like one that does not exist.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const result = await acknowledgeBreach(id, orgId, { id: session.user.id, email: session.user.email }, request);
    if (result === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
