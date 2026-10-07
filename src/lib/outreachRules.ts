// Grounded outreach drafts (#2048, part 2) — the pure half: which moment a
// relation is at, what facts the draft may be grounded in, and the bulk limits.
// No provider, no database; scripts/test/outreach-rules.test.mjs pins it.
//
// THE HARD RULE. A draft is text a person edits and sends. Nothing here, in
// src/lib/aiOutreach.ts or in the routes that serve them can send a message;
// the crons that DO send (the dormant check-ins, the outcome auto-send) never
// import an AI module, and scripts/test/ai-never-autosend.test.mjs fails the
// build if one ever does. `outcomeAutoSend` stays what it was: the switch for
// the TEMPLATED outcome mail — an AI draft is never eligible for it.

export const OUTREACH_MOMENTS = ['first_message', 'dormant_nudge', 'outcome_note'] as const;
export type OutreachMoment = (typeof OUTREACH_MOMENTS)[number];

/** One bulk draft is ONE provider call, personalised by `{name}` per recipient. */
export const BULK_DRAFT_MAX_RECIPIENTS = 200;
export const BULK_DRAFT_COST_CALLS = 1;
export const BULK_PURPOSE_MAX = 500;

export interface OutreachFacts {
  menteeFirstName: string;
  stageLabel: string;
  /** In the org's first pipeline stage — nothing has started yet. */
  firstStage: boolean;
  /** Stamped by the dormant sweep (docs/dormant-first-contacts.md). */
  dormant: boolean;
  /** 'placedElsewhere' | 'noMatch' when the relation sits on an outcome stage. */
  outcome: string | null;
  /** Goals the MENTOR may read (goalVisibilityRule) — never a mentee's private one. */
  openGoals: string[];
  lastMeetingAt: string | null;
  lastMessageAt: string | null;
  /** Has the mentor (or an admin) ever written to this mentee? */
  mentorHasWritten: boolean;
}

/**
 * The moment a relation is at, when the caller did not name one: an outcome
 * stage first (that is the message that must not go wrong), then a dormant
 * relation, else the first message — which is also the honest default for a
 * thread that is simply quiet.
 */
export function pickMoment(f: Pick<OutreachFacts, 'outcome' | 'dormant' | 'mentorHasWritten'>): OutreachMoment {
  if (f.outcome) return 'outcome_note';
  if (f.dormant) return 'dormant_nudge';
  return 'first_message';
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'none');

/**
 * The facts block the prompt is grounded in — and the ONLY facts it gets: no
 * e-mail address, no notes, no private goal. Stable line order, so the same
 * facts hash the same (the artefact cache key).
 */
export function factsBlock(f: OutreachFacts): string {
  return [
    `First name: ${f.menteeFirstName}`,
    `Current stage: ${f.stageLabel}${f.firstStage ? ' (first stage — nothing has started yet)' : ''}`,
    `Outcome: ${f.outcome ?? 'none'}`,
    `Quiet for a while (dormant): ${f.dormant ? 'yes' : 'no'}`,
    `Open goals: ${f.openGoals.length ? f.openGoals.slice(0, 3).join('; ') : 'none'}`,
    `Last meeting: ${day(f.lastMeetingAt)}`,
    `Last message in the thread: ${day(f.lastMessageAt)}`,
    `The mentor has written before: ${f.mentorHasWritten ? 'yes' : 'no'}`,
  ].join('\n');
}

/** First word of a full name — the draft greets a person, not a record. */
export function firstName(fullName: string | null | undefined): string {
  return (fullName ?? '').trim().split(/\s+/)[0] || '';
}

/** A bulk request the server refuses before any provider call. */
export function bulkRefusal(recipientCount: number): 'no_recipients' | 'batch_too_large' | null {
  if (!Number.isInteger(recipientCount) || recipientCount < 1) return 'no_recipients';
  if (recipientCount > BULK_DRAFT_MAX_RECIPIENTS) return 'batch_too_large';
  return null;
}

/** The merge field the bulk route fills per recipient (src/app/api/mentor/email). */
export const NAME_FIELD = '{name}';

export interface Draft {
  subject: string;
  body: string;
}

/** The model's JSON, or a body-only draft when it answered in prose. */
export function parseDraft(text: string): Draft {
  try {
    const d = JSON.parse(text) as Partial<Draft>;
    if (typeof d.body === 'string') return { subject: typeof d.subject === 'string' ? d.subject.trim() : '', body: d.body.trim() };
  } catch { /* fall through */ }
  return { subject: '', body: text.trim() };
}
