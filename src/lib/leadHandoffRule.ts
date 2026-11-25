// Handing a lead to a colleague from the board (the rep strip above the sales
// and admin boards): drop a card on a person, say what they should do next.
//
// WHAT IT IS. One write with two halves, both existing rules:
//   • the owner changes through the ONE transfer operation
//     (src/lib/mentorTransfer.ts, docs/mentor-transfer.md) — 'corrected' in
//     place when the record has no history, 'transferred' with a successor
//     otherwise — never a hand-rolled `mentorId` update;
//   • the instruction lands in the record's follow-up columns
//     (src/lib/nextActionRule.ts): the new owner is reminded on the day and
//     the record joins their attention queue from the day after. A hand-off is
//     therefore not a second task system; it is "your record now, and this is
//     its next step".
//
// The lead never hears about it: who works a deal inside the seller's team is
// not the prospect's business, so the transfer runs with the mentee side quiet.
//
// Dependency-free (no `@/` imports) so scripts/test/lead-handoff-rule.test.mjs
// can load it under plain `node --experimental-strip-types`.

/** The quick picks in the dialog. `other` is the free-text one. */
export const HANDOFF_ACTIONS = ['call', 'email', 'meeting', 'demo', 'other'] as const;

export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export function isHandoffAction(value: unknown): value is HandoffAction {
  return typeof value === 'string' && (HANDOFF_ACTIONS as readonly string[]).includes(value);
}

/**
 * The reason code the transfer records on the closed predecessor
 * (`endReasonCode`). Its own code rather than borrowing an admin one: "a
 * colleague passed it on" is neither a mis-assignment nor a mentor who left,
 * and a report that cannot tell them apart answers neither question.
 */
export const SALES_HANDOFF_REASON = 'sales_handoff';

/** Same width as the follow-up note column it is written into. */
export const HANDOFF_NOTE_MAX = 280;

export type HandoffNoteResult =
  | { ok: true; value: string }
  | { ok: false; error: 'note_required' | 'too_long' };

/**
 * The follow-up note the new owner reads: the picked action's label, then the
 * sender's words if any — "Call: ask about the pricing tier". `other` IS the
 * words, so it needs some. Over the column width is refused, never cut: a
 * truncated instruction is a wrong one.
 */
export function composeHandoffNote(action: HandoffAction, actionLabel: string, note: string | null | undefined): HandoffNoteResult {
  const text = (note ?? '').trim().replace(/\s+/g, ' ');
  if (action === 'other' && !text) return { ok: false, error: 'note_required' };
  const value = action === 'other' ? text : text ? `${actionLabel.trim()}: ${text}` : actionLabel.trim();
  if (value.length > HANDOFF_NOTE_MAX) return { ok: false, error: 'too_long' };
  return { ok: true, value };
}

/** Today as `YYYY-MM-DD` in UTC — the dialog's default due day. */
export function todayIso(now: Date | number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The interaction a hand-off's quick pick turns into once it is done (#3821):
 * "Complete follow-up" opens the interaction form on this type. A demo is held
 * as a meeting; `other` has no type of its own and is not listed (the form's
 * default, a call, applies). Plain strings — keys of the `InteractionType` enum
 * (src/lib/interactionTypes.ts), kept dependency-free here.
 */
export const HANDOFF_INTERACTION_TYPE = {
  call: 'Call',
  email: 'Email',
  meeting: 'Meeting',
  demo: 'Meeting',
} as const satisfies Partial<Record<HandoffAction, string>>;

export type HandoffInteractionType = (typeof HANDOFF_INTERACTION_TYPE)[keyof typeof HANDOFF_INTERACTION_TYPE];

/**
 * Which quick pick a follow-up note was composed from, read back from the note
 * (#3821). The hand-off stores only the composed text (`composeHandoffNote`:
 * the label alone, or `label: note`), in the SENDER's language, so every
 * locale's labels are tried — the longest first, so a label that is a prefix
 * of another cannot shadow it. A note that starts with no label (`other`, or a
 * follow-up the owner wrote themselves) is null.
 */
export function handoffActionFromNote(
  note: string | null | undefined,
  labelsByLocale: readonly Readonly<Record<HandoffAction, string>>[],
): Exclude<HandoffAction, 'other'> | null {
  const text = (note ?? '').trim();
  if (!text) return null;
  const candidates: { action: Exclude<HandoffAction, 'other'>; label: string }[] = [];
  for (const labels of labelsByLocale) {
    for (const action of Object.keys(HANDOFF_INTERACTION_TYPE) as Exclude<HandoffAction, 'other'>[]) {
      const label = labels[action]?.trim();
      if (label) candidates.push({ action, label });
    }
  }
  candidates.sort((a, b) => b.label.length - a.label.length);
  const hit = candidates.find(({ label }) => text === label || text.startsWith(`${label}:`));
  return hit?.action ?? null;
}

/**
 * `MentorshipRelation.nextActionType` for a follow-up write (#3900): the pick
 * the writer sent, else the pick the note's label names, else null (a step in
 * free text says nothing about what it is). A note of null is no step at all.
 * The deploy backfill (prisma/backfill-next-action-type.mjs) applies the same
 * reading to the rows written before the column; the unit test keeps the two
 * in step.
 */
export function nextActionTypeFor(
  explicit: HandoffAction | null | undefined,
  note: string | null | undefined,
  labelsByLocale: readonly Readonly<Record<HandoffAction, string>>[],
): HandoffAction | null {
  if (explicit) return explicit;
  return handoffActionFromNote(note, labelsByLocale);
}

/**
 * The interaction type "Complete follow-up" opens with: the stored pick
 * (#3900), else the one the note's label names (rows the backfill has not
 * reached), else a call.
 */
export function followUpInteractionType(
  note: string | null | undefined,
  labelsByLocale: readonly Readonly<Record<HandoffAction, string>>[],
  stored?: string | null,
): HandoffInteractionType {
  const action = isHandoffAction(stored) ? stored : handoffActionFromNote(note, labelsByLocale);
  return action && action !== 'other' ? HANDOFF_INTERACTION_TYPE[action] : 'Call';
}

/**
 * The follow-up's own words, without the pick label a hand-off composed into it
 * (#3903): "Call: ask about pricing" → "ask about pricing", "Call" → "". The
 * sales follow-up panel shows the pick as its own label (from
 * `nextActionType`, in the reader's language) and edits the words alone, so
 * the label must not be shown — or saved back — twice. Every locale's labels
 * are tried, as in `handoffActionFromNote`; a note with no leading label is
 * returned as it is.
 */
export function handoffNoteText(
  note: string | null | undefined,
  labelsByLocale: readonly Readonly<Record<HandoffAction, string>>[],
): string {
  const text = (note ?? '').trim();
  if (!text) return '';
  const labels = labelsByLocale
    .flatMap((l) => (Object.keys(HANDOFF_INTERACTION_TYPE) as Exclude<HandoffAction, 'other'>[]).map((a) => l[a]?.trim()))
    .filter((l): l is string => !!l)
    .sort((a, b) => b.length - a.length);
  for (const label of labels) {
    if (text === label) return '';
    if (text.startsWith(`${label}:`)) return text.slice(label.length + 1).trim();
  }
  return text;
}

/**
 * The one check both follow-up forms make before they write (#3903): `other`
 * IS the words, so it needs some — the same `note_required` the hand-off
 * route answers.
 */
export function followUpNoteMissing(action: HandoffAction | null | undefined, note: string | null | undefined): boolean {
  return action === 'other' && !(note ?? '').trim();
}
