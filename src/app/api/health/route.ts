import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { timingSafeEqual } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { APP_VERSION, GIT_SHA } from '@/lib/version';
import { verifySmtpConnection } from '@/services/emailService';

// Public, unauthenticated liveness/readiness probe used by uptime monitors and
// the nightly stress test. Always cheap by default; pass ?db=1 to additionally
// verify database connectivity, or ?smtp=1 to verify SMTP connectivity (no
// message sent — see #483, where SMTP silently failing had no visibility
// outside of a user reporting a missing email). Never touches or mutates
// domain data.
//
// Liveness stays public — a monitor cannot log in. The *detail* (version, git
// sha, subsystem status, uptime) is a different matter: to an attacker it is a
// ready-made answer to "which CVEs apply to this deployment?" (#897). It is now
// released only to an admin session or a caller holding HEALTH_TOKEN.
export const dynamic = 'force-dynamic';

/**
 * Whether this caller may see the detailed fields.
 *
 * When `HEALTH_TOKEN` is unset the endpoint keeps its old, fully public shape.
 * That is deliberate rather than lazy: the production deploy gate reads `sha`
 * from this endpoint to decide whether the live container has drifted
 * (`deploy-prod.yml`, `infra/deploy-prod.sh`), and the same is true of the
 * preview gate. Defaulting to closed would blind all of them the moment this
 * merges, before anyone had a chance to configure the token. Set `HEALTH_TOKEN`
 * in the server env and on the probes, and the endpoint closes.
 */
async function maySeeDetail(request: Request): Promise<boolean> {
  const expected = process.env.HEALTH_TOKEN;
  if (!expected) return true;

  const got = request.headers.get('x-health-token') || '';
  try {
    if (got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      return true;
    }
  } catch {
    // fall through to the session check
  }

  const session = await getServerSession(authOptions);
  return session?.user.role === 'ADMIN';
}

export async function GET(request: Request) {
  const started = Date.now();
  const params = new URL(request.url).searchParams;
  const wantsDb = params.get('db') === '1';
  const wantsSmtp = params.get('smtp') === '1';

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
  if (!(await maySeeDetail(request))) {
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
      uptimeMs: Math.round(process.uptime() * 1000),
      responseMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
