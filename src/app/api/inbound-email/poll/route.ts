import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { pollInboundMailbox, bridgeConfig } from '@/services/inboundMailBridge';
import { logger } from '@/lib/logger';
import { holdsLease, leaseTtlMs, replicaId, IMAP_BRIDGE_LEASE } from '@/lib/jobs/lease';

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
//
// EXACTLY ONE POLLER, ACROSS EVERY REPLICA (#1701). Two processes draining one
// mailbox race over the `\Seen` flag: both fetch the same unseen message, so a
// reply is imported twice or marked seen by the loser and never imported at
// all. Until now the only thing preventing that was "the IMAP credentials exist
// only in production, and production is one container" — which is not a
// guarantee, it is a coincidence, and #1701 ends it by running two identically
// configured replicas.
//
// So the poll takes the `'imap-bridge'` lease first, and a replica that does not
// hold it returns 200 and does nothing. 200, not 409: the caller is
// `src/instrumentation.ts`'s timer, which logs a non-OK status as an error, and
// losing the lease is the NORMAL state of exactly one of the two replicas. A
// quiet skip is the correct outcome, and `skipped` in the body is there for a
// human running the endpoint by hand.
//
// The lease gate deliberately sits AFTER the secret check (an unauthenticated
// caller learns nothing about the lease) and BEFORE `pollInboundMailbox()` —
// the point is to not open the IMAP connection at all.
export async function POST(request: Request) {
  const expected = process.env.INBOUND_SECRET;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });

  const got = request.headers.get('x-inbound-secret') || '';
  const ok = got.length === expected.length
    && (() => { try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; } })();
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!bridgeConfig()) return NextResponse.json({ error: 'Mail bridge not configured' }, { status: 503 });

  // The TTL is derived from the poll interval so a slow mailbox cannot make the
  // holder drop its own lease mid-fetch (three intervals, floored at a minute —
  // src/lib/jobs/lease.ts). Renewal is this very call: the tick IS the heartbeat.
  const pollMs = Math.max(30, Number(process.env.INBOUND_IMAP_POLL_SECONDS || 60)) * 1000;
  const holder = replicaId();
  if (!(await holdsLease(IMAP_BRIDGE_LEASE, holder, leaseTtlMs(pollMs)))) {
    return NextResponse.json({ ok: true, skipped: 'not-lease-holder', holder });
  }

  try {
    const summary = await pollInboundMailbox();
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    logger.error('Mail bridge poll failed', { error: String(e) });
    return NextResponse.json({ error: 'Poll failed' }, { status: 502 });
  }
}
