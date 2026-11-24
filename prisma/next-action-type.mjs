// What a follow-up note says its step is (#3900) — the plain-ESM mirror of
// handoffActionFromNote() in src/lib/leadHandoffRule.ts, for the deploy
// backfill (Node 20 on the server cannot import TypeScript).
//
// A hand-off writes its quick pick into the note as "<label>" or
// "<label>: <text>", in the language of the person it went to. LABELS is every
// locale's `leadHandoff.actions` from src/i18n/dictionaries.ts minus `other`
// (a free-text step names no pick). scripts/test/next-action-type.test.mjs
// fails when these drift from the dictionary or when the two readings disagree
// — change both in one commit.

export const LABELS = [
  { call: 'Call', email: 'Send an e-mail', meeting: 'Book an appointment', demo: 'Give an app demo' },
  { call: 'Telefonla aranacak', email: 'E-posta atılacak', meeting: 'Randevu yapılacak', demo: 'Uygulama demosu yapılacak' },
  { call: 'Anrufen', email: 'E-Mail senden', meeting: 'Termin vereinbaren', demo: 'App-Demo zeigen' },
];

/** The pick a note's label names, else null. Longest label first, like the TS rule. */
export function actionFromNote(note) {
  const text = (note ?? '').trim();
  if (!text) return null;
  const candidates = [];
  for (const labels of LABELS) {
    for (const [action, label] of Object.entries(labels)) candidates.push({ action, label: label.trim() });
  }
  candidates.sort((a, b) => b.label.length - a.label.length);
  const hit = candidates.find(({ label }) => text === label || text.startsWith(`${label}:`));
  return hit ? hit.action : null;
}
