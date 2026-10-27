// Stage automation rules (#1703) — THE vocabulary, pure and client-safe.
//
// An `AutomationRule` says: "when a relation ENTERS (or LEAVES) stage X, and
// these conditions hold, do these actions, in this order, optionally after a
// delay". This file is everything about a rule that needs no database:
//
//   • the TRIGGERS and the CONDITION vocabulary (an allowlisted field, an
//     operator that field accepts, a typed value — never an expression),
//   • the ACTION ALLOWLIST with a zod parameter schema per action,
//   • `parseRuleInput()`, the one write-time gate: an unknown action name, an
//     unknown condition field or a parameter outside its schema is REJECTED
//     when the rule is stored, never silently skipped when it runs,
//   • `evaluateConditions()`, the one condition evaluator — the event
//     subscriber and the admin's dry run (#1704) both call it, so a simulation
//     is the same decision the live run makes,
//   • `runStatusFor()`, how per-action results fold into the run's status.
//
// THE SAFETY LINE (non-negotiable, see the issue): no action takes a URL, a
// free-form recipient address, or text that is evaluated or rendered as a
// template. Recipients are ROLES relative to the relation (its mentor, its
// mentee, its company's users, the org's admins); mail copy comes from a fixed
// catalogue of templates (`AUTOMATION_EMAIL_TEMPLATES`) written in the
// dictionaries; every id an action names (a tag, a document requirement, a goal
// template) is checked against the rule's own org at write time AND at run time.
// No action moves a pipeline stage (`movesStage: false` on every entry, pinned by
// the unit spec), so a rule can never trigger itself or another rule — the chain
// depth is structurally 0. No action restricts what a mentor or a mentee can do
// (free core): the allowlist only notifies, mails, labels, sets a date or hands
// out a goal.
//
// SCOPE (#1684): this is the ONLY stage-triggered rule engine. Audience
// messaging (segments, per-person caps, cooldown) is the nudge engine's; the two
// messaging actions here go through the product's single send paths
// (`notifyIfAllowed()`, `sendEmail()` with its central unsubscribe check) and
// never write to a mentee whose relation just reached an outcome stage — that
// copy is the mentor's to write (outcomeComms.ts, #830).
//
// Dependency-free apart from zod.

import { z } from 'zod';

export const AUTOMATION_TRIGGERS = ['STAGE_ENTRY', 'STAGE_EXIT'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

/** AutomationRun.status. PENDING = waiting for its delay; RUNNING = claimed. */
export const AUTOMATION_RUN_STATUSES = ['PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const MAX_RULE_NAME = 120;
export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 10;
/** A delay is a queue `runAt`; thirty days is the furthest a stage step plans ahead. */
export const MAX_DELAY_MINUTES = 30 * 24 * 60;
/** Rules per org — the evaluator loads every enabled one for a stage on each move. */
export const MAX_RULES_PER_ORG = 100;

// ── Conditions ──────────────────────────────────────────────────────────────

/**
 * What a condition can look at. Each field is computed by the server from the
 * relation and the event (`AutomationFacts`), never read from a request.
 */
export const CONDITION_FIELDS = {
  /** MentorshipRelation.kind — PLACEMENT | COACHING. */
  kind: { ops: ['eq', 'neq'], value: 'kind' },
  /** The relation has a company attached. */
  hasCompany: { ops: ['eq'], value: 'boolean' },
  /** The stage the relation came from. */
  fromStage: { ops: ['in', 'notIn'], value: 'stages' },
  /** The stage the relation moved to. */
  toStage: { ops: ['in', 'notIn'], value: 'stages' },
  /** Whole days the relation spent in `fromStage` before this move. */
  daysInFromStage: { ops: ['gte', 'lte'], value: 'days' },
} as const;
export type ConditionField = keyof typeof CONDITION_FIELDS;
export const CONDITION_FIELD_NAMES = Object.keys(CONDITION_FIELDS) as ConditionField[];

const stageKey = z.string().trim().min(1).max(191);
const stageList = z.array(stageKey).min(1).max(50);

export const conditionSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('kind'), op: z.enum(['eq', 'neq']), value: z.enum(['PLACEMENT', 'COACHING']) }).strict(),
  z.object({ field: z.literal('hasCompany'), op: z.literal('eq'), value: z.boolean() }).strict(),
  z.object({ field: z.literal('fromStage'), op: z.enum(['in', 'notIn']), value: stageList }).strict(),
  z.object({ field: z.literal('toStage'), op: z.enum(['in', 'notIn']), value: stageList }).strict(),
  z.object({ field: z.literal('daysInFromStage'), op: z.enum(['gte', 'lte']), value: z.number().int().min(0).max(3650) }).strict(),
]);
export type AutomationCondition = z.infer<typeof conditionSchema>;

