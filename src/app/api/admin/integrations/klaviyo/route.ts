import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { logActivity } from '@/lib/activity';
import { klaviyoAdminGate } from '@/lib/klaviyoGate';
import { checkKlaviyoKey } from '@/lib/klaviyoRule';
import {
  deleteKlaviyoConnection,
  klaviyoConnectionView,
  saveKlaviyoKey,
  setKlaviyoEnabled,
  testKlaviyoKey,
} from '@/lib/klaviyoSync';

// The Klaviyo connection of the caller's organization (docs/integrations/klaviyo.md).
//
// THE KEY GOES IN, NEVER OUT. PUT takes a read-only private key, tests it with
// one read-only call, and stores it sealed; no response of any route returns
// it — GET shows its last four characters. The org is the session's
// (klaviyoAdminGate), never a parameter.

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    return NextResponse.json(await klaviyoConnectionView(g.orgId));
  });
}

const putSchema = z.object({ key: z.string().max(300) });

export async function PUT(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'empty' }, { status: 400 });
    const key = checkKlaviyoKey(parsed.data.key);
    if (!key.ok) return NextResponse.json({ error: 'Invalid key', code: key.code }, { status: 400 });
    // A key that cannot read profiles is refused before it is stored.
    const test = await testKlaviyoKey(key.key);
    if (!test.ok) return NextResponse.json({ error: 'Klaviyo refused the key', code: test.code }, { status: 400 });
    await saveKlaviyoKey(g.orgId, key.key, g.userId);
    await logActivity({
      action: 'integration.klaviyo.connected',
      level: 'warning',
      orgId: g.orgId,
      actorId: g.userId,
      targetType: 'ExternalConnection',
      detail: 'key saved',
      request,
    });
    return NextResponse.json(await klaviyoConnectionView(g.orgId));
  });
}

const patchSchema = z.object({ enabled: z.boolean() });

export async function PATCH(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    if (!(await setKlaviyoEnabled(g.orgId, parsed.data.enabled))) {
      return NextResponse.json({ error: 'Not connected', code: 'not_connected' }, { status: 404 });
    }
    await logActivity({
      action: parsed.data.enabled ? 'integration.klaviyo.resumed' : 'integration.klaviyo.paused',
      orgId: g.orgId,
      actorId: g.userId,
      targetType: 'ExternalConnection',
      request,
    });
    return NextResponse.json(await klaviyoConnectionView(g.orgId));
  });
}

export async function DELETE(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    if (await deleteKlaviyoConnection(g.orgId)) {
      await logActivity({
        action: 'integration.klaviyo.disconnected',
        level: 'warning',
        orgId: g.orgId,
        actorId: g.userId,
        targetType: 'ExternalConnection',
        request,
      });
    }
    return NextResponse.json(await klaviyoConnectionView(g.orgId));
  });
}
