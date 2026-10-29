import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { integrationsLocked } from '@/lib/integrationsGate';
import { assertDrainUrl, DrainUrlError } from '@/lib/auditDrain';
import { AUDIT_DRAIN_FORMATS, AUDIT_DRAIN_URL_MAX } from '@/lib/auditDrainRule';
import { SsrfBlockedError } from '@/lib/ssrfGuard';

// The audit stream's receivers (#2012): where a tenant's AuditLog rows are
// POSTed to. Same shape as ../webhooks: the secret is returned ONCE at
// creation (and by rotate-secret), never listed; every read and write is
// scoped by the caller's org in the `where`, because this route binds no tenant
// context and the middleware is advisory until MT_ENFORCE_ISOLATION.
//
// The org a drain belongs to is `settingsOrgOf(session)` — the default org for
// an org-less admin token, never null — because AuditDrain.orgId is REQUIRED:
// a drain whose tenant is unknown would stream nobody's rows, or everybody's.

const LIST_SELECT = {
  id: true,
  url: true,
  format: true,
  active: true,
  cursorAt: true,
  lastOkAt: true,
  lastError: true,
  failures: true,
  nextAttemptAt: true,
  createdAt: true,
} as const;

function urlRefusal(e: unknown): NextResponse {
  if (e instanceof DrainUrlError) {
    return NextResponse.json({ error: 'Invalid receiver URL', code: e.reason }, { status: 400 });
  }
  if (e instanceof SsrfBlockedError) {
    return NextResponse.json({ error: e.message, code: 'blocked' }, { status: 400 });
  }
  return NextResponse.json({ error: 'Invalid receiver URL', code: 'invalid' }, { status: 400 });
}

export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const orgId = await settingsOrgOf(session);
  const [drains, pending] = await Promise.all([
    prisma.auditDrain.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, select: LIST_SELECT }),
    // How many of this tenant's rows exist at all — the console shows "N rows
    // behind" per drain from this and the drain's cursor, without a per-drain
    // count query on a table that grows forever.
    prisma.auditLog.count({ where: { orgId } }),
  ]);
  return NextResponse.json({ drains, formats: AUDIT_DRAIN_FORMATS, auditRows: pending });
}

const createSchema = z.object({
  url: z.string().min(1).max(AUDIT_DRAIN_URL_MAX),
  format: z.enum(AUDIT_DRAIN_FORMATS).default('json_lines'),
});

export async function POST(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // Streaming the audit trail out is an integration, and the paid feature
  // (#1744) — the same gate as a webhook subscription.
  const locked = await integrationsLocked(session);
  if (locked) return locked;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  let url: string;
  try {
    url = await assertDrainUrl(parsed.data.url);
  } catch (e) {
    return urlRefusal(e);
  }
  const orgId = await settingsOrgOf(session);
  const secret = randomBytes(24).toString('hex');
  const drain = await prisma.auditDrain.create({
    data: { orgId, url, format: parsed.data.format, secret },
    select: LIST_SELECT,
  });
  await logActivity({
    action: 'audit_drain.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'audit_drain',
    targetId: drain.id,
    detail: drain.url,
    request,
  });
  // The secret, once. Nothing reads it back out again.
  return NextResponse.json({ drain, secret }, { status: 201 });
}

// Editing never touches the secret (rotate-secret is its own deliberate act)
// and never touches the cursor: a re-pointed drain continues from where the
// old receiver left off, which is what "the stream" means. Resuming a paused
// drain clears the failure bookkeeping so it is tried on the next tick.
const patchSchema = z.object({
  url: z.string().min(1).max(AUDIT_DRAIN_URL_MAX).optional(),
  format: z.enum(AUDIT_DRAIN_FORMATS).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const id = new URL(request.url).searchParams.get('id') || '';
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  // Re-pointing or switching a drain back ON is setting up an integration
  // (#1744); switching one OFF must always work.
  if (parsed.data.url !== undefined || parsed.data.format !== undefined || parsed.data.active === true) {
    const locked = await integrationsLocked(session);
    if (locked) return locked;
  }
  const data: { url?: string; format?: string; active?: boolean; failures?: number; nextAttemptAt?: null; lastError?: null } = {};
  if (parsed.data.url !== undefined) {
    try {
      data.url = await assertDrainUrl(parsed.data.url);
    } catch (e) {
      return urlRefusal(e);
    }
  }
  if (parsed.data.format !== undefined) data.format = parsed.data.format;
  if (parsed.data.active !== undefined) {
    data.active = parsed.data.active;
    if (parsed.data.active) {
      data.failures = 0;
      data.nextAttemptAt = null;
      data.lastError = null;
    }
  }
  const orgId = await settingsOrgOf(session);
  const { count } = await prisma.auditDrain.updateMany({ where: { id, orgId }, data });
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await logActivity({
    action: 'audit_drain.updated',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'audit_drain',
    targetId: id,
    detail: data.url ?? (parsed.data.active === false ? 'paused' : parsed.data.active ? 'resumed' : parsed.data.format),
    request,
  });
  const drain = await prisma.auditDrain.findFirst({ where: { id, orgId }, select: LIST_SELECT });
  return NextResponse.json({ drain });
}

export async function DELETE(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const id = new URL(request.url).searchParams.get('id') || '';
  const orgId = await settingsOrgOf(session);
  const { count } = await prisma.auditDrain.deleteMany({ where: { id, orgId } });
  if (count) {
    await logActivity({
      action: 'audit_drain.deleted',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'audit_drain',
      targetId: id,
      request,
    });
  }
  return NextResponse.json({ ok: true });
}
