import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { feedWriteData, loadPublicFeed, prepareFeedWrite } from '@/lib/rosterFeedAdmin';

// One roster feed (#1964). Another org's id answers 404 on every verb — the
// same answer as an id that does not exist, so the route confirms nothing.

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const feed = await loadPublicFeed(id, await settingsOrgOf(session));
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ feed });
  });
}

export async function PATCH(request: Request, { params }: Ctx) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    const current = await loadPublicFeed(id, orgId);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const write = await prepareFeedWrite(body as Record<string, unknown>, current as unknown as Record<string, unknown>);
    if (!write.ok) return NextResponse.json({ error: 'Validation failed', errors: write.errors }, { status: 400 });
    const { count } = await prisma.rosterFeed.updateMany({
      where: { id, orgId },
      data: {
        ...feedWriteData(write.value, write.secretEnc),
        // Switching a paused feed back on is the admin saying the cause is
        // fixed (#1967): the streak and the reason go with the pause.
        ...(write.value.enabled && !current.enabled ? { pausedReason: null, consecutiveFailures: 0 } : {}),
      },
    });
    if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await logActivity({
      action: 'roster_feed.updated',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'roster_feed',
      targetId: id,
      // Which kind of change, never the value: the secret is the one field
      // whose edit an auditor needs to see and nobody may read.
      detail:
        write.secretEnc === undefined ? write.value.name : `${write.value.name} (secret ${write.secretEnc ? 'replaced' : 'cleared'})`,
      request,
    });
    return NextResponse.json({ feed: await loadPublicFeed(id, orgId) });
  });
}

export async function DELETE(request: Request, { params }: Ctx) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    // Runs and their row results cascade with the feed.
    const { count } = await prisma.rosterFeed.deleteMany({ where: { id, orgId } });
    if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await logActivity({
      action: 'roster_feed.deleted',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'roster_feed',
      targetId: id,
      request,
    });
    return NextResponse.json({ ok: true });
  });
}
