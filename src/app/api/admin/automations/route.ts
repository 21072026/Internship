import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { getLocale } from '@/i18n/server';
import {
  MAX_RULES_PER_ORG,
  referenceOptions,
  ruleCount,
  ruleSelect,
  serializeRule,
  stageOptions,
  validateRuleForOrg,
} from '@/lib/automation/admin';

// Stage automation rules (#1704 on top of #1703's engine). docs/automation-rules.md.
//
// AUTHORIZATION is in each handler: `org.settings.write` (an org admin), the
// org from the session. A rule is org configuration that mails and notifies the
// org's people, so no lower tier writes — or reads — it. Every write goes through
// validateRuleForOrg(): the action allowlist, the stage being one of the org's,
// every named tag / requirement / template being the org's.

// GET — the org's rules in display order, its stages and the pickers' options.
export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  const locale = await getLocale();
  return withTenantScope(gate.session, async () => {
    const [rules, stages, references] = await Promise.all([
      prisma.automationRule.findMany({ where: { orgId }, select: ruleSelect, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      stageOptions(orgId, locale),
      referenceOptions(orgId, locale),
    ]);
    return NextResponse.json({ rules: rules.map(serializeRule), stages, references, limit: MAX_RULES_PER_ORG });
  });
}

// POST — a new rule. Always stored DISABLED: switching it on needs a dry run first.
export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  const body = await request.json().catch(() => null);
  return withTenantScope(gate.session, async () => {
    const checked = await validateRuleForOrg(orgId, body && typeof body === 'object' ? { ...body, enabled: false } : body);
    if (!checked.ok) return NextResponse.json({ error: 'Validation failed', code: checked.code, issues: checked.issues }, { status: 400 });
    if ((await ruleCount(orgId)) >= MAX_RULES_PER_ORG) {
      return NextResponse.json({ error: `At most ${MAX_RULES_PER_ORG} rules`, code: 'rule_limit' }, { status: 409 });
    }
    const last = await prisma.automationRule.findFirst({ where: { orgId }, orderBy: { position: 'desc' }, select: { position: true } });
    const r = checked.rule;
    const rule = await prisma.automationRule.create({
      data: {
        orgId,
        name: r.name,
        trigger: r.trigger,
        stageKey: r.stageKey,
        conditions: r.conditions,
        actions: r.actions,
        delayMinutes: r.delayMinutes,
        enabled: false,
        position: (last?.position ?? -1) + 1,
        createdById: gate.session.user.id,
      },
      select: ruleSelect,
    });
    await logActivity({ action: 'automation.rule_created', actorId: gate.session.user.id, targetType: 'AutomationRule', targetId: rule.id, detail: r.stageKey, request });
    return NextResponse.json({ rule: serializeRule(rule) }, { status: 201 });
  });
}
