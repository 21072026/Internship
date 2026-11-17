// What changed about a record's follow-up, as ONE event (#3819).
//
// A follow-up is two columns on MentorshipRelation (`nextActionAt`, a calendar
// day, and `nextActionNote`, one line; src/lib/nextActionRule.ts). Every write
// that touches them leaves one FollowUpEvent row on the record, so its history
// can say "follow-up set for Thursday — call about pricing", "moved to
// Friday", "completed", "cleared", "handed over to X".
//
// Two decisions live here and nowhere else:
//
//  * The diff. Before vs. after, compared by calendar DAY and by trimmed note:
//    nothing → something is ASSIGNED, something → nothing is CLEARED (or
//    COMPLETED when the caller says the follow-up was done — the panel's
//    "Complete" clears it only once the interaction it opens is saved), any
//    other difference is CHANGED, and no difference is no event at all. So a
//    resend of what is already stored writes nothing.
//
//  * The dedupe key. It is built from the record's `updatedAt` BEFORE the
//    write plus the transition, so two copies of the same request racing each
//    other (a double click, a client retry) read the same row, build the same
//    key and land on the unique (relationId, dedupeKey) once — while the same
//    transition made again later, after anything else changed the record,
//    builds a new key.
//
// The row stores facts, never a sentence: each reader renders it in their own
// language. Dependency-free (no `@/` imports, no Prisma) so
// scripts/test/follow-up-event-rule.test.mjs imports it under plain node.

export const FOLLOW_UP_EVENT_KINDS = ['ASSIGNED', 'CHANGED', 'CLEARED', 'COMPLETED', 'HANDED_OFF'] as const;
export type FollowUpEventKind = (typeof FOLLOW_UP_EVENT_KINDS)[number];

export function isFollowUpEventKind(value: unknown): value is FollowUpEventKind {
  return typeof value === 'string' && (FOLLOW_UP_EVENT_KINDS as readonly string[]).includes(value);
}

export interface FollowUpState {
  at: Date | null;
  note: string | null;
}

export interface FollowUpEventFacts {
  kind: FollowUpEventKind;
  fromAt: Date | null;
  toAt: Date | null;
  fromNote: string | null;
  toNote: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function day(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / DAY_MS) : null;
}

function note(n: string | null | undefined): string | null {
  const t = (n ?? '').trim();
  return t ? t : null;
}

function empty(s: FollowUpState): boolean {
  return !s.at && !note(s.note);
}

/**
 * The event one edit makes, or null when the follow-up did not change.
 * `after` is the state the write leaves behind (unsent fields already merged).
 */
export function followUpEventFor(
  before: FollowUpState,
  after: FollowUpState,
  opts: { completed?: boolean } = {}
): FollowUpEventFacts | null {
  const facts = {
    fromAt: before.at,
    toAt: after.at,
    fromNote: note(before.note),
    toNote: note(after.note),
  };
  if (day(before.at) === day(after.at) && facts.fromNote === facts.toNote) return null;
  if (empty(before)) return { kind: 'ASSIGNED', ...facts };
  if (empty(after)) return { kind: opts.completed ? 'COMPLETED' : 'CLEARED', ...facts };
  return { kind: 'CHANGED', ...facts };
}

/** The idempotency key of one event; see the header. */
export function followUpDedupeKey(
  facts: FollowUpEventFacts,
  recordUpdatedAt: Date,
  owners: { from?: string | null; to?: string | null } = {}
): string {
  const parts = [
    facts.kind,
    recordUpdatedAt.toISOString(),
    day(facts.fromAt) ?? '-',
    day(facts.toAt) ?? '-',
    owners.from ?? '-',
    owners.to ?? '-',
  ];
  // Notes are left out on purpose: they are up to 280 characters and the key
  // column is 191. Two different notes on the same stale read are the same
  // racing request in practice; the day and kind already split real edits.
  return `followup:${parts.join(':')}`.slice(0, 191);
}
