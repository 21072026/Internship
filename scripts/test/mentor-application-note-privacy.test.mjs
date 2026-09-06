import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// MentorApplication.adminNote is private admin commentary about a person who
// applied to mentor (#1806). The hard constraint on it is that it never leaves
// the admin UI — above all, that no e-mail template can render it into a
// message addressed to the applicant, who would then read what an admin wrote
// about them internally.
//
// Nothing in the type system enforces that: `adminNote` is just another string
// on the row, and a future "include the note so the reply has context" change
// would compile, pass every runtime test and only be discovered by the person
// who received it. So the invariant is asserted here, at the file level, the
// same way the other one-way rules in this repo are guarded.
//
// If this test fails, the fix is to remove the reference — not to widen the
// test. If a decision genuinely needs to be explained to an applicant, that is
// what `rejectReason` (already written for that audience's benefit, and still
// only ever summarised into a general decline) exists for.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Every .ts/.tsx file under src/, repo-relative and slash-separated. */
function sourceFiles(dir = 'src') {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * The body of a top-level `export async function <name>(...)`, brace-matched.
 *
 * Deliberately not `indexOf('\n}', start)`: these senders open with a
 * multi-line parameter destructure whose closing line is `}: {` at column 0, so
 * that naive scan stops after the parameter NAMES — 95 characters, never
 * reaching the template — and every forbidden-word assertion below it passes
 * vacuously. That is exactly how this file previously checked nothing.
 */
function functionBody(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);

  // Walk the parameter list first so its braces (destructure + type literal)
  // cannot be mistaken for the body's.
  let i = source.indexOf('(', start);
  assert.notEqual(i, -1, `${name} has no parameter list`);
  let parens = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') parens++;
    else if (source[i] === ')' && --parens === 0) break;
  }
  assert.ok(parens === 0 && i < source.length, `${name}'s parameter list is unbalanced`);

  const open = source.indexOf('{', i);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(open, j + 1);
  }
  throw new Error(`${name}'s body is unbalanced — could not brace-match it`);
}

test('no file that composes an e-mail reads adminNote', () => {
  // emailService.ts is not the only place HTML gets built: ~10 routes and libs
  // call sendEmail() with their own markup, and a "reply to the applicant with
  // context" route pasted into any of them would leak the note just as well.
  // So the scan follows the callers, and picks up new ones automatically.
  const senders = sourceFiles().filter((f) => read(f).includes('sendEmail('));
  assert.ok(
    senders.length >= 8,
    `expected to find the e-mail-composing files by their sendEmail( call, found ${senders.length} — did the helper get renamed? Fix the discovery, do not lower this bound`,
  );

  const leaking = senders.filter((f) => read(f).includes('adminNote'));
  assert.deepEqual(
    leaking,
    [],
    `these files compose e-mail and reference MentorApplication.adminNote: ${leaking.join(', ')}`,
  );
});

test('the rejection e-mail is built from the decision alone, not from stored free text', () => {
  const emailService = read('src/services/emailService.ts');
  const body = functionBody(emailService, 'sendMentorApplicationRejectedEmail');

  // Guard the slice itself: the bug this replaced was a body that scanned
  // clean because it was 95 characters of parameter names. If the extraction
  // ever silently shrinks again, fail here rather than pass vacuously.
  assert.ok(
    body.length > 400,
    `extracted only ${body.length} chars of sendMentorApplicationRejectedEmail — the body was not captured`,
  );
  assert.ok(
    body.includes('sendEmail({') && body.includes('html:'),
    'the extracted slice does not contain the sendEmail call and its html template — it is not the whole body',
  );

  // Its whole input surface: who it goes to, their name, the locale and the
  // tenant it is branded as. No application text of any kind is passed in, so
  // there is nothing for it to leak.
  for (const forbidden of ['adminNote', 'rejectReason', 'reason', 'note']) {
    assert.equal(
      body.includes(forbidden),
      false,
      `sendMentorApplicationRejectedEmail must not mention "${forbidden}" — the applicant gets a general decline`,
    );
  }
});

test('the decide route never loads adminNote into the branch that sends mail', () => {
  const route = read('src/app/api/mentor-applications/[id]/route.ts');
  const start = route.indexOf('const application = await prisma.mentorApplication.findUnique({\n      where: { id },');
  assert.notEqual(start, -1, 'the PATCH handler\'s application lookup was not found — did its shape change?');
  const select = route.slice(start, route.indexOf('});', start));
  for (const forbidden of ['adminNote', 'rejectReason']) {
    assert.equal(
      select.includes(forbidden),
      false,
      `the PATCH handler must not select "${forbidden}" — the e-mail senders read this object`,
    );
  }
});
