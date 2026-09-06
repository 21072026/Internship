// The runtime half of #1720. `system-mail-i18n.unit.spec.ts` proves the
// dictionaries are complete and the fragments follow their locale; that is a
// pure-string exercise and it cannot see the two places the language is
// actually *decided* at run time:
//
//   1. an invitation, where the choice is made by the inviter, written to a
//      column, and replayed on every later resend, and
//   2. a digest, where the choice is a `User.preferredLanguage` that three of
//      the queries were not even selecting — the real bug behind "the digest is
//      always English".
//
// Both need a database, so they live here rather than in the unit spec. The
// Playwright config blanks SMTP_USER, so every send short-circuits to a SKIPPED
// EmailLog row — which still records the SUBJECT, and the subject is enough to
// name the language a mail went out in.
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { sendUnreadMessageDigests } from '@/services/emailService';
import { getDictionary } from '@/i18n/dictionaries';

// The digest builds "mark as read" links with an HMAC, and requireServerSecret()
// throws when NEXTAUTH_SECRET is unset (#870). The runner process does not
// necessarily inherit the app server's env, and the token is only rendered here,
// never followed — any value will do. Same guard as system-mail-i18n.unit.spec.ts.
process.env.NEXTAUTH_SECRET ||= 'e2e-mail-language-secret';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an invitation keeps the language its inviter chose, resend included', async ({ page }) => {
  const email = uniqueEmail('inv-locale');
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const created = await page.request.post('/api/invite', {
      data: { role: 'MENTEE', email, locale: 'tr' },
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    // The choice is persisted, not recomputed: a resend happens days later and
    // often from a different admin's account, whose own UI language says
    // nothing about what the invitee already received.
    const invite = await prisma.invitationToken.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    expect(invite?.locale).toBe('tr');

    const resent = await page.request.post(`/api/invite/${invite!.id}`);
    expect(resent.ok(), await resent.text()).toBeTruthy();

    const after = await prisma.invitationToken.findUnique({ where: { id: invite!.id } });
    expect(after?.locale).toBe('tr');
    // …and the second mail really was addressed in it. Both sends are SKIPPED
    // rows here, so the subject is the only observable — which is exactly the
    // thing that used to be English.
    const log = await prisma.emailLog.findFirst({
      where: { to: email, category: 'invitation' },
      orderBy: { createdAt: 'desc' },
    });
    // The brand name is whatever this installation is called, so match on the
    // language-bearing half of the template rather than on the whole string.
    const tr = getDictionary('tr').notifications.invitationEmail.subject;
    const en = getDictionary('en').notifications.invitationEmail.subject;
    expect(log, 'no invitation mail was logged for the invitee').not.toBeNull();
    expect(log!.subject).toContain(tr.replace('{brand}', '').trim());
    expect(log!.subject).not.toContain(en.replace('{brand}', '').trim());
  } finally {
    await prisma.emailLog.deleteMany({ where: { to: email } });
    await cleanupByEmail(email);
  }
});

test("an unread-message digest is written in the recipient's own language", async () => {
  const mentorEmail = uniqueEmail('digest-lang-mentor');
  const menteeEmail = uniqueEmail('digest-lang-mentee');
  try {
    const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Digest Lang Mentor');
    const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Digest Lang Mentee');
    // The one input that decides the language of this mail.
    await prisma.user.update({ where: { id: mentee.id }, data: { preferredLanguage: 'de' } });
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    // Unread, undigested and older than the digest's 60-minute grace window —
    // the three conditions the sweep selects on.
    await prisma.message.create({
      data: {
        relationId: relation.id,
        senderId: mentor.id,
        body: 'Kurze Frage zu deinem Praktikum.',
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    await sendUnreadMessageDigests();

    const log = await prisma.emailLog.findFirst({
      where: { to: menteeEmail, category: 'unread-digest' },
      orderBy: { createdAt: 'desc' },
    });
    const de = getDictionary('de').notifications.unreadDigestEmail;
    expect(log, 'no unread-digest was logged for the mentee').not.toBeNull();
    expect(log!.subject).toBe(de.subjectOne);
    // Guard against a "translated" subject that is just the English one.
    expect(log!.subject).not.toBe(getDictionary('en').notifications.unreadDigestEmail.subjectOne);
  } finally {
    await prisma.emailLog.deleteMany({ where: { to: { in: [mentorEmail, menteeEmail] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
