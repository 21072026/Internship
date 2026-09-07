import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { timingSafeEqual } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getEmailHealth } from '@/lib/emailHealth';
import { jobQueueHealth, retentionHealth } from '@/lib/jobs/health';
import { APP_VERSION, GIT_SHA } from '@/lib/version';
import { verifySmtpConnection } from '@/services/emailService';

// Public, unauthenticated liveness/readiness probe used by uptime monitors and
// the nightly stress test. Always cheap by default; pass ?db=1 to additionally
// verify database connectivity, ?smtp=1 to verify SMTP connectivity (no
// message sent — see #483, where SMTP silently failing had no visibility
// outside of a user reporting a missing email), or ?jobs=1 for the job-queue
// depth and dead-letter size (#1674 — those need a real HEALTH_TOKEN or an
// ADMIN session, never the fail-open branch). Never touches or mutates domain
// data.
//
// Liveness stays public — a monitor cannot log in. The *detail* (version, git
// sha, subsystem status, uptime) is a different matter: to an attacker it is a
// ready-made answer to "which CVEs apply to this deployment?" (#897). It is now
// released only to an admin session or a caller holding HEALTH_TOKEN.
export const dynamic = 'force-dynamic';

interface HealthAccess {
  /** May see the legacy detail block: version, sha, subsystem status, uptime. */
  detail: boolean;
  /**
   * Proved who they are — a matching `HEALTH_TOKEN` or an ADMIN session. This
   * is strictly stronger than `detail`, which is fail-open (see below).
   */
  verified: boolean;
}

/**
 * What this caller may see.
 *
 * `detail` is FAIL-OPEN: when `HEALTH_TOKEN` is unset the endpoint keeps its
 * old, fully public shape. That is deliberate rather than lazy — the production
 * deploy gate reads `sha` from this endpoint to decide whether the live
 * container has drifted (`deploy-prod.yml`, `infra/deploy-prod.sh`), and the
 * same is true of the preview gate. Defaulting to closed would blind all of
 * them the moment this merges, before anyone had a chance to configure the
 * token. Set `HEALTH_TOKEN` in the server env and on the probes, and the
 * endpoint closes.
 *
 * `verified` is FAIL-CLOSED, and it is what the job-queue counters require
 * (#1674). Nothing automated parses `jobs`, so those counters owe the deploy
 * gate nothing and must not inherit its bargain: on a server with no
 * `HEALTH_TOKEN` — which is every environment today — the fail-open branch
 * would otherwise hand queue depth, dead-letter size and three extra DB
 * queries to any anonymous caller who appended `?jobs=1`.
 *
 * Reading the session costs a JWT decode, so it is attempted only when it can
 * change the answer: the token gate is closed, or the caller asked for
 * something that needs proof. An anonymous liveness probe on an un-tokened
 * server does exactly what it did before.
 */
async function resolveAccess(request: Request, needsProof: boolean): Promise<HealthAccess> {
  const expected = process.env.HEALTH_TOKEN;

  if (expected) {
    const got = request.headers.get('x-health-token') || '';
    try {
      if (got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        return { detail: true, verified: true };
      }
    } catch {
      // fall through to the session check
    }
  }

  if (expected || needsProof) {
    const session = await getServerSession(authOptions);
    if (session?.user.role === 'ADMIN') return { detail: true, verified: true };
  }

  return { detail: !expected, verified: false };
}

export async function GET(request: Request) {
  const started = Date.now();
  const params = new URL(request.url).searchParams;
  const wantsDb = params.get('db') === '1';
  const wantsSmtp = params.get('smtp') === '1';
  // Queue counters are opt-in like the two probes above, and read only for a
  // caller who proved who they are (`access.verified`) — never on the fail-open
  // detail path. An anonymous /api/health issues no query for them, which is
  // what keeps the endpoint inside its k6 latency budget (docs/testing.md — it
  // already pays four EmailLog queries in the detail view).
  const wantsJobs = params.get('jobs') === '1';
  const access = await resolveAccess(request, wantsJobs);

  let db: 'ok' | 'error' | 'skipped' = 'skipped';
  if (wantsDb) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = 'ok';
    } catch {
      db = 'error';
    }
  }

  let smtp: 'ok' | 'error' | 'skipped' = 'skipped';
  let smtpError: string | undefined;
  if (wantsSmtp) {
    const result = await verifySmtpConnection();
    smtp = result.ok ? 'ok' : 'error';
    smtpError = result.error;
  }

  const healthy = db !== 'error' && smtp !== 'error';
  const status = healthy ? 'ok' : 'degraded';

  // An anonymous caller learns whether the app is up, and nothing else. The
  // status code still distinguishes healthy from degraded, which is all an
  // uptime monitor acts on.
  if (!access.detail) {
    return NextResponse.json(
      { status, timestamp: new Date().toISOString() },
      { status: healthy ? 200 : 503 }
    );
  }

  return NextResponse.json(
    {
      status,
      version: APP_VERSION,
      sha: GIT_SHA,
      db,
      smtp,
      ...(smtpError ? { smtpError } : {}),
      // Delivery health (#1190), derived from the EmailLog ledger — recipient
      // addresses are scrubbed in the lib, so nothing here carries PII.
      email: await getEmailHealth(),
      // Job-queue depth and dead-letter size (#1674) — counters only, no job
      // payload, name of a user or org. Requires `access.verified`, i.e. a real
      // HEALTH_TOKEN or an ADMIN session, so an un-tokened server does not leak
      // them on the fail-open detail path. Appended rather than inserted: the
      // deploy gate parses `sha` out of this response and every existing field
      // keeps its place.
      ...(wantsJobs && access.verified
        ? {
            jobs: await jobQueueHealth(),
            // The daily retention sweep's own receipt (#1678): when it last
            // ran, what it removed, whether an entry failed. Same gate and the
            // same discipline as `jobs` — counts and one age, never row
            // content — and it rides `?jobs=1` rather than adding a third
            // parameter, because "is the housekeeping running?" is one question.
            retention: await retentionHealth(),
          }
        : {}),
      uptimeMs: Math.round(process.uptime() * 1000),
      responseMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
