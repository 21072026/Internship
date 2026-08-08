import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1165: the bulk composer's ready-made templates already existed in EN/TR/DE,
// but only the SENDER's locale was ever used — a group of mentees who do not all
// read the same language got whichever one the sender's UI happened to be in.
// Each mentee is now sent the version they read.
//
// The send is asserted through the InteractionLog and the mirrored chat message
// the route writes per recipient, since SMTP does not run in the test env.
test('each mentee is sent the version of the email in their own language', async ({ page }) => {
  const mentorEmail = uniqueEmail('mlmail-mentor');
  const trEmail = uniqueEmail('mlmail-tr');
  const deEmail = uniqueEmail('mlmail-de');
  const stamp = Date.now().toString(36);
  const translations = {
    en: { subject: `EN subject ${stamp}`, body: `Hi {name}, English body ${stamp}` },
    tr: { subject: `TR konu ${stamp}`, body: `Merhaba {name}, Türkçe gövde ${stamp}` },
  };

  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'ML Mail Mentor');
  const trUser = await seedUser(trEmail, 'x', 'MENTEE', 'ML Mail Turkish');
  const deUser = await seedUser(deEmail, 'x', 'MENTEE', 'ML Mail German');
  await prisma.user.update({ where: { id: trUser.id }, data: { preferredLanguage: 'tr' } });
  await prisma.user.update({ where: { id: deUser.id }, data: { preferredLanguage: 'de' } });
  const trRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: trUser.id, status: 'ACTIVE' },
  });
  const deRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: deUser.id, status: 'ACTIVE' },
  });

  try {
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/mentor/email', {
      data: { relationIds: [trRel.id, deRel.id], translations },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).sent).toBe(2);

    // Turkish mentee: the Turkish version, with {name} filled in.
    const trLog = await prisma.interactionLog.findFirstOrThrow({ where: { relationId: trRel.id } });
    expect(trLog.notes).toContain(`TR konu ${stamp}`);
    expect(trLog.notes).toContain('Merhaba ML Mail Turkish');

    // German mentee: no German version was written, so they get the canonical
    // (default-locale) one rather than nothing — and not the Turkish one.
    const deLog = await prisma.interactionLog.findFirstOrThrow({ where: { relationId: deRel.id } });
    expect(deLog.notes).toContain(`EN subject ${stamp}`);
    expect(deLog.notes).toContain('Hi ML Mail German');
    expect(deLog.notes).not.toContain('Türkçe');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(trEmail);
    await cleanupByEmail(deEmail);
  }
});

// Picking a template must fill every language at once — hand-translating is the
// exact chore this replaces.
test('choosing a template fills all three languages', async ({ page }) => {
  const mentorEmail = uniqueEmail('mltpl-mentor');
  const menteeEmail = uniqueEmail('mltpl-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'ML Tpl Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'ML Tpl Mentee');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto('/mentor/email');
    await expect(page.getByTestId('email-tab-en')).toBeVisible({ timeout: 15_000 });

    // Nothing written yet.
    for (const l of ['en', 'tr', 'de']) {
      await expect(page.getByTestId(`email-tab-${l}`)).toHaveAttribute('data-filled', 'false');
    }

    await page.getByTestId('email-template-select').selectOption('checkin');

    // All three tabs now carry a complete subject+body.
    for (const l of ['en', 'tr', 'de']) {
      await expect(page.getByTestId(`email-tab-${l}`)).toHaveAttribute('data-filled', 'true');
    }
    await expect(page.getByTestId('email-language-coverage')).toBeVisible();

    // And switching tabs shows the language's own wording, not the same string.
    const english = await page.getByTestId('email-subject').inputValue();
    await page.getByTestId('email-tab-de').click();
    const german = await page.getByTestId('email-subject').inputValue();
    expect(german).not.toBe(english);
    expect(german.length).toBeGreaterThan(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

// The single-language contract stays valid for API callers that never learned
// about `translations`.
test('a plain subject/body send still works', async ({ page }) => {
  const mentorEmail = uniqueEmail('mlplain-mentor');
  const menteeEmail = uniqueEmail('mlplain-mentee');
  const subject = `Plain subject ${Date.now().toString(36)}`;
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'ML Plain Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'ML Plain Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/mentor/email', {
      data: { relationIds: [rel.id], subject, body: 'Hello {name}' },
    });
    expect(res.ok()).toBeTruthy();
    const log = await prisma.interactionLog.findFirstOrThrow({ where: { relationId: rel.id } });
    expect(log.notes).toContain(subject);
    expect(log.notes).toContain('Hello ML Plain Mentee');

    // Neither half alone is a message.
    const bad = await page.request.post('/api/mentor/email', {
      data: { relationIds: [rel.id], subject: 'no body' },
    });
    expect(bad.status()).toBe(400);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
