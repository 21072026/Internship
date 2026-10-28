import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { findOrgRule, ruleSelect, serializeRule, validateRuleForOrg } from '@/lib/automation/admin';

// One stage automation rule (#1704). Another org's id is a 404 — never a 403
// that would confirm it exists. docs/automation-rules.md.

type Ctx = { params: Promise<{ id: string }> };

// PATCH — any subset of the rule. The merged rule is re-validated whole. A
// change to what the rule DOES (trigger, stage, conditions, actions, delay)
// clears `lastSimulatedAt`; switching it ON needs a dry run since the last such
// change (`simulate_first`).
export async function PATCH(request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { id } = await params;
  const orgId = await settingsOrgOf(gate.session);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(gate.session, async () => {
    const current = await findOrgRule(orgId, id);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const base = serializeRule(current);
    const merged = {
      name: body.name ?? base.name,
      trigger: body.trigger ?? base.trigger,
      stageKey: body.stageKey ?? base.stageKey,
      conditions: body.conditions ?? base.conditions,
      actions: body.actions ?? base.actions,
      delayMinutes: body.delayMinutes ?? base.delayMinutes,
      enabled: body.enabled ?? base.enabled,
    };
    const checked = await validateRuleForOrg(orgId, merged);
    if (!checked.ok) return NextResponse.json({ error: 'Validation failed', code: checked.code, issues: checked.issues }, { status: 400 });
    const r = checked.rule;
    const logicChanged = ['trigger', 'stageKey', 'conditions', 'actions', 'delayMinutes'].some((k) => k in body);
    const simulatedAt = logicChanged ? null : current.lastSimulatedAt;
    if (r.enabled && !current.enabled && !simulatedAt) {
      return NextResponse.json({ error: 'Run a dry run before switching this rule on', code: 'simulate_first' }, { status: 409 });
    }
    const rule = await prisma.automationRule.update({
      where: { id: current.id },
      data: {
        name: r.name,
        trigger: r.trigger,
        stageKey: r.stageKey,
        conditions: r.conditions,
        actions: r.actions,
        delayMinutes: r.delayMinutes,
        enabled: r.enabled,
        lastSimulatedAt: simulatedAt,
      },
      select: ruleSelect,
    });
    if (r.enabled !== current.enabled) {
      await logActivity({
        action: r.enabled ? 'automation.rule_enabled' : 'automation.rule_disabled',
        actorId: gate.session.user.id,
        targetType: 'AutomationRule',
        targetId: rule.id,
        request,
      });
    }
    return NextResponse.json({ rule: serializeRule(rule) });
  });
}

// DELETE — the rule and its run log (cascade). A delayed run waiting on the
// queue finds no rule and settles SKIPPED (rule_disabled).
export async function DELETE(request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { id } = await params;
  const orgId = await settingsOrgOf(gate.session);
  return withTenantScope(gate.session, async () => {
    const { count } = await prisma.automationRule.deleteMany({ where: { id, orgId } });
    if (count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await logActivity({ action: 'automation.rule_deleted', actorId: gate.session.user.id, targetType: 'AutomationRule', targetId: id, request });
    return NextResponse.json({ ok: true });
  });
}
