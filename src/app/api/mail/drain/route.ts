import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { drainOnce } from '@/lib/mailOutbox';
import { mailDrainDeps } from '@/services/emailService';
import { evaluateMailOps } from '@/lib/mailOpsAlert';
import { mailPolicy } from '@/lib/mailWorkerRule';
import { logger } from '@/lib/logger';
import { withRequestScope } from '@/lib/requestContext';

// SMTP needs real sockets, and Prisma — keep this handler off the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST — one tick of the mail outbox drain (#2944, src/lib/mailOutbox.ts).
// Ticked every 5 s by src/instrumentation.ts on every replica; also safe to
// call by hand to flush the queue now.
//
// THE CREDENTIAL. A boot timer has no session, so a shared secret in the
// `x-cron-secret` header stands in for one, compared in constant time:
// CRON_SECRET where it is set, otherwise MAIL_DRAIN_SECRET — which the
// instrumentation hook mints at random, in this very process, on an environment
// without CRON_SECRET (a topic environment), so the drain runs there too and
// nobody outside the process knows the value. Neither set: 503, never open.
//
// NO LEASE, ON PURPOSE. Every replica drains; rows are claimed with SKIP LOCKED,
// so two drains take disjoint rows and more replicas only drain faster. The pace
// is the shared budget's. A lease here would be the second election mechanism
// CLAUDE.md forbids, and would make one replica's death stop all mail.
//
// MAIL_WORKER_ENABLED=0 (the deploy canary, which shares production's database)
// answers 200 { skipped } and touches nothing; so does an environment with no
// SMTP configured, where every queued row would only fail.
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
  const expected = process.env.CRON_SECRET || process.env.MAIL_DRAIN_SECRET;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (!secretOk(request.headers.get('x-cron-secret') || '', expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!mailPolicy(process.env).workerEnabled) return NextResponse.json({ ok: true, skipped: 'disabled' });

  try {
    const summary = await drainOnce({ deps: mailDrainDeps() });
    // Quiet when idle — this runs every five seconds.
    if (summary.claimed > 0 || summary.reaped > 0) logger.info('mail_outbox.drain', { ...summary });
    // The operator alerts (#2953): critical mail waiting, a long relay
    // outage, rejected credentials. Cheap when nothing is wrong — the database
    // half runs at most once a minute per process — and never fails the tick.
    await evaluateMailOps({ authRejected: summary.authRejected });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    logger.error('mail_outbox.drain_failed', { error: e instanceof Error ? e.name : 'unknown' });
    return NextResponse.json({ error: 'Drain failed' }, { status: 502 });
  }
}
