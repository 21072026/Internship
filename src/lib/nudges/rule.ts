// Nudge rules (#1684) — THE vocabulary, pure and client-safe.
//
// A `NudgeRule` says: "to the people this SEGMENT describes, when this TRIGGER
// fires, after this DELAY, send this message — at most so often". This file is
// everything about a rule that needs no database:
//
//   • the TRIGGERS: an allowlisted non-stage domain event (the relation's two
//     people are the candidates), or the nightly condition SCAN,
//   • the SEGMENT vocabulary: an allowlisted field, an operator that field
//     accepts, a typed value — the translation to a Prisma `where` is
//     ./segment.ts and nowhere else,
//   • `parseNudgeRuleInput()`, the one write-time gate,
//   • `planRecipients()`, the one per-person decision — the live evaluator and
//     the admin's dry run (#1686) both call it, so a preview IS the decision.
//
// SCOPE (#1703). A rule triggered by a pipeline STAGE change is an
// `AutomationRule` (src/lib/automation/), never a nudge: `pipeline.stage_change`
// and every other stage event is refused here at write time.
//
// THE HARD LIMITS — in code, not configurable, binding every rule:
//   1. NO THIRD DORMANCY MAIL (docs/dormant-first-contacts.md). A mentee whose
//      relation is a dormant first contact (`dormantSince` set) gets the two
//      "still interested?" mails of that flow and nothing else — a nudge would
//      be the third mail to someone who stopped answering, which is exactly
//      what costs the sending domain its reputation. Dropped as `dormancy`.
//   2. NO OUTCOME COPY (src/lib/outcomeComms.server.ts, #830). A mentee whose
//      relation stands at an outcome stage hears about it from their mentor,
//      once, in words a human reviewed. No admin-authored text reaches them
//      there: dropped as `outcome`, and a segment that targets an outcome stage
//      is refused when the rule is stored.
//   3. ONE SEND PATH. Mail goes through `sendEmail()` (unsubscribe, outbound
//      approval hold, suppression, EmailLog) under the `nudge` category; the
//      bell through `notifyIfAllowed()`. A nudge is non-essential by
//      definition, so it always carries the recipient's `userId`.
//   4. PEOPLE, NOT ACCOUNTS OF CUSTOMERS. The audience is MENTOR and MENTEE
//      rows only. A COMPANY login never receives a nudge, so the B2B
//      advertising gate (`canSendMarketingEmail()`, docs/contact-permission.md)
//      is never reached; a role added here must call it per recipient.
//
// THE PER-PERSON PROTECTIONS count EVERY nudge the person got in this org, not
// only this rule's: `maxPerUserPer30Days` refuses a send when the person
// already received that many nudges in the last 30 days, and `cooldownDays`
// when they received any within that many days. Fatigue is a property of the
// inbox, not of the rule that happens to fire.
//
// Dependency-free apart from zod.

import { z } from 'zod';

// ── Triggers ────────────────────────────────────────────────────────────────

/**
 * The domain events a nudge may react to. Each carries a `relationId`; its
 * mentor and mentee are the candidates the segment then filters. Stage events
 * are absent on purpose (see SCOPE above).
 */
export const NUDGE_EVENT_TRIGGERS = [
  'mentorship.created',
  'relation.created',
  'interaction.logged',
  'evaluation.added',
  'meeting.completed',
  'mentorship.lifecycle_changed',
] as const;
export type NudgeEventTrigger = (typeof NUDGE_EVENT_TRIGGERS)[number];

/** Refused at write time with their own code: the stage engine (#1703) owns them. */
export const STAGE_EVENTS = ['pipeline.stage_change', 'pipeline.stage.changed', 'application.stage_changed'] as const;

export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.enum(NUDGE_EVENT_TRIGGERS) }).strict(),
  z.object({ kind: z.literal('scan') }).strict(),
]);
export type NudgeTrigger = z.infer<typeof triggerSchema>;

