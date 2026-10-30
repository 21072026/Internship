// Programme eligibility (#1945) — the rule, pure and dependency-free so
// `node --test --experimental-strip-types` loads it directly
// (scripts/test/eligibility.test.mjs). docs/program-eligibility.md is the prose.
//
// WHAT IT DECIDES: whether a person may be ENROLLED as a participant (a
// mentee) — in a programme (a Cohort row, #1622's Program) or, with no
// programme, in the organisation at all (SSO JIT, the public apply form, a
// direct assignment). It is an admission control, never a paywall: the app is
// always free for mentors and mentees.
//
// THE MODES. `Organization.eligibilityMode` and `Cohort.eligibilityMode` are
// `OPEN` (the default — today's behaviour, so the deploy locks nobody out) or
// `RULES` (ineligible by default: only an ALLOW rule admits). A programme is
// gated when IT or its organisation is in RULES mode, and the rules that apply
// are the organisation-wide ones (programId null) plus the programme's own.
//
// THE PRECEDENCE, deterministic, written here AND in the doc:
//   1. Only ACTIVE rules whose condition matches the person count.
//   2. Higher `priority` first.
//   3. At equal priority, DENY before ALLOW — a DENY beats an ALLOW.
//   4. Then the older rule (createdAt), then the id — a total order, so the
//      same inputs always name the same deciding rule.
//   The first rule in that order decides. No matching rule in RULES mode is a
//   refusal (`no_matching_rule`).
//
// ATTRIBUTES are an allowlist: a few User columns, or `attr:<key>` of one of
// the org's own attributes (#1920 — the same prefix the SSO directory sync,
// #1943, writes them under). Comparison is trimmed and case-insensitive; GTE /
// LTE compare numbers, or ISO dates (YYYY-MM-DD) as dates, and nothing else.

export const ELIGIBILITY_MODES = ['OPEN', 'RULES'] as const;
export type EligibilityMode = (typeof ELIGIBILITY_MODES)[number];

export const ELIGIBILITY_EFFECTS = ['ALLOW', 'DENY'] as const;
export type EligibilityEffect = (typeof ELIGIBILITY_EFFECTS)[number];

export const ELIGIBILITY_OPERATORS = ['EQUALS', 'IN', 'NOT_IN', 'GTE', 'LTE', 'EXISTS'] as const;
export type EligibilityOperator = (typeof ELIGIBILITY_OPERATORS)[number];

/** The User columns a rule may read. Each is a plain String? on User. */
export const ELIGIBILITY_USER_FIELDS = ['department', 'city', 'country', 'university', 'targetPosition', 'timezone'] as const;
export type EligibilityUserField = (typeof ELIGIBILITY_USER_FIELDS)[number];

export const ELIGIBILITY_ATTRIBUTE_PREFIX = 'attr:';
export const MAX_RULE_VALUES = 50;
export const MAX_RULE_VALUE_LENGTH = 191;
export const MAX_RULES_PER_SCOPE = 100;

export interface EligibilityRuleRow {
  id: string;
  effect: string;
  attribute: string;
  operator: string;
  value: unknown;
  priority: number;
  active: boolean;
  createdAt: Date | string;
}

/** What the evaluator reads about a person: column values and `attr:<key>` values. */
export type EligibilityProfile = Record<string, string | null | undefined>;

export type EligibilityReason = 'open' | 'allowed' | 'denied' | 'no_matching_rule';

export interface EligibilityDecision {
  ok: boolean;
  reason: EligibilityReason;
  /** The deciding rule; absent for `open` and `no_matching_rule`. */
  ruleId?: string;
}

export function isEligibilityMode(v: unknown): v is EligibilityMode {
  return typeof v === 'string' && (ELIGIBILITY_MODES as readonly string[]).includes(v);
}

export function isUserField(v: string): v is EligibilityUserField {
  return (ELIGIBILITY_USER_FIELDS as readonly string[]).includes(v);
}

/** The attribute key of an `attr:<key>` attribute, or null. */
export function attributeKeyOf(attribute: string): string | null {
  if (!attribute.startsWith(ELIGIBILITY_ATTRIBUTE_PREFIX)) return null;
  const key = attribute.slice(ELIGIBILITY_ATTRIBUTE_PREFIX.length);
  return /^[a-z][a-z0-9_]{0,63}$/.test(key) ? key : null;
}

export function isEligibilityAttribute(v: string): boolean {
  return isUserField(v) || attributeKeyOf(v) !== null;
}

/** A programme is gated when it or its organisation is in RULES mode. */
export function effectiveMode(orgMode: string | null | undefined, programMode: string | null | undefined): EligibilityMode {
  return orgMode === 'RULES' || programMode === 'RULES' ? 'RULES' : 'OPEN';
}

const norm = (v: string) => v.trim().toLocaleLowerCase('en');

