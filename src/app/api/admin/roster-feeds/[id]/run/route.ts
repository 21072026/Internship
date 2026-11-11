import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { runFeed } from '@/lib/rosterFeedRunner';
import { runResponse } from '@/lib/rosterFeedAdmin';

// "Run now" and "Run now (dry run)" (#1967). The feed must be this org's — a
// foreign id answers 404 and runs nothing. The run takes the feed's claim, so
// a click while the waker (or another admin) is running it answers 409 rather
// than running it twice. On the demo's write blocklist with the rest of
// /api/admin/roster-feeds: it fetches with a stored credential.

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown };
  const dryRun = body?.dryRun === true;
  return withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    const feed = await prisma.rosterFeed.findFirst({ where: { id, orgId }, select: { id: true, name: true } });
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await logActivity({
      action: dryRun ? 'roster.dry_run' : 'roster.run',
      level: dryRun ? 'info' : 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'roster_feed',
      targetId: id,
      detail: feed.name.slice(0, 191),
      request,
    });
    return runResponse(await runFeed(id, { dryRun }));
  });
}