export const NUDGE_CHANNELS = ['EMAIL', 'IN_APP', 'BOTH'] as const;
export type NudgeChannelName = (typeof NUDGE_CHANNELS)[number];

// ── Segment ─────────────────────────────────────────────────────────────────

export const NUDGE_ROLES = ['MENTOR', 'MENTEE'] as const;

/** Which operators each field takes — the UI's condition row reads this too. */
export const SEGMENT_FIELDS = {
  role: { ops: ['eq'], value: 'role' },
  stage: { ops: ['in', 'notIn'], value: 'stages' },
  daysInStage: { ops: ['gte', 'lte'], value: 'days' },
  daysSinceLastInteraction: { ops: ['gte'], value: 'days' },
  cohort: { ops: ['in'], value: 'cohorts' },
  tag: { ops: ['has', 'notHas'], value: 'tag' },
  hasNoMentor: { ops: ['eq'], value: 'boolean' },
} as const;
export type SegmentField = keyof typeof SEGMENT_FIELDS;
export const SEGMENT_FIELD_NAMES = Object.keys(SEGMENT_FIELDS) as SegmentField[];

const key = z.string().trim().min(1).max(191);
const days = z.number().int().min(0).max(3650);

export const segmentConditionSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('role'), op: z.literal('eq'), value: z.enum(NUDGE_ROLES) }).strict(),
  z.object({ field: z.literal('stage'), op: z.enum(['in', 'notIn']), value: z.array(key).min(1).max(50) }).strict(),
  z.object({ field: z.literal('daysInStage'), op: z.enum(['gte', 'lte']), value: days }).strict(),
  z.object({ field: z.literal('daysSinceLastInteraction'), op: z.literal('gte'), value: days }).strict(),
  z.object({ field: z.literal('cohort'), op: z.literal('in'), value: z.array(key).min(1).max(50) }).strict(),
  z.object({ field: z.literal('tag'), op: z.enum(['has', 'notHas']), value: key }).strict(),
  z.object({ field: z.literal('hasNoMentor'), op: z.literal('eq'), value: z.boolean() }).strict(),
]);
export type SegmentCondition = z.infer<typeof segmentConditionSchema>;

export const MAX_SEGMENT_CONDITIONS = 10;
export const segmentSchema = z.object({ conditions: z.array(segmentConditionSchema).max(MAX_SEGMENT_CONDITIONS) }).strict();
export type Segment = z.infer<typeof segmentSchema>;

/** The role(s) a segment can reach: its `role` condition, or both. */
export function segmentRoles(segment: Segment): ('MENTOR' | 'MENTEE')[] {
  const r = segment.conditions.find((c): c is Extract<SegmentCondition, { field: 'role' }> => c.field === 'role');
  return r ? [r.value] : ['MENTOR', 'MENTEE'];
}

// ── The rule as written ─────────────────────────────────────────────────────

export const MAX_RULE_NAME = 120;
export const MAX_SUBJECT = 191;
export const MAX_BODY = 5_000;
/** A delay is a queue `runAt`; thirty days is as far as a nudge plans ahead. */
export const MAX_DELAY_MINUTES = 30 * 24 * 60;
export const MAX_RULES_PER_ORG = 100;
/** A scan never reaches more people than this in one run (and the dry run samples from them). */
export const MAX_AUDIENCE = 2_000;
export const NUDGE_LOCALES = ['en', 'tr', 'de'] as const;
export type NudgeLocale = (typeof NUDGE_LOCALES)[number];

const text = (max: number) => z.string().trim().max(max).nullable().optional();

