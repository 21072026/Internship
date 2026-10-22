import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withRequestScope } from '@/lib/requestContext';
import { klaviyoAdminGate } from '@/lib/klaviyoGate';
import { KLAVIYO_PROVIDER } from '@/lib/klaviyoRule';
import { klaviyoConnectionView, runKlaviyoSync } from '@/lib/klaviyoSync';

// "Sync now": one bounded run of the caller's own connection, the same run the
// 15-minute schedule makes (KLAVIYO_PAGES_PER_MANUAL_RUN pages; a large first
// import continues on the schedule). A run already in progress answers 409.

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const row = await prisma.externalConnection.findFirst({
      where: { orgId: g.orgId, provider: KLAVIYO_PROVIDER },
      select: { id: true, enabled: true },
    });
    if (!row) return NextResponse.json({ error: 'Not connected', code: 'not_connected' }, { status: 404 });
    if (!row.enabled) return NextResponse.json({ error: 'Sync is paused', code: 'disabled' }, { status: 409 });
    const result = await runKlaviyoSync(row.id, { trigger: 'manual' });
    if (result.outcome === 'busy') return NextResponse.json({ error: 'A sync is already running', code: 'busy' }, { status: 409 });
    return NextResponse.json({
      outcome: result.outcome,
      code: result.code ?? null,
      pages: result.pages,
      counts: result.counts,
      initial: result.initial,
      ...(await klaviyoConnectionView(g.orgId)),
    });
  });
}
