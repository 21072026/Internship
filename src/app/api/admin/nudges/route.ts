import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { getLocale } from '@/i18n/server';
import { requirePermission } from '@/lib/authz';
import { nudgeScope } from '@/lib/nudges/adminGuard';
import { listRules, nudgeEditorOptions, parseForOrg, ruleData } from '@/lib/nudges/admin';
import { MAX_RULES_PER_ORG } from '@/lib/nudges/rule';

// /api/admin/nudges (#1686): the org's nudge rules with their sends in the
// last 30 days and the editor's pick lists; POST creates one. Stage-triggered
// rules are /api/admin/automations (#1704) and are refused here.
export async function GET(request: Request) {
  const auth = await requirePermission('org.settings.write', { request });
  if ('error' in auth) return auth.error;
  const g = await nudgeScope(auth.session);
  if ('error' in g) return g.error;
  const [rules, options] = await Promise.all([listRules(g.orgId), nudgeEditorOptions(g.orgId, await getLocale())]);
  return NextResponse.json({ rules, options });
}

export async function POST(request: Request) {
  const auth = await requirePermission('org.settings.write', { request });
  if ('error' in auth) return auth.error;
  const g = await nudgeScope(auth.session);
  if ('error' in g) return g.error;
  const parsed = await parseForOrg(await request.json().catch(() => null), g.orgId);
  if (!parsed.ok) return NextResponse.json({ error: 'Validation failed', code: parsed.code, issues: parsed.issues }, { status: 400 });
  if ((await prisma.nudgeRule.count({ where: { orgId: g.orgId } })) >= MAX_RULES_PER_ORG) {
    return NextResponse.json({ error: 'Too many rules', code: 'too_many' }, { status: 409 });
  }
  const rule = await prisma.nudgeRule.create({
    data: { ...ruleData(parsed.rule), orgId: g.orgId, createdById: g.userId },
    select: { id: true, enabled: true, name: true },
  });
  await logActivity({
    action: rule.enabled ? 'nudge.enabled' : 'nudge.created',
    level: rule.enabled ? 'warning' : 'info',
    actorId: g.userId,
    actorEmail: g.email,
    targetType: 'nudgeRule',
    targetId: rule.id,
    orgId: g.orgId,
    detail: rule.name,
    request,
  });
  return NextResponse.json({ rule: { id: rule.id }, missingLocales: parsed.missingLocales }, { status: 201 });
}