export const nudgeRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_RULE_NAME),
    enabled: z.boolean().default(false),
    trigger: triggerSchema,
    segment: segmentSchema.default({ conditions: [] }),
    delayMinutes: z.number().int().min(0).max(MAX_DELAY_MINUTES).default(0),
    channel: z.enum(NUDGE_CHANNELS).default('EMAIL'),
    subjectEn: text(MAX_SUBJECT),
    subjectTr: text(MAX_SUBJECT),
    subjectDe: text(MAX_SUBJECT),
    bodyEn: text(MAX_BODY),
    bodyTr: text(MAX_BODY),
    bodyDe: text(MAX_BODY),
    maxPerUserPer30Days: z.number().int().min(1).max(10).default(2),
    cooldownDays: z.number().int().min(0).max(90).default(7),
  })
  .strict();
export type NudgeRuleInput = z.infer<typeof nudgeRuleInputSchema>;

export type NudgeRuleInputResult =
  | { ok: true; rule: NudgeRuleInput; missingLocales: NudgeLocale[] }
  | { ok: false; code: 'invalid' | 'stage_trigger' | 'outcome_stage' | 'no_message'; issues: string[] };

function bodyOf(rule: Pick<NudgeRuleInput, 'bodyEn' | 'bodyTr' | 'bodyDe'>, l: NudgeLocale): string | null | undefined {
  return l === 'en' ? rule.bodyEn : l === 'tr' ? rule.bodyTr : rule.bodyDe;
}
function subjectOf(rule: Pick<NudgeRuleInput, 'subjectEn' | 'subjectTr' | 'subjectDe'>, l: NudgeLocale): string | null | undefined {
  return l === 'en' ? rule.subjectEn : l === 'tr' ? rule.subjectTr : rule.subjectDe;
}

/** Languages with no usable message: a body, and for mail a subject. */
export function missingLocales(rule: Pick<NudgeRuleInput, 'bodyEn' | 'bodyTr' | 'bodyDe' | 'subjectEn' | 'subjectTr' | 'subjectDe' | 'channel'>): NudgeLocale[] {
  const needsSubject = rule.channel !== 'IN_APP';
  return NUDGE_LOCALES.filter((l) => !bodyOf(rule, l)?.trim() || (needsSubject && !subjectOf(rule, l)?.trim()));
}

/**
 * THE write-time gate. `isOutcomeStage` answers for the rule's own org.
 * A rule with a missing language is stored but reported (`missingLocales`) —
 * the editor flags it, and a recipient in that language gets the English text
 * (or the first written one) rather than nothing. A rule with NO language at
 * all is refused.
 */
export function parseNudgeRuleInput(input: unknown, isOutcomeStage: (key: string) => boolean): NudgeRuleInputResult {
  // The stage engine's triggers get their own answer, before the generic schema error.
  const rawEvent = (input as { trigger?: { event?: unknown } } | null)?.trigger?.event;
  if (typeof rawEvent === 'string' && (STAGE_EVENTS as readonly string[]).includes(rawEvent)) {
    return { ok: false, code: 'stage_trigger', issues: ['trigger: stage-change rules are stage automations (/admin/automations), not nudges'] };
  }
  const parsed = nudgeRuleInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'invalid', issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const rule = parsed.data;
  for (const c of rule.segment.conditions) {
    if (c.field === 'stage' && c.op === 'in' && c.value.some(isOutcomeStage)) {
      return { ok: false, code: 'outcome_stage', issues: ['segment: a nudge may not target an outcome stage — that message is the mentor\'s to write'] };
    }
  }
  const missing = missingLocales(rule);
  if (missing.length === NUDGE_LOCALES.length) {
    return { ok: false, code: 'no_message', issues: ['body: write the message in at least one language'] };
  }
  return { ok: true, rule, missingLocales: missing };
}

/** A stored rule read back; null when its JSON no longer parses (the evaluator skips it). */
export function readStoredNudge(row: { trigger: unknown; segment: unknown }): { trigger: NudgeTrigger; segment: Segment } | null {
  const trigger = triggerSchema.safeParse(row.trigger);
  const segment = segmentSchema.safeParse(row.segment ?? { conditions: [] });
  if (!trigger.success || !segment.success) return null;
  return { trigger: trigger.data, segment: segment.data };
}

