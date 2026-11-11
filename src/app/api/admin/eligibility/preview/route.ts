import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { previewAdmission } from '@/lib/eligibility';
import { isEligibilityMode, MAX_RULES_PER_SCOPE, parseRuleInput, type EligibilityRuleRow } from '@/lib/eligibilityRule';

// POST { programId?, mode, rules[] } — "who does this admit?" (#1945). Counts
// the org's current participants a DRAFT rule set would let in, before it is
// saved: the check that keeps a rule from locking a whole cohort out on a
// Monday morning. Reads only; two queries over the roster, never one per person.
// The draft is validated with the same gate a saved rule passes.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { programId?: unknown; mode?: unknown; rules?: unknown } | null;
  const programId = typeof body?.programId === 'string' && body.programId ? body.programId : null;
  const gate = await requirePermission('program.read', { request, ...(programId ? { subject: { cohortId: programId } } : {}) });
  if ('error' in gate) return gate.error;
  const orgId = resolveOrgId(gate.session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
  const gated = await requireCapability(orgId, 'mentorship');
  if (gated) return gated;
  if (!isEligibilityMode(body?.mode)) return NextResponse.json({ error: 'Unknown mode', code: 'invalid_mode' }, { status: 400 });
  const raw = Array.isArray(body?.rules) ? body.rules : [];
  if (raw.length > MAX_RULES_PER_SCOPE) return NextResponse.json({ error: 'Too many rules', code: 'too_many_rules' }, { status: 400 });
  const rules: EligibilityRuleRow[] = [];
  for (const [i, r] of raw.entries()) {
    const parsed = parseRuleInput(r);
    if (!parsed.ok) return NextResponse.json({ error: 'Invalid rule', code: parsed.code, index: i }, { status: 400 });
    const active = (r as { active?: unknown }).active !== false;
    rules.push({ id: `draft-${i}`, ...parsed.rule, active, createdAt: new Date(i) });
  }
  const mode = body.mode;
  return withTenantScope(gate.session, async () => {
    if (programId && !(await prisma.cohort.findFirst({ where: { id: programId, orgId }, select: { id: true } }))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(await previewAdmission(orgId, programId, { mode, rules }));
  });
}
