import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { pollInboundMailbox, bridgeConfig } from '@/services/inboundMailBridge';
import { logger } from '@/lib/logger';

// IMAP needs real sockets — keep this handler off the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST — drain one batch from the reply mailbox. Ticked every
// INBOUND_IMAP_POLL_SECONDS by src/instrumentation.ts; also safe to call by hand
// (or from a system cron) to flush the mailbox immediately.
//
// Unlike /api/inbound-email, the shared secret is mandatory here: this endpoint
// makes the server open an outbound IMAP connection, so it must never be
// callable by an anonymous request.
export async function POST(request: Request) {
  const expected = process.env.INBOUND_SECRET;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });

  const got = request.headers.get('x-inbound-secret') || '';
  const ok = got.length === expected.length
    && (() => { try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; } })();
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!bridgeConfig()) return NextResponse.json({ error: 'Mail bridge not configured' }, { status: 503 });

  try {
    const summary = await pollInboundMailbox();
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    logger.error('Mail bridge poll failed', { error: String(e) });
    return NextResponse.json({ error: 'Poll failed' }, { status: 502 });
  }
}
