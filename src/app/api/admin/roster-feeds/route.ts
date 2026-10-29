import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { ROSTER_KEY_FIELDS, ROSTER_MAPPABLE_FIELDS, ROSTER_TRANSPORTS } from '@/lib/rosterFeed';
import { feedWriteData, listPublicFeeds, loadPublicFeed, prepareFeedWrite } from '@/lib/rosterFeedAdmin';

// Roster feeds (#1964): where a tenant's HR export comes from, how its columns
// map to ours and when it runs. ADMIN only, scoped by the caller's org in every
// `where` on top of the tenant scope. The feed's secret goes in sealed and
// never comes back out — the answer says `secretSet` and nothing more. On the
// public demo's write blocklist (src/lib/demoMode.ts): it stores a real remote
// credential.

export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const feeds = await listPublicFeeds(await settingsOrgOf(session));
    return NextResponse.json({
      feeds,
      transports: ROSTER_TRANSPORTS,
      keyFields: ROSTER_KEY_FIELDS,
      fields: ROSTER_MAPPABLE_FIELDS,
    });
  });
}

export async function POST(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(session, async () => {
    const write = await prepareFeedWrite(body as Record<string, unknown>);
    if (!write.ok) return NextResponse.json({ error: 'Validation failed', errors: write.errors }, { status: 400 });
    const orgId = await settingsOrgOf(session);
    const created = await prisma.rosterFeed.create({
      data: { ...feedWriteData(write.value, write.secretEnc), orgId },
      select: { id: true, name: true },
    });
    await logActivity({
      action: 'roster_feed.created',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'roster_feed',
      targetId: created.id,
      detail: created.name,
      request,
    });
    return NextResponse.json({ feed: await loadPublicFeed(created.id, orgId) }, { status: 201 });
  });
}
