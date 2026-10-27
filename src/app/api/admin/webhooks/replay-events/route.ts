import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { replayRecentEvents } from '@/lib/webhookDelivery';
import { clampReplayCount, WEBHOOK_REPLAY_MAX } from '@/lib/webhookDeliveryRule';

// "Replay the last N events" for one webhook (#1695): re-enqueues the hook's
// most recent subscribed events from the DomainEvent record, oldest first.
// N is capped at WEBHOOK_REPLAY_MAX. ADMIN only, org-scoped, demo-blocked.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const body = (await request.json().catch(() => ({}))) as { count?: unknown };
  const count = clampReplayCount(body.count);
  if (!id || count === null) {
    return NextResponse.json({ error: `count must be a whole number from 1 to ${WEBHOOK_REPLAY_MAX}` }, { status: 400 });
  }
  const result = await replayRecentEvents(id, resolveOrgId(session), count);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 409 });
  await logActivity({
    action: 'webhook.events_replayed',
    level: 'info',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'webhook',
    targetId: id,
    detail: `${result.queued} event(s)`,
    request,
  });
  return NextResponse.json({ queued: result.queued }, { status: 202 });
}