/** The message for a reader: their language, else English, else the first one written. */
export function messageFor(
  rule: Pick<NudgeRuleInput, 'bodyEn' | 'bodyTr' | 'bodyDe' | 'subjectEn' | 'subjectTr' | 'subjectDe'>,
  locale: string | null | undefined,
): { locale: NudgeLocale; subject: string; body: string } | null {
  const want = (NUDGE_LOCALES as readonly string[]).includes(locale ?? '') ? (locale as NudgeLocale) : 'en';
  const order: NudgeLocale[] = [want, ...NUDGE_LOCALES.filter((l) => l !== want)];
  for (const l of order) {
    const body = bodyOf(rule, l)?.trim();
    if (body) return { locale: l, body, subject: subjectOf(rule, l)?.trim() || '' };
  }
  return null;
}

/** `{name}` is the one placeholder: the reader's first name. Nothing is evaluated. */
export function fillMessage(text: string, fullName: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return text.split('{name}').join(first);
}

// ── The per-person decision ─────────────────────────────────────────────────

export const DROP_REASONS = ['unsubscribed', 'cap', 'cooldown', 'dormancy', 'outcome', 'already_sent'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** What the evaluator knows about one candidate. Computed server-side. */
export interface RecipientFacts {
  userId: string;
  name: string | null;
  role: 'MENTOR' | 'MENTEE';
  /** May this person receive the channel? false when e-mail AND in-app are both off for them. */
  reachable: boolean;
  /** A relation of theirs (as mentee) is a dormant first contact. */
  dormant: boolean;
  /** An active relation of theirs (as mentee) stands at an outcome stage. */
  atOutcome: boolean;
  /** Instants of the nudges they received in this org, any rule, newest first is not required. */
  recentSends: Date[];
  /** This rule already sent them this dedupe key. */
  alreadySent: boolean;
}

export interface Plan {
  send: RecipientFacts[];
  dropped: Record<DropReason, number>;
}

/** The first reason a person is dropped, in a fixed order, or null to send. */
export function dropReason(
  f: RecipientFacts,
  rule: { maxPerUserPer30Days: number; cooldownDays: number },
  now: Date,
): DropReason | null {
  // Hard limits first: they hold whatever the rule says.
  if (f.role === 'MENTEE' && f.dormant) return 'dormancy';
  if (f.role === 'MENTEE' && f.atOutcome) return 'outcome';
  if (f.alreadySent) return 'already_sent';
  if (!f.reachable) return 'unsubscribed';
  const t = now.getTime();
  if (rule.cooldownDays > 0 && f.recentSends.some((s) => t - s.getTime() < rule.cooldownDays * 86_400_000)) return 'cooldown';
  const last30 = f.recentSends.filter((s) => t - s.getTime() < 30 * 86_400_000).length;
  if (last30 >= rule.maxPerUserPer30Days) return 'cap';
  return null;
}

export function planRecipients(
  candidates: readonly RecipientFacts[],
  rule: { maxPerUserPer30Days: number; cooldownDays: number },
  now: Date,
): Plan {
  const dropped = Object.fromEntries(DROP_REASONS.map((r) => [r, 0])) as Record<DropReason, number>;
  const send: RecipientFacts[] = [];
  for (const c of candidates) {
    const why = dropReason(c, rule, now);
    if (why) dropped[why] += 1;
    else send.push(c);
  }
  return { send, dropped };
}

/** The dedupe key a send is stored under: one per event, or one per scan rule ever. */
export function dedupeKeyFor(trigger: NudgeTrigger, eventId?: string | null): string {
  return trigger.kind === 'event' ? `evt:${eventId ?? ''}` : 'scan';
}

/** `Job.idempotencyKey` of one send. */
export function nudgeSendJobKey(ruleId: string, userId: string, dedupeKey: string): string {
  return `nudge:${ruleId}:${userId}:${dedupeKey}`;
}
