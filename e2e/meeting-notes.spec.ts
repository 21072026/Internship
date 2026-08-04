import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1056 / #1057 — notes that know which meeting they came from, written in a
// window that floats above everything.
//
// The Document Picture-in-Picture path can't be driven headlessly (it needs a
// real user gesture and a desktop Chrome window), so what is asserted here is
// everything around it: the note↔meeting link and its authorization, and that
// the fallback path is the one a headless browser actually takes. The on-top
// behaviour itself is verified by hand.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a note can be attached to a meeting the author was in, and read back by meeting', async ({ page }) => {
  const mentorEmail = uniqueEmail('note-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Note Mentor');
  const mentee = await seedUser(uniqueEmail('note-mentee'), 'x', 'MENTEE', 'Note Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    const started = await page.request.post('/api/meetings/instant', {
      data: { relationIds: [rel.id], title: 'Review call' },
    });
    const { meetingId } = await started.json();

    const created = await page.request.post('/api/notes', {
      data: { body: 'Ship the report by Friday', meetingId },
    });
    expect(created.status()).toBe(201);
    const { note } = await created.json();
    // A note born in a meeting is a MEETING note without anyone saying so.
    expect(note.category).toBe('MEETING');
    expect(note.meetingId).toBe(meetingId);

    const byMeeting = await page.request.get(`/api/notes?meetingId=${meetingId}`);
    const listed = (await byMeeting.json()).notes;
    expect(listed).toHaveLength(1);
    expect(listed[0].meeting.title).toBe('Review call');

    // The note is the durable part: deleting the meeting must not take it.
    await prisma.meeting.delete({ where: { id: meetingId } });
    const survivor = await prisma.personalNote.findUnique({ where: { id: note.id } });
    expect(survivor?.body).toBe('Ship the report by Friday');
    expect(survivor?.meetingId).toBeNull();
  } finally {
    await prisma.personalNote.deleteMany({ where: { userId: mentor.id } });
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

test("a note cannot point at a meeting its author was never in", async ({ page }) => {
  const outsiderEmail = uniqueEmail('note-outsider');
  const outsider = await seedUser(outsiderEmail, 'MentorPass123', 'MENTOR', 'Note Outsider');
  const owner = await seedUser(uniqueEmail('note-owner'), 'x', 'MENTOR', 'Note Owner');
  const mentee = await seedUser(uniqueEmail('note-victim'), 'x', 'MENTEE', 'Note Victim');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: owner.id, menteeId: mentee.id } });
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Not yours',
      meetLink: 'https://meet.jit.si/InternshipCRM-private',
      rsvpToken: `tok-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      createdById: owner.id,
    },
  });

  try {
    await signInAndSettle(page, outsiderEmail, 'MentorPass123', '/mentor');

    const res = await page.request.post('/api/notes', {
      data: { body: 'probing', meetingId: meeting.id },
    });
    expect(res.status()).toBe(403);
    expect(await prisma.personalNote.count({ where: { userId: outsider.id } })).toBe(0);
  } finally {
    await prisma.personalNote.deleteMany({ where: { userId: outsider.id } });
    await prisma.meeting.deleteMany({ where: { id: meeting.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(owner.email);
    await cleanupByEmail(outsiderEmail);
  }
});

test('the notes window falls back to a popup where Document PiP is missing', async ({ page, context }) => {
  const menteeEmail = uniqueEmail('note-win-mentee');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Note Win Mentee');

  try {
    // Headless Chromium DOES ship documentPictureInPicture, so the fallback has
    // to be forced — otherwise this test would silently exercise the PiP branch
    // and prove nothing about Safari/Firefox users.
    await context.addInitScript(() => {
      // @ts-expect-error — removing a real API on purpose, to play a browser without it.
      delete window.documentPictureInPicture;
    });
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto('/portal/notes');
    expect(await page.evaluate(() => 'documentPictureInPicture' in window)).toBe(false);

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.getByTestId('open-notes-window').click(),
    ]);
    await expect(popup.getByTestId('floating-notes-textarea')).toBeVisible();
    // The user is told why it isn't staying on top, rather than left guessing.
    await expect(popup.getByTestId('floating-notes-popup-warning')).toBeVisible();

    // It is a working notes window, not just a shell: what is typed is saved.
    await popup.getByTestId('floating-notes-textarea').fill('Popup fallback works');
    await popup.getByRole('button', { name: /save now|şimdi kaydet|jetzt speichern/i }).click();
    await expect
      .poll(async () => {
        const notes = (await page.request.get('/api/notes').then((r) => r.json())).notes;
        return notes.map((n: { body: string }) => n.body).join('|');
      })
      .toContain('Popup fallback works');
  } finally {
    const user = await prisma.user.findUnique({ where: { email: menteeEmail } });
    if (user) await prisma.personalNote.deleteMany({ where: { userId: user.id } });
    await cleanupByEmail(menteeEmail);
  }
});

test('where Document PiP exists it is used, and no "not on top" warning is shown', async ({ page, context }) => {
  const menteeEmail = uniqueEmail('note-pip-mentee');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Note Pip Mentee');

  try {
    // A headless browser can't produce a real always-on-top window, so
    // requestWindow is stubbed with a plain popup. What this proves is the
    // branch: the code asks the PiP API first and treats what it gets as PiP.
    // The on-top behaviour itself is verified by hand.
    await context.addInitScript(() => {
      Object.defineProperty(window, 'documentPictureInPicture', {
        configurable: true,
        value: {
          window: null,
          requestWindow: (opts: { width?: number; height?: number } = {}) => {
            (window as unknown as { __pipAsked?: boolean }).__pipAsked = true;
            return Promise.resolve(window.open('', '', `popup=yes,width=${opts.width ?? 380},height=${opts.height ?? 480}`));
          },
        },
      });
    });
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto('/portal/notes');

    const [win] = await Promise.all([
      context.waitForEvent('page'),
      page.getByTestId('open-notes-window').click(),
    ]);
    await expect(win.getByTestId('floating-notes-textarea')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pipAsked?: boolean }).__pipAsked)).toBe(true);
    // Nothing to apologise for when the window really is on top.
    await expect(win.getByTestId('floating-notes-popup-warning')).toHaveCount(0);
  } finally {
    const user = await prisma.user.findUnique({ where: { email: menteeEmail } });
    if (user) await prisma.personalNote.deleteMany({ where: { userId: user.id } });
    await cleanupByEmail(menteeEmail);
  }
});
