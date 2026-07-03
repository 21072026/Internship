import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { APP_VERSION, GIT_SHA } from '@/lib/version';

// Public, unauthenticated liveness/readiness probe used by uptime monitors and
// the nightly stress test. Always cheap by default; pass ?db=1 to additionally
// verify database connectivity. Never touches or mutates domain data.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const started = Date.now();
  const wantsDb = new URL(request.url).searchParams.get('db') === '1';

  let db: 'ok' | 'error' | 'skipped' = 'skipped';
  if (wantsDb) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = 'ok';
    } catch {
      db = 'error';
    }
  }

  const healthy = db !== 'error';
  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      version: APP_VERSION,
      sha: GIT_SHA,
      db,
      uptimeMs: Math.round(process.uptime() * 1000),
      responseMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