/** The facts a condition is judged against — computed server-side per event. */
export interface AutomationFacts {
  kind: string;
  hasCompany: boolean;
  fromStage: string;
  toStage: string;
  /** null when the entry into `fromStage` is unknown — a `daysInFromStage` condition then fails. */
  daysInFromStage: number | null;
}

/** One condition. Pure; an unknown shape (a row stored by older code) is false. */
export function conditionHolds(condition: AutomationCondition, facts: AutomationFacts): boolean {
  switch (condition.field) {
    case 'kind':
      return condition.op === 'eq' ? facts.kind === condition.value : facts.kind !== condition.value;
    case 'hasCompany':
      return facts.hasCompany === condition.value;
    case 'fromStage':
    case 'toStage': {
      const inList = condition.value.includes(facts[condition.field]);
      return condition.op === 'in' ? inList : !inList;
    }
    case 'daysInFromStage':
      if (facts.daysInFromStage == null) return false;
      return condition.op === 'gte' ? facts.daysInFromStage >= condition.value : facts.daysInFromStage <= condition.value;
    default:
      return false;
  }
}

/**
 * All conditions, AND-ed. `failed` names the fields that did not hold, in rule
 * order — what the run log and the dry run show as the reason for a skip.
 */
export function evaluateConditions(conditions: readonly AutomationCondition[], facts: AutomationFacts): { pass: boolean; failed: ConditionField[] } {
  const failed = conditions.filter((c) => !conditionHolds(c, facts)).map((c) => c.field);
  return { pass: failed.length === 0, failed };
}

// ── Actions: the allowlist ──────────────────────────────────────────────────

/** Who an action addresses — always relative to the relation, never an address. */
export const NOTIFY_ROLES = ['mentor', 'mentee', 'company', 'admins'] as const;
export type NotifyRole = (typeof NOTIFY_ROLES)[number];

/**
 * The catalogued automation mails. Each names its ONE recipient role; the copy
 * lives in the dictionaries (`notifications.automationEmail.<template>`), so an
 * admin picks a template, never writes one.
 */
export const AUTOMATION_EMAIL_TEMPLATES = {
  /** To the mentee: "you are now at <stage>, here is where to look". */
  menteeNextStep: { recipient: 'mentee' },
  /** To the mentor: "<mentee> is now at <stage>, check in". */
  mentorCheckIn: { recipient: 'mentor' },
} as const satisfies Record<string, { recipient: 'mentor' | 'mentee' }>;
export type AutomationEmailTemplate = keyof typeof AUTOMATION_EMAIL_TEMPLATES;
const TEMPLATE_NAMES = Object.keys(AUTOMATION_EMAIL_TEMPLATES) as [AutomationEmailTemplate, ...AutomationEmailTemplate[]];

const rowId = z.string().trim().min(1).max(191);

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notifyRole'), role: z.enum(NOTIFY_ROLES) }).strict(),
  z.object({ type: z.literal('sendTemplateEmail'), template: z.enum(TEMPLATE_NAMES) }).strict(),
  z.object({ type: z.literal('setStageDeadline'), days: z.number().int().min(1).max(365) }).strict(),
  z.object({ type: z.literal('assignGoalFromTemplate'), templateId: rowId }).strict(),
  z.object({ type: z.literal('requireDocument'), requirementId: rowId }).strict(),
  z.object({ type: z.literal('addTag'), tagId: rowId }).strict(),
]);
export type AutomationAction = z.infer<typeof actionSchema>;
export type AutomationActionType = AutomationAction['type'];

/**
 * Per action: whether it writes to the MENTEE (barred on an outcome stage), and
 * whether it can move a stage (never — the re-entrancy argument rests on it),
 * and which org-owned row its parameter names (checked at write and run time).
 *
 * `logInteraction` from the issue's list is deliberately absent: an
 * `InteractionLog` row IS "contact" (docs/last-contact.md, #2275), so an
 * automated one would silence the stagnation reminder about a mentee nobody
 * actually spoke to.
 */
export const AUTOMATION_ACTIONS: Record<AutomationActionType, { movesStage: false; references: 'tag' | 'documentRequirement' | 'goalTemplate' | null }> = {
  notifyRole: { movesStage: false, references: null },
  sendTemplateEmail: { movesStage: false, references: null },
  setStageDeadline: { movesStage: false, references: null },
  assignGoalFromTemplate: { movesStage: false, references: 'goalTemplate' },
  requireDocument: { movesStage: false, references: 'documentRequirement' },
  addTag: { movesStage: false, references: 'tag' },
};
export const AUTOMATION_ACTION_TYPES = Object.keys(AUTOMATION_ACTIONS) as AutomationActionType[];

