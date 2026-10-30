import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { matchRuleSetDraftSchema } from '@/lib/matching/ruleSetSchema';
import { createRuleSet, ruleSetSelect, serializeRuleSet, updateRuleSet } from '@/lib/matching/ruleSetStore';
import { DEFAULT_RULE_SET } from '@/lib/matching/score';
import { requirePermission, type Permission } from '@/lib/authz';
import { tenantWhere } from '@/lib/tenantFilter';
import { matchableCustomFields, unmatchableCustomFields, type CustomAnswerDb } from '@/lib/matching/customAnswers';

// A custom-field rule must name a matchable question of THIS org (#1803).
async function refuseUnmatchable(session: Parameters<typeof tenantWhere>[0], rules: readonly { dimension: string }[] | undefined) {
  const bad = await unmatchableCustomFields(prisma as unknown as CustomAnswerDb, await tenantWhere(session), (rules ?? []).map((r) => r.dimension));
  return bad.length > 0 ? NextResponse.json({ error: 'not_matchable_field', code: 'not_matchable_field', dimensions: bad }, { status: 400 }) : null;
}

// The org's matching rule sets (#1783): list, create, edit, set default.
// ADMIN only, checked here; archiving is DELETE on /[id]. Every write goes
// through src/lib/matching/ruleSetStore.ts (version bump, one default).

async function ruleSetGate(permission: Permission, request: Request) {
  const gate = await requirePermission(permission, { request });
  if ('error' in gate) return { error: gate.error };
  const { session } = gate;
  const refusal = await requireCapability(session.user.orgId, 'mentorship');
  if (refusal) return { error: refusal };
  return { session };
}

const createSchema = matchRuleSetDraftSchema.extend({ isDefault: z.boolean().optional() });
const updateSchema = matchRuleSetDraftSchema.partial().extend({ id: z.string().min(1), isDefault: z.boolean().optional() });

export async function GET(request: Request) {
  const { session, error } = await ruleSetGate('program.read', request);
  if (error) return error;
  const includeArchived = new URL(request.url).searchParams.get('archived') === '1';
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const rows = await prisma.matchRuleSet.findMany({
      where: { orgId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      select: ruleSetSelect,
    });
    // The built-in set is what an org with no default scores with; the editor
    // starts a new set from it.
    // The editor offers the org's MATCHABLE questions next to the built-ins (#1803).
    const customFields = await matchableCustomFields(prisma as unknown as CustomAnswerDb, await tenantWhere(session));
    return NextResponse.json({ ruleSets: rows.map(serializeRuleSet), builtIn: DEFAULT_RULE_SET, customFields });
  });
}

export async function POST(request: Request) {
  const { session, error } = await ruleSetGate('program.write', request);
  if (error) return error;
  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
    const refused = await refuseUnmatchable(session, parsed.data.rules);
    if (refused) return refused;
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const row = await createRuleSet(orgId, parsed.data, parsed.data.isDefault ?? false);
    return NextResponse.json({ ruleSet: serializeRuleSet(row) }, { status: 201 });
  });
}

export async function PUT(request: Request) {
  const { session, error } = await ruleSetGate('program.write', request);
  if (error) return error;
  return await withTenantScope(session, async () => {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const { id, isDefault, ...draft } = parsed.data;
    const refused = await refuseUnmatchable(session, draft.rules);
    if (refused) return refused;
    const row = await updateRuleSet(orgId, id, draft, isDefault);
    // Not this org's, or archived: the same 404 either way.
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ruleSet: serializeRuleSet(row) });
  });
}
