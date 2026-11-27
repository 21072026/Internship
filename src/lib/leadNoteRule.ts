// A free note on a sales record (#3978): the rule, dependency-free so
// scripts/test/lead-note-rule.test.mjs loads it under plain node.
//
// WHO may add one: whoever may work the record (its owner, the org's sales
// dispatcher, an admin with relation.write — canWriteSalesRecord), and anyone
// who OWNED it before and handed it on. The second is the reason the note
// exists: a rep hears news about a lead they gave away and must be able to
// tell the person who has it now. A note is never a write to the record
// itself — no stage, no follow-up, no owner change.
//
// WHAT it is: one line in the record's history (FollowUpEvent kind NOTE),
// with its author and time. It is NOT a contact: the last-contact rule, the
// interaction counters and the billing meter read InteractionLog, and a note
// is written there never (docs/last-contact.md).

/** The column the note lives in is FollowUpEvent.toNote, VarChar(280). */
export const LEAD_NOTE_MAX = 280;

export type ParsedLeadNote = { ok: true; text: string } | { ok: false; code: 'empty' | 'too_long' };

/** Trimmed, inner runs of spaces kept as typed (line breaks too); 1…280 characters. */
export function parseLeadNote(raw: unknown): ParsedLeadNote {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, code: 'empty' };
  if ([...text].length > LEAD_NOTE_MAX) return { ok: false, code: 'too_long' };
  return { ok: true, text };
}

export function mayAddLeadNote(facts: { writable: boolean; previousOwner: boolean }): boolean {
  return facts.writable || facts.previousOwner;
}

/** Whether the record's current owner hears about the note: never about their own. */
export function noteNotifiesOwner(facts: { authorId: string; ownerId: string }): boolean {
  return facts.authorId !== facts.ownerId;
}

function hash(text: string): string {
  // djb2, hex: only a dedupe key, never a secret.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * The dedupe key: the same author and text within the same minute is one note
 * (a double click, a retried request); the same words a minute later are a
 * second note on purpose.
 */
export function leadNoteDedupeKey(authorId: string, text: string, now: Date): string {
  return `note:${authorId}:${Math.floor(now.getTime() / 60_000)}:${hash(text)}`;
}