/** True when the action puts something in front of the mentee. */
export function addressesMentee(action: AutomationAction): boolean {
  if (action.type === 'notifyRole') return action.role === 'mentee';
  if (action.type === 'sendTemplateEmail') return AUTOMATION_EMAIL_TEMPLATES[action.template].recipient === 'mentee';
  return action.type === 'requireDocument';
}

/** The org-owned row an action names, for the write-time and run-time ownership check. */
export function referencedRow(action: AutomationAction): { kind: 'tag' | 'documentRequirement' | 'goalTemplate'; id: string } | null {
  if (action.type === 'addTag') return { kind: 'tag', id: action.tagId };
  if (action.type === 'requireDocument') return { kind: 'documentRequirement', id: action.requirementId };
  if (action.type === 'assignGoalFromTemplate') return { kind: 'goalTemplate', id: action.templateId };
  return null;
}

// ── The rule as written ─────────────────────────────────────────────────────

export const ruleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_RULE_NAME),
    trigger: z.enum(AUTOMATION_TRIGGERS),
    stageKey,
    conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
    delayMinutes: z.number().int().min(0).max(MAX_DELAY_MINUTES).default(0),
    enabled: z.boolean().default(false),
  })
  .strict();
export type AutomationRuleInput = z.infer<typeof ruleInputSchema>;

export type RuleInputResult =
  | { ok: true; rule: AutomationRuleInput }
  | { ok: false; code: 'invalid' | 'mentee_message_on_outcome_stage'; issues: string[] };

/**
 * THE write-time gate. `isOutcomeStage` answers for the rule's own org (an
 * off-path or canonical ending stage): a rule that would message the mentee on
 * ENTRY to one is refused — that wording is the mentor's (#830, #1684).
 */
export function parseRuleInput(input: unknown, isOutcomeStage: (key: string) => boolean): RuleInputResult {
  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'invalid', issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const rule = parsed.data;
  if (rule.trigger === 'STAGE_ENTRY' && isOutcomeStage(rule.stageKey) && rule.actions.some(addressesMentee)) {
    return { ok: false, code: 'mentee_message_on_outcome_stage', issues: ['actions: a rule on an outcome stage may not message the mentee'] };
  }
  return { ok: true, rule };
}

/**
 * Read a stored rule back. A row whose JSON no longer parses (written by older
 * code, or by hand) yields null and the evaluator records a FAILED run rather
 * than guessing what it meant.
 */
export function readStoredRule(row: { conditions: unknown; actions: unknown }): { conditions: AutomationCondition[]; actions: AutomationAction[] } | null {
  const conditions = z.array(conditionSchema).max(MAX_CONDITIONS).safeParse(row.conditions ?? []);
  const actions = z.array(actionSchema).min(1).max(MAX_ACTIONS).safeParse(row.actions);
  if (!conditions.success || !actions.success) return null;
  return { conditions: conditions.data, actions: actions.data };
}

/** Does this rule listen to this move? */
export function ruleMatchesMove(rule: { trigger: string; stageKey: string }, move: { from: string; to: string }): boolean {
  if (move.from === move.to) return false;
  if (rule.trigger === 'STAGE_ENTRY') return rule.stageKey === move.to;
  if (rule.trigger === 'STAGE_EXIT') return rule.stageKey === move.from;
  return false;
}

// ── Results ─────────────────────────────────────────────────────────────────

/** One action's outcome, as stored in `AutomationRun.results`. No PII: ids and codes. */
export interface ActionResult {
  index: number;
  type: string;
  status: 'ok' | 'skipped' | 'failed';
  /** A code for a skip or a failure (`unsubscribed`, `not_found`, …), or a count note. */
  detail?: string;
}

/** SUCCESS when nothing failed, FAILED when everything did, PARTIAL in between. */
export function runStatusFor(results: readonly ActionResult[]): 'SUCCESS' | 'PARTIAL' | 'FAILED' {
  const failed = results.filter((r) => r.status === 'failed').length;
  if (failed === 0) return 'SUCCESS';
  return failed === results.length ? 'FAILED' : 'PARTIAL';
}

/** Whole days between two instants, floored; null when the start is unknown. */
export function wholeDaysBetween(start: Date | null, end: Date): number | null {
  if (!start) return null;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
}
