import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { requirePermission } from '@/lib/authz';
import { nudgeScope } from '@/lib/nudges/adminGuard';
import { loadRule, parseForOrg, ruleData } from '@/lib/nudges/admin';

type Ctx = { params: Promise<{ id: string }> };

// One nudge rule (#1686). Another org's id is 404 — never a 403 that confirms
// it exists. Enabling and disabling are audited (ActivityLog names the actor
// and the rule).
export async function GET(request: Request, { params }: Ctx) {
  const auth = await requirePermission('org.settings.write', { request });
  if ('error' in auth) return auth.error;
  const g = await nudgeScope(auth.session);
  if ('error' in g) return g.error;
  const rule = await loadRule((await params).id, g.orgId);
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ rule });
}

/** A full replace of the editable fields; `{ enabled }` alone switches a rule on or off. */
export async function PATCH(request: Request, { params }: Ctx) {
  const auth = await requirePermission('org.settings.write', { request });
  if ('error' in auth) return auth.error;
  const g = await nudgeScope(auth.session);
  if ('error' in g) return g.error;
  const id = (await params).id;
  const before = await loadRule(id, g.orgId);
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  // The toggle re-validates the stored rule too: a rule that no longer passes
  // the gate (an outcome stage, a removed trigger) cannot be switched on.
  const merged = {
    name: before.name, trigger: before.trigger, segment: before.segment, delayMinutes: before.delayMinutes,
    channel: before.channel, subjectEn: before.subjectEn, subjectTr: before.subjectTr, subjectDe: before.subjectDe,
    bodyEn: before.bodyEn, bodyTr: before.bodyTr, bodyDe: before.bodyDe,
    maxPerUserPer30Days: before.maxPerUserPer30Days, cooldownDays: before.cooldownDays, enabled: before.enabled,
    ...body,
  };
  const parsed = await parseForOrg(merged, g.orgId);
  if (!parsed.ok) return NextResponse.json({ error: 'Validation failed', code: parsed.code, issues: parsed.issues }, { status: 400 });
  const { count } = await prisma.nudgeRule.updateMany({ where: { id, orgId: g.orgId }, data: ruleData(parsed.rule) });
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (before.enabled !== parsed.rule.enabled) {
    await logActivity({
      action: parsed.rule.enabled ? 'nudge.enabled' : 'nudge.disabled',
      level: parsed.rule.enabled ? 'warning' : 'info',
      actorId: g.userId,
      actorEmail: g.email,
      targetType: 'nudgeRule',
      targetId: id,
      orgId: g.orgId,
      detail: parsed.rule.name,
      request,
    });
  }
  return NextResponse.json({ rule: await loadRule(id, g.orgId), missingLocales: parsed.missingLocales });
}

export async function DELETE(request: Request, { params }: Ctx) {
  const auth = await requirePermission('org.settings.write', { request });
  if ('error' in auth) return auth.error;
  const g = await nudgeScope(auth.session);
  if ('error' in g) return g.error;
  const id = (await params).id;
  const before = await loadRule(id, g.orgId);
  const { count } = await prisma.nudgeRule.deleteMany({ where: { id, orgId: g.orgId } });
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await logActivity({
    action: 'nudge.deleted',
    level: 'warning',
    actorId: g.userId,
    actorEmail: g.email,
    targetType: 'nudgeRule',
    targetId: id,
    orgId: g.orgId,
    detail: before?.name,
    request,
  });
  return NextResponse.json({ ok: true });
}
