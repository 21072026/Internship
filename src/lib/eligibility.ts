// Programme eligibility (#1945) — the Prisma-aware half. THE rule (modes,
// operators, precedence) is src/lib/eligibilityRule.ts; this file only loads
// what it reads. Every enforcement point asks through here — POST
// /api/mentorship, the public apply form, SSO JIT provisioning, the matching
// loaders — and none re-implements the decision. docs/program-eligibility.md.
//
// Every query names the org explicitly: SSO JIT and the apply form are
// sessionless, and an admin route may preview another programme of its own
// org. A programme of ANOTHER org reads as no programme (its rules and mode are
// never consulted).
//
// Server-only.

import { prisma } from '@/lib/prisma';
import {
  attributeKeyOf,
  countAdmitted,
  effectiveMode,
  ELIGIBILITY_USER_FIELDS,
  evaluateEligibility,
  type EligibilityDecision,
  type EligibilityProfile,
  type EligibilityRuleRow,
} from '@/lib/eligibilityRule';

export interface EligibilityScope {
  mode: 'OPEN' | 'RULES';
  rules: EligibilityRuleRow[];
}

const ruleSelect = { id: true, effect: true, attribute: true, operator: true, value: true, priority: true, active: true, createdAt: true } as const;
const userFieldSelect = Object.fromEntries(ELIGIBILITY_USER_FIELDS.map((f) => [f, true])) as Record<(typeof ELIGIBILITY_USER_FIELDS)[number], true>;

/** The effective mode and every rule of a scope: org-wide rules plus the programme's own. */
export async function loadEligibilityScope(orgId: string | null | undefined, programId: string | null | undefined): Promise<EligibilityScope> {
  if (!orgId) return { mode: 'OPEN', rules: [] };
  const [org, program] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { eligibilityMode: true } }),
    programId ? prisma.cohort.findFirst({ where: { id: programId, orgId }, select: { id: true, eligibilityMode: true } }) : null,
  ]);
  const mode = effectiveMode(org?.eligibilityMode, program?.eligibilityMode);
  if (mode === 'OPEN') return { mode, rules: [] };
  const rules = await prisma.programEligibilityRule.findMany({
    where: { orgId, OR: [{ programId: null }, ...(program ? [{ programId: program.id }] : [])] },
    select: ruleSelect,
  });
  return { mode, rules };
}

/** The `attr:<key>` keys a rule set reads — only those values are loaded. */
function attributeKeys(rules: readonly EligibilityRuleRow[]): string[] {
  return [...new Set(rules.map((r) => attributeKeyOf(r.attribute)).filter((k): k is string => !!k))];
}

/**
 * Profiles of many users in two queries (users, then attribute values) — the
 * dry run and the matching filter must never be an N+1 over the roster.
 */
async function loadProfiles(orgId: string, where: { id?: { in: string[] }; role?: 'MENTEE' }, keys: readonly string[]): Promise<Map<string, EligibilityProfile>> {
  const users = await prisma.user.findMany({ where: { orgId, ...where }, select: { id: true, ...userFieldSelect } });
  const out = new Map<string, EligibilityProfile>();
  for (const { id, ...fields } of users) out.set(id, { ...fields });
  if (keys.length && users.length) {
    const values = await prisma.userAttributeValue.findMany({
      where: { orgId, userId: { in: users.map((u) => u.id) }, attribute: { key: { in: [...keys] } } },
      select: { userId: true, value: true, attribute: { select: { key: true } } },
    });
    for (const v of values) {
      const p = out.get(v.userId);
      if (p) p[`attr:${v.attribute.key}`] = v.value;
    }
  }
  return out;
}

/**
 * THE question: may this person be enrolled in this programme (or, with no
 * programme, in the organisation)? Pass `id` for an existing user, or a
 * `profile` for one not created yet (the apply form). `orgId` is the org the
 * enrolment happens in — never taken from a request body.
 */
export async function isEligible(
  subject: { id?: string; orgId: string | null | undefined; profile?: EligibilityProfile },
  programId: string | null = null,
): Promise<EligibilityDecision> {
  const scope = await loadEligibilityScope(subject.orgId, programId);
  if (scope.mode === 'OPEN') return { ok: true, reason: 'open' };
  let profile: EligibilityProfile = subject.profile ?? {};
  if (subject.id && subject.orgId) {
    profile = (await loadProfiles(subject.orgId, { id: { in: [subject.id] } }, attributeKeys(scope.rules))).get(subject.id) ?? {};
  }
  return evaluateEligibility(scope.mode, scope.rules, profile);
}

/** The subset of `ids` the scope admits, in their order. Two queries at most beyond the scope. */
export async function eligibleUserIds(orgId: string | null | undefined, programId: string | null, ids: readonly string[]): Promise<string[]> {
  const scope = await loadEligibilityScope(orgId, programId);
  if (scope.mode === 'OPEN' || !orgId || ids.length === 0) return [...ids];
  const profiles = await loadProfiles(orgId, { id: { in: [...ids] } }, attributeKeys(scope.rules));
  return ids.filter((id) => evaluateEligibility(scope.mode, scope.rules, profiles.get(id) ?? {}).ok);
}

/**
 * The builder's dry run: how many of the org's current participants (MENTEE
 * accounts) a DRAFT rule set would admit — before anything is saved. The
 * draft replaces the scope's own rules; for a programme the org-wide rules
 * still apply, exactly as they would after saving.
 */
export async function previewAdmission(
  orgId: string,
  programId: string | null,
  draft: { mode: string; rules: EligibilityRuleRow[] },
): Promise<{ total: number; admitted: number }> {
  let rules = draft.rules;
  let mode = draft.mode;
  if (programId) {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { eligibilityMode: true } });
    const orgWide = await prisma.programEligibilityRule.findMany({ where: { orgId, programId: null }, select: ruleSelect });
    rules = [...orgWide, ...draft.rules];
    mode = effectiveMode(org?.eligibilityMode, draft.mode);
  }
  const profiles = await loadProfiles(orgId, { role: 'MENTEE' }, attributeKeys(rules));
  return { total: profiles.size, admitted: countAdmitted(mode, rules, [...profiles.values()]) };
}
