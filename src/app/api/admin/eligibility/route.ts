import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission, type Permission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { logActivity } from '@/lib/activity';
import { ELIGIBILITY_OPERATORS, ELIGIBILITY_USER_FIELDS, MAX_RULES_PER_SCOPE, isEligibilityMode, parseRuleInput } from '@/lib/eligibilityRule';

// Programme eligibility rules (#1945): the builder's API. One scope per call —
// `programId` names a programme (a Cohort of the caller's org), absent is the
// organisation-wide scope. THE rule is src/lib/eligibilityRule.ts; nothing here
// decides who is eligible, it only stores rules in the shape the evaluator
// reads (parseRuleInput) and switches a scope between OPEN and RULES.
//
// WHO: `program.read` / `program.write` on the scope (a PROGRAM_ADMIN with a
// grant for that cohort, or an org admin). The org is the session's, never a
// body field; another org's programme reads as 404.

async function gate(request: Request, permission: Permission, programId: string | null) {
  const pre = await requirePermission(permission, { request });
  if ('error' in pre) return pre;
  const orgId = resolveOrgId(pre.session);
  if (!orgId) return { error: NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 }) };
  const gated = await requireCapability(orgId, 'mentorship');
  if (gated) return { error: gated };
  if (programId) {
    const scoped = await requirePermission(permission, { request, subject: { orgId, cohortId: programId } });
    if ('error' in scoped) return scoped;
    const program = await prisma.cohort.findFirst({ where: { id: programId, orgId }, select: { id: true } });
    if (!program) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  return { session: pre.session, orgId };
}

const ruleSelect = { id: true, programId: true, effect: true, attribute: true, operator: true, value: true, priority: true, active: true, createdAt: true } as const;

function programIdOf(request: Request): string | null {
  return new URL(request.url).searchParams.get('programId') || null;
}

// GET ?programId= — the scope's mode and rules, the org-wide rules a programme
// inherits, and the vocabularies the builder offers (exactly what POST accepts).
export async function GET(request: Request) {
  const programId = programIdOf(request);
  const g = await gate(request, 'program.read', programId);
  if ('error' in g) return g.error;
  return withTenantScope(g.session, async () => {
    const [org, program, rules, attributes, programs] = await Promise.all([
      prisma.organization.findUnique({ where: { id: g.orgId }, select: { eligibilityMode: true } }),
      programId ? prisma.cohort.findFirst({ where: { id: programId, orgId: g.orgId }, select: { id: true, name: true, eligibilityMode: true } }) : null,
      prisma.programEligibilityRule.findMany({
        where: { orgId: g.orgId, OR: [{ programId: null }, ...(programId ? [{ programId }] : [])] },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        select: ruleSelect,
      }),
      prisma.orgAttribute.findMany({ where: { orgId: g.orgId, appliesTo: 'USER' }, orderBy: { sortOrder: 'asc' }, select: { key: true, labelEn: true, labelTr: true, labelDe: true, type: true } }),
      prisma.cohort.findMany({ where: { orgId: g.orgId }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, eligibilityMode: true } }),
    ]);
    return NextResponse.json({
      orgMode: org?.eligibilityMode ?? 'OPEN',
      program,
      programs,
      rules: rules.filter((r) => r.programId === programId),
      inheritedRules: programId ? rules.filter((r) => r.programId === null) : [],
      fields: ELIGIBILITY_USER_FIELDS,
      operators: ELIGIBILITY_OPERATORS,
      attributes,
    });
  });
}

