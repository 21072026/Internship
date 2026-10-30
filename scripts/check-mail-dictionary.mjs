#!/usr/bin/env node
// Guard: mail copy is read through emailDictionary(locale, orgId) (#1631).
//
// WHY THIS EXISTS
//   A page's dictionary carries the reader's vertical overlay and the org's own
//   terminology (#1629, src/lib/terminology.ts). A mail has no request, so it
//   gets the same thing only by asking emailDictionary(locale, orgId) — or
//   emailDictionaryMemo() in a sweep — for the RECIPIENT's org. A bare
//   getDictionary(locale) in a mail compiles, renders and passes every test,
//   while a tenant that renamed "mentor" to "coach" reads "your mentor" in its
//   inbox.
//
// WHAT IT CHECKS
//   Every tracked source file under src/ that calls sendEmail( is searched for
//   bare getDictionary( calls. The count per file is a RATCHET pinned in
//   PINNED below: the remaining calls read copy that names no role (sign-in
//   links, times, the unsubscribe footer, …) or have no org to ask about. A new
//   one fails the check; removing one fails it too until the literal is
//   lowered in the same diff, so the number only goes down.
//
// Run: npm run check:mail-dictionary
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PINNED = new Map([
  ['src/services/emailService.ts', 23],
  ['src/lib/announcementMail.ts', 1],
  ['src/lib/newsletterDispatch.ts', 1],
  ['src/lib/outcomeComms.server.ts', 1],
  ['src/lib/securityNotices.ts', 1],
]);

// Spelled in halves so this file does not match itself.
const BARE = new RegExp('\\b' + 'getDictionary' + '\\(', 'g');
const SENDS = 'send' + 'Email(';

const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f));

const errors = [];
const seen = new Set();
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!text.includes(SENDS)) continue;
  const count = (text.match(BARE) ?? []).length;
  if (count === 0) continue;
  seen.add(file);
  const pinned = PINNED.get(file) ?? 0;
  if (count > pinned) {
    errors.push(
      `${file}: ${count} bare getDictionary() call(s), the ratchet allows ${pinned}. Read mail copy through emailDictionary(locale, orgId) (or emailDictionaryMemo() in a sweep) for the recipient's org.`,
    );
  } else if (count < pinned) {
    errors.push(`${file}: only ${count} bare getDictionary() call(s) left — lower its PINNED entry in scripts/check-mail-dictionary.mjs to ${count} in this diff.`);
  }
}
for (const [file, pinned] of PINNED) {
  if (!seen.has(file) && pinned > 0) errors.push(`${file}: no bare getDictionary() call left — delete its PINNED entry.`);
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`mail dictionary OK — ${seen.size} mailing file(s) still read bare copy, all within the ratchet (${[...PINNED.values()].reduce((a, b) => a + b, 0)} pinned).`);
