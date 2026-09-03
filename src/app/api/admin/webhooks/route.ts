import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const webhooks = await prisma.webhook.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, url: true, events: true, active: true, createdAt: true },
  });
  return NextResponse.json({ webhooks, eventTypes: WEBHOOK_EVENTS });
}

const schema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  // The URL is called from the server's network position, so a schema check is
  // not enough — 127.0.0.1 and the cloud metadata address both pass `.url()`.
  try {
    await assertPublicHttpsUrl(parsed.data.url);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof SsrfBlockedError ? e.message : 'Invalid webhook URL' },
      { status: 400 }
    );
  }

  const secret = randomBytes(24).toString('hex');
  const webhook = await prisma.webhook.create({ data: { url: parsed.data.url, events: parsed.data.events, secret } });
  await logActivity({
    action: 'webhook.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'webhook',
    targetId: webhook.id,
    detail: webhook.url,
    request,
  });
  // Return the secret once so the receiver can verify signatures.
  return NextResponse.json({ webhook: { id: webhook.id, url: webhook.url, events: webhook.events }, secret }, { status: 201 });
}

// Editing a subscription deliberately never touches `secret`: the integrator
// has already deployed verification code against it, and rotation is its own
// explicit endpoint (webhooks/rotate-secret).
const patchSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const parsed = patchSchema.safeParse(await request.json());
  // Every field is optional, so an empty body parses — reject it rather than
  // writing nothing and logging a change that did not happen.
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  if (parsed.data.url) {
    // Same guard as create — an edit is just as much a server-side fetch target.
    try {
      await assertPublicHttpsUrl(parsed.data.url);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof SsrfBlockedError ? e.message : 'Invalid webhook URL' },
        { status: 400 }
      );
    }
  }

  const data: { url?: string; events?: string[]; active?: boolean } = {};
  if (parsed.data.url !== undefined) data.url = parsed.data.url;
  if (parsed.data.events !== undefined) data.events = [...parsed.data.events];
  if (parsed.data.active !== undefined) data.active = parsed.data.active;
  const { count } = await prisma.webhook.updateMany({ where: { id }, data });
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await logActivity({
    action: 'webhook.updated',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'webhook',
    targetId: id,
    detail: parsed.data.url ?? (parsed.data.active === false ? 'paused' : parsed.data.active ? 'resumed' : undefined),
    request,
  });
  const webhook = await prisma.webhook.findUnique({
    where: { id },
    select: { id: true, url: true, events: true, active: true },
  });
  return NextResponse.json({ webhook });
}

export async function DELETE(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const { count } = await prisma.webhook.deleteMany({ where: { id } });
  if (count) {
    await logActivity({
      action: 'webhook.deleted',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'webhook',
      targetId: id,
      request,
    });
  }
  return NextResponse.json({ ok: true });
}
