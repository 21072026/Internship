import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { listDeliveries } from '@/lib/webhookDelivery';

// The last delivery attempts of one webhook (#1695), newest first. ADMIN only,
// and scoped to the caller's org: another tenant's hook reads as empty.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const webhookId = params.get('webhookId') || '';
  if (!webhookId) return NextResponse.json({ error: 'webhookId is required' }, { status: 400 });
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') || '25', 10) || 25, 1), 100);
  const deliveries = await listDeliveries(webhookId, resolveOrgId(session), limit);
  return NextResponse.json({ deliveries });
}
