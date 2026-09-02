import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// #1893 — the correction window on an evaluation, and reopening an interview
// panel.
//
// Every assertion reads the RESPONSE BODY or the row, never the screen: the
// rules under test are server-side rules ("the author within 7 days", "a
// reopened panel still hides the others"), and a hidden button proves none of
// them. The 7-day boundary is exercised by backdating `createdAt` in the DB,
// which is the only honest way to be on the far side of it.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const EIGHT_DAYS_AGO = () => new Date(Date.now() - 8 * 86_400_000);

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an author corrects an evaluation inside the window, and the window closes', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('editwin-mentor');
  const menteeEmail = uniqueEmail('editwin-mentee');
  const pw = 'MentorPass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Edit Window Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Edit Window Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, pw, '/mentor');
    const created = await page.request.post('/api/evaluations', {
      data: { relationId: rel.id, scores: { technical: 2, communication: 4 }, comment: 'typo in technical' },
    });
    expect(created.status()).toBe(201);
    const evaluationId = (await created.json()).evaluation.id;

    // The correction itself.
    const fixed = await page.request.patch(`/api/evaluations/${evaluationId}`, {
      data: { scores: { technical: 5, communication: 4 }, comment: 'meant to type 5' },
    });
    expect(fixed.status()).toBe(200);
    const body = await fixed.json();
    expect(body.evaluation.scores.technical).toBe(5);
    expect(body.evaluation.comment).toBe('meant to type 5');
    expect(body.evaluation.updatedAt).not.toBeNull();

    // The record keeps its place in history rather than being rewritten as a
    // new one, and the list marks it correctable.
    const list = await (await page.request.get(`/api/evaluations?relationId=${rel.id}`)).json();
    expect(list.evaluations).toHaveLength(1);
    expect(list.evaluations[0].scores.technical).toBe(5);
    expect(list.evaluations[0].canEdit).toBe(true);
    // `updatedAt` is stamped on create too, so the list carries a derived flag.
    expect(list.evaluations[0].corrected).toBe(true);

    // A correction is auditable, not silent.
    const logged = await prisma.activityLog.findFirst({
      where: { action: 'evaluation.updated', targetId: evaluationId },
    });
    expect(logged).not.toBeNull();

    // An unknown criterion is refused by the same rubric check POST uses.
    const bogus = await page.request.patch(`/api/evaluations/${evaluationId}`, {
      data: { scores: { notACriterion: 3 } },
    });
    expect(bogus.status()).toBe(400);

    // Past the boundary the API refuses, and the list stops offering the button.
    await prisma.evaluation.update({ where: { id: evaluationId }, data: { createdAt: EIGHT_DAYS_AGO() } });
    const tooLate = await page.request.patch(`/api/evaluations/${evaluationId}`, {
      data: { scores: { technical: 1 } },
    });
    expect(tooLate.status()).toBe(409);
    expect((await tooLate.json()).code).toBe('edit_window_closed');
    const stale = await (await page.request.get(`/api/evaluations?relationId=${rel.id}`)).json();
    expect(stale.evaluations[0].canEdit).toBe(false);
    // And the score is still the corrected one — the refusal changed nothing.
    expect(stale.evaluations[0].scores.technical).toBe(5);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('correcting an evaluation un-approves and un-publishes its testimonial excerpt', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('editpub-mentor');
  const menteeEmail = uniqueEmail('editpub-mentee');
  const otherEmail = uniqueEmail('editpub-other');
  const pw = 'MentorPass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Publish Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Publish Mentee');
  await seedUser(otherEmail, pw, 'MENTOR', 'Unrelated Mentor');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, pw, '/mentor');
    const created = await page.request.post('/api/evaluations', {
      data: { relationId: rel.id, scores: { technical: 4 }, comment: 'a quotable comment' },
    });
    expect(created.status()).toBe(201);
    const evaluationId = (await created.json()).evaluation.id;

    // Stand the row up as an approved, published testimonial.
    await prisma.evaluation.update({
      where: { id: evaluationId },
      data: {
        publicExcerpt: 'A quotable excerpt',
        excerptApprovedAt: new Date(),
        publishedAt: new Date(),
        sharedPublicly: true,
      },
    });

    const fixed = await page.request.patch(`/api/evaluations/${evaluationId}`, {
      data: { comment: 'a corrected comment' },
    });
    expect(fixed.status()).toBe(200);

    // The wording the author approved described a record that no longer exists,
    // so the approval and the publication go with it.
    const row = await prisma.evaluation.findUnique({ where: { id: evaluationId } });
    expect(row?.excerptApprovedAt).toBeNull();
    expect(row?.publishedAt).toBeNull();
    expect(row?.sharedPublicly).toBe(false);
    // The admin's drafted text is kept — re-approving it is the author's call.
    expect(row?.publicExcerpt).toBe('A quotable excerpt');

    // Neither the author nor an admin: refused by the ROUTE, not by a hidden
    // button.
    await signInAsFreshUser(page, otherEmail, pw, '/mentor');
    const outsider = await page.request.patch(`/api/evaluations/${evaluationId}`, {
      data: { scores: { technical: 1 } },
    });
    expect(outsider.status()).toBe(403);
    const untouched = await prisma.evaluation.findUnique({ where: { id: evaluationId } });
    expect((untouched?.scores as Record<string, number>).technical).toBe(4);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(otherEmail);
  }
});

