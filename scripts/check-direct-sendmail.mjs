#!/usr/bin/env node
// Guard: mail leaves the app through ONE door (#2944).
//
// WHY THIS EXISTS
//   Every mail the app sends shares one relay allowance, one send budget
//   (`MailBudget`), one lane taxonomy, one opt-out gate and one retry queue —
//   and all of that lives behind `sendEmail()` in src/services/emailService.ts.
//   A transporter's own sendMail call anywhere else compiles, delivers in a test and
//   looks fine, while skipping the budget (so it can trip the relay's throttle
//   for everybody), the queue (so a temporary refusal loses the mail), the
//   unsubscribe gate and the EmailLog row. Nothing else would notice.
//
// WHAT IT CHECKS
//   Every tracked source file (.ts .tsx .js .mjs .cjs) outside node_modules is
//   searched for the call. It may appear only in the files listed in
//   ALLOWED, each with its reason. The list cannot rot: an allowed file that no
//   longer contains the call fails too, asking for its line to be deleted.
//
// Run: npm run check:direct-sendmail
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Map([
  ['src/services/emailService.ts', 'the transmit module itself: the only place the app hands a mail to SMTP'],
  [
    'scripts/send-alert-email.mjs',
    'GitHub Actions deploy/uptime alerts: runs on a runner, outside the app and its database, so it has no queue or budget to go through',
  ],
  ['scripts/e2e-report-email.mjs', 'GitHub Actions e2e report: runs on a runner, outside the app'],
  ['scripts/k6-report-email.mjs', 'GitHub Actions load-test report: runs on a runner, outside the app'],
]);

// Spelled in two halves so this file does not match itself.
const NEEDLE = '.send' + 'Mail(';
const CODE = /\.(?:ts|tsx|js|mjs|cjs)$/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && CODE.test(f) && !f.includes('node_modules/'));

const offenders = [];
const seen = new Set();
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  if (!text.includes(NEEDLE)) continue;
  seen.add(file);
  if (ALLOWED.has(file)) continue;
  text.split('\n').forEach((line, i) => {
    if (line.includes(NEEDLE)) offenders.push(`${file}:${i + 1}`);
  });
}

const stale = [...ALLOWED.keys()].filter((f) => !seen.has(f));

if (offenders.length || stale.length) {
  if (offenders.length) {
    console.error('A mail is handed to SMTP outside src/services/emailService.ts:');
    for (const o of offenders) console.error(`  ${o}`);
    console.error(
      '\nSend it with sendEmail() instead — that is what applies the send budget, the retry queue, the opt-out gate and the EmailLog row (docs/mail-queue.md).',
    );
  }
  if (stale.length) {
    console.error(`Allowed in scripts/check-direct-sendmail.mjs but no longer calling ${NEEDLE} — delete the entry:`);
    for (const f of stale) console.error(`  ${f}`);
  }
  process.exit(1);
}

console.log(`direct sendMail OK — ${files.length} file(s) scanned; ${NEEDLE} only in the ${ALLOWED.size} allowed file(s).`);
