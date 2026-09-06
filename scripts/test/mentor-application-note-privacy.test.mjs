import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('no e-mail template reads adminNote', () => {
  const emailService = read('src/services/emailService.ts');
  assert.equal(
    emailService.includes('adminNote'),
    false,
    'src/services/emailService.ts must never reference MentorApplication.adminNote',
  );
});

test('the rejection e-mail is built from the decision alone, not from stored free text', () => {
  const emailService = read('src/services/emailService.ts');
  const start = emailService.indexOf('export async function sendMentorApplicationRejectedEmail');
  assert.notEqual(start, -1, 'sendMentorApplicationRejectedEmail not found — was it renamed?');
  const body = emailService.slice(start, emailService.indexOf('\n}', start));

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