function asList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map((v) => String(v));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** -1 / 0 / 1, or null when the two cannot be ordered (not both numbers, not both ISO dates). */
function compare(have: string, want: string): number | null {
  const a = have.trim();
  const b = want.trim();
  if (ISO_DATE.test(a) && ISO_DATE.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = Number(a.replace(',', '.'));
  const y = Number(b.replace(',', '.'));
  if (a === '' || b === '' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Does this rule's condition hold for the person? */
export function ruleMatches(rule: Pick<EligibilityRuleRow, 'attribute' | 'operator' | 'value'>, profile: EligibilityProfile): boolean {
  const raw = profile[rule.attribute];
  const have = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  switch (rule.operator) {
    case 'EXISTS':
      return (rule.value === false) === (have === null);
    case 'EQUALS': {
      const [want] = asList(rule.value);
      return have !== null && want !== undefined && norm(have) === norm(want);
    }
    case 'IN':
      return have !== null && asList(rule.value).some((w) => norm(w) === norm(have));
    case 'NOT_IN':
      // A person with no value is not "in" the list — but neither is it a
      // statement about them; NOT_IN matches only a present, other value.
      return have !== null && !asList(rule.value).some((w) => norm(w) === norm(have));
    case 'GTE':
    case 'LTE': {
      const [want] = asList(rule.value);
      if (have === null || want === undefined) return false;
      const c = compare(have, want);
      return c !== null && (rule.operator === 'GTE' ? c >= 0 : c <= 0);
    }
    default:
      return false; // an unknown operator never admits anybody
  }
}

const time = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** The precedence order (rules 2–4 of the header). Returns a new array. */
export function orderRules<R extends EligibilityRuleRow>(rules: readonly R[]): R[] {
  return [...rules].sort((a, b) =>
    b.priority - a.priority
    || (a.effect === 'DENY' ? 0 : 1) - (b.effect === 'DENY' ? 0 : 1)
    || time(a.createdAt) - time(b.createdAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * THE evaluator. `mode` is the effective mode (effectiveMode()); `rules` are
 * every rule of the scope (org-wide + the programme's), active or not.
 */
export function evaluateEligibility(mode: string, rules: readonly EligibilityRuleRow[], profile: EligibilityProfile): EligibilityDecision {
  if (mode !== 'RULES') return { ok: true, reason: 'open' };
  return decide(orderRules(rules.filter((r) => r.active)), profile);
}

function decide(ordered: readonly EligibilityRuleRow[], profile: EligibilityProfile): EligibilityDecision {
  for (const rule of ordered) {
    if (!ruleMatches(rule, profile)) continue;
    if (rule.effect === 'DENY') return { ok: false, reason: 'denied', ruleId: rule.id };
    if (rule.effect === 'ALLOW') return { ok: true, reason: 'allowed', ruleId: rule.id };
  }
  return { ok: false, reason: 'no_matching_rule' };
}

export type RuleInputError = 'invalid_effect' | 'invalid_attribute' | 'invalid_operator' | 'invalid_value' | 'invalid_priority';

export interface RuleInput {
  effect: EligibilityEffect;
  attribute: string;
  operator: EligibilityOperator;
  value: string | string[] | boolean;
  priority: number;
}

/**
 * The write-time gate: a rule is stored only in the shape the evaluator reads.
 * Values are trimmed, de-duplicated and capped; a list operator needs a
 * non-empty list, a single-value operator one string, EXISTS a boolean.
 */
export function parseRuleInput(input: unknown): { ok: true; rule: RuleInput } | { ok: false; code: RuleInputError } {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.effect !== 'string' || !(ELIGIBILITY_EFFECTS as readonly string[]).includes(o.effect)) return { ok: false, code: 'invalid_effect' };
  if (typeof o.attribute !== 'string' || !isEligibilityAttribute(o.attribute)) return { ok: false, code: 'invalid_attribute' };
  if (typeof o.operator !== 'string' || !(ELIGIBILITY_OPERATORS as readonly string[]).includes(o.operator)) return { ok: false, code: 'invalid_operator' };
  const priority = o.priority === undefined ? 0 : o.priority;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < -1000 || priority > 1000) return { ok: false, code: 'invalid_priority' };
  const operator = o.operator as EligibilityOperator;
  let value: RuleInput['value'];
  if (operator === 'EXISTS') {
    if (typeof o.value !== 'boolean') return { ok: false, code: 'invalid_value' };
    value = o.value;
  } else if (operator === 'IN' || operator === 'NOT_IN') {
    const seen = new Set<string>();
    const list: string[] = [];
    // A comma-separated string is a list too (what a person types).
    const items = typeof o.value === 'string' ? o.value.split(',') : asList(o.value);
    for (const v of items) {
      const t = v.trim();
      if (!t || t.length > MAX_RULE_VALUE_LENGTH || seen.has(norm(t))) continue;
      seen.add(norm(t));
      list.push(t);
    }
    if (list.length === 0 || list.length > MAX_RULE_VALUES) return { ok: false, code: 'invalid_value' };
    value = list;
  } else {
    const t = typeof o.value === 'string' || typeof o.value === 'number' ? String(o.value).trim() : '';
    if (!t || t.length > MAX_RULE_VALUE_LENGTH) return { ok: false, code: 'invalid_value' };
    if ((operator === 'GTE' || operator === 'LTE') && compare(t, t) === null) return { ok: false, code: 'invalid_value' };
    value = t;
  }
  return { ok: true, rule: { effect: o.effect as EligibilityEffect, attribute: o.attribute, operator, value, priority } };
}

/** How many of `profiles` the rule set admits — the builder's dry run. */
export function countAdmitted(mode: string, rules: readonly EligibilityRuleRow[], profiles: readonly EligibilityProfile[]): number {
  if (mode !== 'RULES') return profiles.length;
  const ordered = orderRules(rules.filter((r) => r.active)); // once, not per person
  let n = 0;
  for (const p of profiles) if (decide(ordered, p).ok) n += 1;
  return n;
}
