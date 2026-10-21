import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { relayOnce } from '@/lib/events/relay';
import { logger } from '@/lib/logger';
import { withRequestScope } from '@/lib/requestContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST — one pass of the domain-event outbox relay (#1680, src/lib/events/relay.ts).
// Ticked every 30 s by src/instrumentation.ts on every replica; a publish also
// kicks a pass in-process (kickRelay), so this tick is the guarantee, not the
// latency.
//
// THE CREDENTIAL is the mail drain's: CRON_SECRET in `x-cron-secret`, or the
// per-process EVENTS_RELAY_SECRET the instrumentation hook mints where
// CRON_SECRET is unset; compared in constant time; neither set answers 503.
// NO LEASE: rows are claimed with SKIP LOCKED, so every replica may relay.
// EVENTS_RELAY_ENABLED=0 (the deploy canary) answers 200 { skipped }.
export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

function secretOk(got: string, expected: string): boolean {
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function handlePost(request: Request) {
  const expected = process.env.CRON_SECRET || process.env.EVENTS_RELAY_SECRET;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (!secretOk(request.headers.get('x-cron-secret') || '', expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.EVENTS_RELAY_ENABLED === '0') return NextResponse.json({ ok: true, skipped: 'disabled' });

  try {
    const summary = await relayOnce();
    // Quiet when idle — this runs every thirty seconds.
    if (summary.relayed > 0 || summary.failed > 0) logger.info('domain_event.relay', { ...summary });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    logger.error('domain_event.relay_tick_failed', { error: e instanceof Error ? e.name : 'unknown' });
    return NextResponse.json({ error: 'Relay failed' }, { status: 502 });
  }
}
