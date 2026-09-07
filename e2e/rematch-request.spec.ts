import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Mentee-initiated re-match (#1801), end to end.
 *
 * The corruption this replaces: the only way out of a bad pairing used to be an
 * admin marking the relation COMPLETED, which records a success that never
 * happened. So the assertions that matter are not "a request row exists" but
 * the state the approval leaves behind — the old pairing reads ENDED_REMATCHED,
 * and the mentee has EXACTLY ONE live relation, never two and never none.
 */
test('mentee asks for a different mentor → admin approves → old pairing reads ENDED_REMATCHED', { tag: '@smoke' }, async ({ browser }) => {
  const pw = 'RematchPass123';
  const menteeEmail = uniqueEmail('rm-mentee');
  const adminEmail = uniqueEmail('rm-admin');
  const oldMentorEmail = uniqueEmail('rm-old-mentor');
  const newMentorEmail = uniqueEmail('rm-new-mentor');

  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Rematch Mentee');
  await seedUser(adminEmail, pw, 'ADMIN', 'Rematch Admin');
  const oldMentor = await seedUser(oldMentorEmail, 'x', 'MENTOR', 'Rematch Old Mentor');
  const newMentor = await seedUser(newMentorEmail, 'x', 'MENTOR', 'Rematch New Mentor');

  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: oldMentor.id, menteeId: mentee.id },
  });

  const menteeCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  try {
    const menteePage = await menteeCtx.newPage();
    await menteePage.goto('/auth/signin');
    await menteePage.fill('input[type="email"], input[name="email"]', menteeEmail);
    await menteePage.fill('input[type="password"]', pw);
    await menteePage.click('button[type="submit"]');
    await menteePage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // The entry point exists for a mentee who HAS a mentor — the whole point of
    // the change, since the old `!relation || isArchived` gate hid it.
    await expect(menteePage.getByTestId('rematch-request')).toBeVisible({ timeout: 15_000 });
    await menteePage.getByTestId('rematch-open').click();
    await expect(menteePage.getByTestId('rematch-privacy')).toBeVisible();

    // A reason code is required.
    const noReason = await menteePage.request.post(`/api/mentorship/${relation.id}/rematch`, { data: {} });
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).code).toBe('reason_required');

    const created = await menteePage.request.post(`/api/mentorship/${relation.id}/rematch`, {
      data: { reason: 'no_fit', note: 'We never found a rhythm.' },
    });
    expect(created.status()).toBe(201);

    // One open re-match per pairing.
    const dup = await menteePage.request.post(`/api/mentorship/${relation.id}/rematch`, {
      data: { reason: 'other' },
    });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).code).toBe('already_pending_rematch');

    // The old pairing is still live while the admin works the queue.
    expect((await prisma.mentorshipRelation.findUnique({ where: { id: relation.id } }))!.status).toBe('ACTIVE');

    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/auth/signin');
    await adminPage.fill('input[type="email"], input[name="email"]', adminEmail);
    await adminPage.fill('input[type="password"]', pw);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const list = await (await adminPage.request.get('/api/admin/mentorship-requests')).json();
    const mine = (list.requests as { id: string; replacesRelationId: string | null; rematchReason: string | null; mentee: { id: string } }[])
      .find((r) => r.mentee.id === mentee.id);
    expect(mine).toBeTruthy();
    expect(mine!.replacesRelationId).toBe(relation.id);
    expect(mine!.rematchReason).toBe('no_fit');

    const approve = await adminPage.request.put('/api/admin/mentorship-requests', {
      data: { requestId: mine!.id, action: 'approve', mentorId: newMentor.id },
    });
    expect(approve.ok()).toBeTruthy();

    // The old pairing ended as a re-match, not as a completion.
    const oldAfter = await prisma.mentorshipRelation.findUnique({ where: { id: relation.id } });
    expect(oldAfter!.lifecycleState).toBe('ENDED_REMATCHED');
    expect(oldAfter!.status).toBe('COMPLETED');

    // Exactly one live relation, and it is with the new mentor.
    const live = await prisma.mentorshipRelation.findMany({ where: { menteeId: mentee.id, status: 'ACTIVE' } });
    expect(live).toHaveLength(1);
    expect(live[0].mentorId).toBe(newMentor.id);

    // The outgoing mentor is told the pairing ended — and told nothing else.
    const notices = await prisma.notification.findMany({
      where: { userId: oldMentor.id, type: 'mentorship_request.rematchMentorNotice' },
    });
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(notices[0].params)).not.toContain('rhythm');
  } finally {
    await menteeCtx.close();
    await adminCtx.close();
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: mentee.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(oldMentorEmail);
    await cleanupByEmail(newMentorEmail);
  }
});

/**
 * The privacy rule, as its own case: a mentor may not file a re-match on their
 * mentee's behalf, and may not read what the mentee wrote about them.
 */
test('a mentor can neither file nor read a mentee re-match request', async ({ browser }) => {
  const pw = 'RematchPass123';
  const menteeEmail = uniqueEmail('rmp-mentee');
  const mentorEmail = uniqueEmail('rmp-mentor');
  const otherMenteeEmail = uniqueEmail('rmp-other');

  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Privacy Mentee');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Privacy Mentor');
  const otherMentee = await seedUser(otherMenteeEmail, pw, 'MENTEE', 'Privacy Other');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  const menteeCtx = await browser.newContext();
  const mentorCtx = await browser.newContext();
  const otherCtx = await browser.newContext();
  try {
    const menteePage = await menteeCtx.newPage();
    await menteePage.goto('/auth/signin');
    await menteePage.fill('input[type="email"], input[name="email"]', menteeEmail);
    await menteePage.fill('input[type="password"]', pw);
    await menteePage.click('button[type="submit"]');
    await menteePage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
    const created = await menteePage.request.post(`/api/mentorship/${relation.id}/rematch`, {
      data: { reason: 'mentor_unavailable', note: 'SECRETREASONTEXT' },
    });
    expect(created.status()).toBe(201);

    // The mentor of the pairing: 403 on the write path…
    const mentorPage = await mentorCtx.newPage();
    await mentorPage.goto('/auth/signin');
    await mentorPage.fill('input[type="email"], input[name="email"]', mentorEmail);
    await mentorPage.fill('input[type="password"]', pw);
    await mentorPage.click('button[type="submit"]');
    await mentorPage.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
    const asMentor = await mentorPage.request.post(`/api/mentorship/${relation.id}/rematch`, {
      data: { reason: 'no_fit' },
    });
    expect(asMentor.status()).toBe(403);

    // …and nothing they can read carries the mentee's words.
    const inbox = await mentorPage.request.get('/api/mentor/applications');
    expect(inbox.status()).toBe(200);
    expect(await inbox.text()).not.toContain('SECRETREASONTEXT');
    const adminQueue = await mentorPage.request.get('/api/admin/mentorship-requests');
    expect([401, 403]).toContain(adminQueue.status());

    // Another mentee cannot file one on this pairing either.
    const otherPage = await otherCtx.newPage();
    await otherPage.goto('/auth/signin');
    await otherPage.fill('input[type="email"], input[name="email"]', otherMenteeEmail);
    await otherPage.fill('input[type="password"]', pw);
    await otherPage.click('button[type="submit"]');
    await otherPage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
    const asOther = await otherPage.request.post(`/api/mentorship/${relation.id}/rematch`, {
      data: { reason: 'no_fit' },
    });
    expect(asOther.status()).toBe(403);
  } finally {
    await menteeCtx.close();
    await mentorCtx.close();
    await otherCtx.close();
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: { in: [mentee.id, otherMentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherMenteeEmail);
  }
});