test('a reopened panel still hides the other scorecards, and a scored interviewer cannot be dropped', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const aEmail = uniqueEmail('reopen-int-a');
  const bEmail = uniqueEmail('reopen-int-b');
  const cEmail = uniqueEmail('reopen-cand');
  const a = await seedUser(aEmail, 'MentorPass123', 'MENTOR', 'Reopen Interviewer A');
  const b = await seedUser(bEmail, 'MentorPass123', 'MENTOR', 'Reopen Interviewer B');
  const candidate = await seedUser(cEmail, 'MenteePass123', 'MENTEE', 'Reopen Candidate');
  await prisma.user.updateMany({ where: { id: { in: [a.id, b.id, candidate.id] } }, data: { orgId: admin?.orgId ?? null } });
  let panelId = '';

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const created = await page.request.post('/api/interview-panels', {
      data: { subjectId: candidate.id, interviewerIds: [a.id, b.id], title: 'Reopen round' },
    });
    expect(created.status()).toBe(201);
    panelId = (await created.json()).panel.id;

    // A scores; B never turns up, so the admin closes the panel.
    await signInAsFreshUser(page, aEmail, 'MentorPass123', '/mentor');
    const aScored = await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 5, communication: 5, reliability: 4, growth: 4 }, comment: 'A says yes', submit: true },
    });
    expect(aScored.status()).toBe(201);

    await signInAsFreshUser(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    expect((await page.request.post(`/api/interview-panels/${panelId}/close`)).status()).toBe(200);

    // The roster is frozen while the panel is closed — reopen first.
    const whileClosed = await page.request.patch(`/api/interview-panels/${panelId}`, {
      data: { removeInterviewerIds: [b.id] },
    });
    expect(whileClosed.status()).toBe(409);
    expect((await whileClosed.json()).code).toBe('panel_closed');

    // B did turn up after all: reopen.
    const reopened = await page.request.post(`/api/interview-panels/${panelId}/reopen`);
    expect(reopened.status()).toBe(200);
    expect((await reopened.json()).closedAt).toBeNull();
    expect(await prisma.activityLog.findFirst({ where: { action: 'interview_panel.reopened', targetId: panelId } })).not.toBeNull();

    // The whole point: reopening re-applies the blind rule. B has not
    // submitted, so B gets nothing of A's — not in the UI, not in the payload.
    await signInAsFreshUser(page, bEmail, 'MentorPass123', '/mentor');
    const asB = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(asB.revealed).toBe(false);
    expect(asB.scorecards).toEqual([]);
    expect(asB.divergence).toEqual([]);
    expect(asB.average).toBeNull();
    expect(JSON.stringify(asB)).not.toContain('A says yes');
    // Even A, who did submit, is back to waiting: the collection is open again.
    await signInAsFreshUser(page, aEmail, 'MentorPass123', '/mentor');
    const asA = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(asA.revealed).toBe(false);
    expect(asA.scorecards).toEqual([]);

    // A submitted scorecard is part of the record: A cannot be dropped, but B
    // — who has scored nothing — can, and the title moves freely.
    await signInAsFreshUser(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const dropScored = await page.request.patch(`/api/interview-panels/${panelId}`, {
      data: { removeInterviewerIds: [a.id] },
    });
    expect(dropScored.status()).toBe(409);
    expect((await dropScored.json()).code).toBe('already_scored');

    const edited = await page.request.patch(`/api/interview-panels/${panelId}`, {
      data: { title: 'Reopen round, take two', removeInterviewerIds: [b.id] },
    });
    expect(edited.status()).toBe(200);
    const afterEdit = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(afterEdit.panel.title).toBe('Reopen round, take two');
    expect(afterEdit.roster.map((r: { userId: string }) => r.userId)).toEqual([a.id]);
    // A is now the whole panel and has submitted, so it is complete again.
    expect(afterEdit.panel.complete).toBe(true);
  } finally {
    if (panelId) await prisma.interviewPanel.deleteMany({ where: { id: panelId } });
    await cleanupByEmail(cEmail);
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
  }
});