// POST { programId?, effect, attribute, operator, value, priority } — add a rule.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const programId = typeof body?.programId === 'string' && body.programId ? body.programId : null;
  const g = await gate(request, 'program.write', programId);
  if ('error' in g) return g.error;
  const parsed = parseRuleInput(body);
  if (!parsed.ok) return NextResponse.json({ error: 'Invalid rule', code: parsed.code }, { status: 400 });
  const { rule } = parsed;
  return withTenantScope(g.session, async () => {
    if (rule.attribute.startsWith('attr:')) {
      const exists = await prisma.orgAttribute.findFirst({ where: { orgId: g.orgId, key: rule.attribute.slice(5), appliesTo: 'USER' }, select: { id: true } });
      if (!exists) return NextResponse.json({ error: 'This organization has no such attribute', code: 'unknown_attribute' }, { status: 400 });
    }
    if ((await prisma.programEligibilityRule.count({ where: { orgId: g.orgId, programId } })) >= MAX_RULES_PER_SCOPE) {
      return NextResponse.json({ error: 'Too many rules', code: 'too_many_rules' }, { status: 400 });
    }
    const created = await prisma.programEligibilityRule.create({
      data: { orgId: g.orgId, programId, ...rule, createdById: g.session.user.id },
      select: ruleSelect,
    });
    await logActivity({
      action: 'eligibility.rule_created',
      actorId: g.session.user.id,
      targetType: 'programEligibilityRule',
      targetId: created.id,
      detail: `${rule.effect} ${rule.attribute} ${rule.operator} (priority ${rule.priority}) ${programId ? `programme ${programId}` : 'org-wide'}`,
      request,
    });
    return NextResponse.json({ rule: created }, { status: 201 });
  });
}

const patchSchema = z.union([
  z.object({ programId: z.string().min(1).nullable().optional(), mode: z.string() }).strict(),
  z.object({ ruleId: z.string().min(1), active: z.boolean() }).strict(),
]);

// PATCH { programId?, mode } — switch a scope OPEN/RULES; { ruleId, active } — pause a rule.
export async function PATCH(request: Request) {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const data = parsed.data;
  if ('mode' in data) {
    if (!isEligibilityMode(data.mode)) return NextResponse.json({ error: 'Unknown mode', code: 'invalid_mode' }, { status: 400 });
    const programId = data.programId ?? null;
    const g = await gate(request, 'program.write', programId);
    if ('error' in g) return g.error;
    return withTenantScope(g.session, async () => {
      if (programId) await prisma.cohort.updateMany({ where: { id: programId, orgId: g.orgId }, data: { eligibilityMode: data.mode } });
      else await prisma.organization.update({ where: { id: g.orgId }, data: { eligibilityMode: data.mode } });
      await logActivity({
        action: 'eligibility.mode_changed',
        level: 'warning',
        actorId: g.session.user.id,
        targetType: programId ? 'cohort' : 'organization',
        targetId: programId ?? g.orgId,
        detail: `eligibilityMode -> ${data.mode}`,
        request,
      });
      return NextResponse.json({ mode: data.mode });
    });
  }
  const g0 = await gate(request, 'program.write', null);
  if ('error' in g0) return g0.error;
  const row = await prisma.programEligibilityRule.findFirst({ where: { id: data.ruleId, orgId: g0.orgId }, select: { programId: true } });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const g = row.programId ? await gate(request, 'program.write', row.programId) : g0;
  if ('error' in g) return g.error;
  return withTenantScope(g.session, async () => {
    await prisma.programEligibilityRule.updateMany({ where: { id: data.ruleId, orgId: g.orgId }, data: { active: data.active } });
    await logActivity({ action: 'eligibility.rule_toggled', actorId: g.session.user.id, targetType: 'programEligibilityRule', targetId: data.ruleId, detail: `active -> ${data.active}`, request });
    return NextResponse.json({ ok: true });
  });
}

// DELETE ?ruleId= — remove a rule. Another org's id is 404.
export async function DELETE(request: Request) {
  const ruleId = new URL(request.url).searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ error: 'ruleId is required' }, { status: 400 });
  const g0 = await gate(request, 'program.write', null);
  if ('error' in g0) return g0.error;
  const row = await prisma.programEligibilityRule.findFirst({ where: { id: ruleId, orgId: g0.orgId }, select: { programId: true } });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const g = row.programId ? await gate(request, 'program.write', row.programId) : g0;
  if ('error' in g) return g.error;
  return withTenantScope(g.session, async () => {
    await prisma.programEligibilityRule.deleteMany({ where: { id: ruleId, orgId: g.orgId } });
    await logActivity({ action: 'eligibility.rule_deleted', actorId: g.session.user.id, targetType: 'programEligibilityRule', targetId: ruleId, request });
    return NextResponse.json({ ok: true });
  });
}
