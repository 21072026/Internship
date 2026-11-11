import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import type { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { resolveOrgId } from '@/lib/orgScope';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { emit } from '@/lib/events/emit';
import { redactedDiff, WEBHOOK_DIFF_SPEC } from '@/lib/events/diff';
import { z } from 'zod';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';
import { integrationsLocked } from '@/lib/integrationsGate';

export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const webhooks = await prisma.webhook.findMany({
    // Scoped to the acting tenant (#2357): the middleware is advisory until
    // MT_ENFORCE_ISOLATION, so a tenant admin must not list another tenant's
    // endpoints (their URLs and which events they subscribe to).
    where: { orgId: resolveOrgId(session) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, url: true, events: true, active: true, createdAt: true,
      // Delivery health (#1695): the integrations page shows an auto-disabled
      // hook with its reason and a re-enable button.
      consecutiveFailures: true, lastSuccessAt: true, disabledAt: true, disabledReason: true,
      // A company's self-served hook (#2006): the admin sees whose it is.
      company: { select: { id: true, name: true } },
      // …or a source's (`ownerSource`; `source` is the hook's origin column).
      ownerSource: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json({ webhooks, eventTypes: WEBHOOK_EVENTS });
}

const schema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

export async function POST(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // A new subscription is the paid feature (#1744).
  const locked = await integrationsLocked(session);
  if (locked) return locked;
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
  const webhook = await prisma.webhook.create({ data: { url: parsed.data.url, events: parsed.data.events, secret, orgId: resolveOrgId(session) } });
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
  await emit(
    'webhook.registered',
    {
      webhookId: webhook.id,
      events: [...parsed.data.events],
      changes: redactedDiff(null, { url: webhook.url, events: webhook.events, active: webhook.active }, WEBHOOK_DIFF_SPEC),
    },
    { orgId: webhook.orgId, actor: { id: session.user.id, type: 'user' } },
  );
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
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const id = new URL(request.url).searchParams.get('id') || '';
  const parsed = patchSchema.safeParse(await request.json());
  // Every field is optional, so an empty body parses — reject it rather than
  // writing nothing and logging a change that did not happen.
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  // Re-pointing, re-scoping or switching a webhook back on is setting up an
  // integration (#1744); switching one OFF must always work.
  if (parsed.data.url !== undefined || parsed.data.events !== undefined || parsed.data.active === true) {
    const locked = await integrationsLocked(session);
    if (locked) return locked;
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

  const data: Prisma.WebhookUpdateManyMutationInput = {};
  if (parsed.data.url !== undefined) data.url = parsed.data.url;
  if (parsed.data.events !== undefined) data.events = [...parsed.data.events];
  if (parsed.data.active !== undefined) data.active = parsed.data.active;
  // Switching a hook on is also the explicit re-enable of one the relay
  // auto-disabled (#1695): the failure streak starts over.
  if (parsed.data.active === true) {
    Object.assign(data, { disabledAt: null, disabledReason: null, consecutiveFailures: 0, failingSince: null });
  }
  // Read before the write: a diff computed from the response has no "before" (#1699).
  const before = await prisma.webhook.findFirst({
    where: { id, orgId: resolveOrgId(session) },
    select: { url: true, events: true, active: true, orgId: true },
  });
  const { count } = await prisma.webhook.updateMany({ where: { id, orgId: resolveOrgId(session) }, data });
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
  const webhook = await prisma.webhook.findFirst({
    where: { id, orgId: resolveOrgId(session) },
    select: { id: true, url: true, events: true, active: true },
  });
  const changes = before && webhook
    ? redactedDiff({ url: before.url, events: before.events, active: before.active }, { url: webhook.url, events: webhook.events, active: webhook.active }, WEBHOOK_DIFF_SPEC)
    : [];
  if (changes.length) {
    await emit('webhook.updated', { webhookId: id, changes }, { orgId: before?.orgId ?? null, actor: { id: session.user.id, type: 'user' } });
  }
  return NextResponse.json({ webhook });
}

export async function DELETE(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const id = new URL(request.url).searchParams.get('id') || '';
  const before = await prisma.webhook.findFirst({
    where: { id, orgId: resolveOrgId(session) },
    select: { url: true, events: true, active: true, orgId: true },
  });
  const { count } = await prisma.webhook.deleteMany({ where: { id, orgId: resolveOrgId(session) } });
  if (count && before) {
    await emit(
      'webhook.deleted',
      { webhookId: id, changes: redactedDiff({ url: before.url, events: before.events, active: before.active }, null, WEBHOOK_DIFF_SPEC) },
      { orgId: before.orgId, actor: { id: session.user.id, type: 'user' } },
    );
  }
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
