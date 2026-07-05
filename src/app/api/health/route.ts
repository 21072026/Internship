import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { APP_VERSION, GIT_SHA } from '@/lib/version';
import { verifySmtpConnection } from '@/services/emailService';

// Public, unauthenticated liveness/readiness probe used by uptime monitors and
// the nightly stress test. Always cheap by default; pass ?db=1 to additionally
// verify database connectivity, or ?smtp=1 to verify SMTP connectivity (no
// message sent — see #483, where SMTP silently failing had no visibility
// outside of a user reporting a missing email). Never touches or mutates
// domain data.
export const dynamic = 'force-dynamic';

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
  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
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
