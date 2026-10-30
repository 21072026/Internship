import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withRequestScope } from '@/lib/requestContext';
import { klaviyoAdminGate } from '@/lib/klaviyoGate';
import { KLAVIYO_PROVIDER } from '@/lib/klaviyoRule';
import { klaviyoConnectionView, runKlaviyoSync } from '@/lib/klaviyoSync';
import { runKlaviyoResources } from '@/lib/klaviyoResources';

// "Sync now": one bounded run of the caller's own connection, the same run the
// 15-minute schedule makes (KLAVIYO_PAGES_PER_MANUAL_RUN pages; a large first
// import continues on the schedule). A run already in progress answers 409.
// `{ "scope": "all" }` also runs every other resource (lists, segments and
// their members, metrics, events, campaigns, flows — RESOURCE_PAGES_PER_MANUAL_RUN
// pages, ignoring their schedule and backoff; the campaign
// statistics keep their daily schedule, the provider allows 225 a day).

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('org.integrations.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const row = await prisma.externalConnection.findFirst({
      where: { orgId: g.orgId, provider: KLAVIYO_PROVIDER },
      select: { id: true, enabled: true },
    });
    if (!row) return NextResponse.json({ error: 'Not connected', code: 'not_connected' }, { status: 404 });
    if (!row.enabled) return NextResponse.json({ error: 'Sync is paused', code: 'disabled' }, { status: 409 });
    const body = (await request.json().catch(() => null)) as { scope?: unknown } | null;
    const all = body?.scope === 'all';
    const result = await runKlaviyoSync(row.id, { trigger: 'manual' });
    if (result.outcome === 'busy') return NextResponse.json({ error: 'A sync is already running', code: 'busy' }, { status: 409 });
    const resources = all ? await runKlaviyoResources(row.id, { trigger: 'manual' }) : null;
    return NextResponse.json({
      resourcesOutcome: resources?.outcome ?? null,
      outcome: result.outcome,
      code: result.code ?? null,
      pages: result.pages,
      counts: result.counts,
      initial: result.initial,
      ...(await klaviyoConnectionView(g.orgId)),
    });
  });
}
