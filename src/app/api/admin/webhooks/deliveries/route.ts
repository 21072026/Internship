import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { listDeliveries } from '@/lib/webhookDelivery';

// The last delivery attempts of one webhook (#1695), newest first. ADMIN only,
// and scoped to the caller's org: another tenant's hook reads as empty.
export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const params = new URL(request.url).searchParams;
  const webhookId = params.get('webhookId') || '';
  if (!webhookId) return NextResponse.json({ error: 'webhookId is required' }, { status: 400 });
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') || '25', 10) || 25, 1), 100);
  const deliveries = await listDeliveries(webhookId, resolveOrgId(session), limit);
  return NextResponse.json({ deliveries });
}
