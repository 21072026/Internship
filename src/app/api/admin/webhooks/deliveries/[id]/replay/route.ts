import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { replayDelivery } from '@/lib/webhookDelivery';

// THE replay route (#1695): re-send the event of one recorded delivery to its
// webhook, as a new queued delivery with the same X-Delivery-Id. ADMIN only,
// checked here; another tenant's delivery is 404, never 403 (the id stays
// unconfirmed). Demo-blocked with the rest of /api/admin/webhooks.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  const result = await replayDelivery(id, resolveOrgId(session));
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'event_gone' ? 410 : 409;
    return NextResponse.json({ error: result.reason }, { status });
  }
  await logActivity({
    action: 'webhook.delivery_replayed',
    level: 'info',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'webhookDelivery',
    targetId: id,
    request,
  });
  return NextResponse.json({ queued: result.queued }, { status: 202 });
}
