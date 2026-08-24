import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// #824 — interview scorecards, blind scoring, panel calibration.
//
// The heart of this spec is that blind scoring is enforced by the SERVER. Every
// assertion below reads the RESPONSE BODY, never the screen: this repo has
// already shipped a real leak by hiding data on the client instead of
// withholding it on the server (#740), and "it isn't visible in the UI" is not
// the property being tested here.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPanelCast(prefix: string) {
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  const aEmail = uniqueEmail(`${prefix}-int-a`);
  const bEmail = uniqueEmail(`${prefix}-int-b`);
  const cEmail = uniqueEmail(`${prefix}-cand`);
  const a = await seedUser(aEmail, 'MentorPass123', 'MENTOR', 'Interviewer A');
  const b = await seedUser(bEmail, 'MentorPass123', 'MENTOR', 'Interviewer B');
  const candidate = await seedUser(cEmail, 'MenteePass123', 'MENTEE', 'Panel Candidate');
  await prisma.user.updateMany({ where: { id: { in: [a.id, b.id, candidate.id] } }, data: { orgId } });
  return { aEmail, bEmail, cEmail, a, b, candidate };
}

test('blind scoring is enforced by the API: nobody reads another scorecard before the panel completes', async ({ page }) => {
  test.slow();
  const { aEmail, bEmail, cEmail, a, b, candidate } = await seedPanelCast('blind');
  let panelId = '';
  try {
    // The admin convenes the panel.
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const created = await page.request.post('/api/interview-panels', {
      data: { subjectId: candidate.id, interviewerIds: [a.id, b.id], title: 'Technical round' },
    });
    expect(created.status()).toBe(201);
    panelId = (await created.json()).panel.id;

    // Interviewer A scores. Before submitting, A must not see anything of B's —
    // and B has not scored anyway.
    await signInAsFreshUser(page, aEmail, 'MentorPass123', '/mentor');
    const beforeAnything = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(beforeAnything.revealed).toBe(false);
    expect(beforeAnything.scorecards).toEqual([]);
    // Who has scored is not a score — the panel needs it to know when it is done.
    expect(beforeAnything.roster).toHaveLength(2);

    const aScored = await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 5, communication: 5, reliability: 4, growth: 4 }, comment: 'A says yes', submit: true },
    });
    expect(aScored.status()).toBe(201);

    // A has submitted, but B has not: the panel is incomplete, so still nothing.
    const afterOwn = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(afterOwn.revealed).toBe(false);
    expect(afterOwn.scorecards).toEqual([]);
    expect(afterOwn.divergence).toEqual([]);
    expect(afterOwn.average).toBeNull();
    // Own scorecard always comes back — it is A's own.
    expect(afterOwn.own.scores.technical).toBe(5);
    // And not a trace of B anywhere in the payload.
    expect(JSON.stringify(afterOwn)).not.toContain('A says yes'.replace('A', 'B'));

    // B scores — now the panel is complete.
    await signInAsFreshUser(page, bEmail, 'MentorPass123', '/mentor');
    const bBefore = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    // B has not submitted yet, so B cannot read A even though A is done.
    expect(bBefore.revealed).toBe(false);
    expect(bBefore.scorecards).toEqual([]);
    expect(JSON.stringify(bBefore)).not.toContain('A says yes');

    const bScored = await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 2, communication: 4, reliability: 4, growth: 4 }, comment: 'B is unsure', submit: true },
    });
    expect(bScored.status()).toBe(201);

    const revealed = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(revealed.revealed).toBe(true);
    expect(revealed.scorecards).toHaveLength(2);
    expect(JSON.stringify(revealed)).toContain('A says yes');
    // technical: 5 vs 2 → a spread of 3, which is exactly what calibration is for.
    const technical = revealed.divergence.find((d: { key: string }) => d.key === 'technical');
    expect(technical.spread).toBe(3);
    expect(technical.flagged).toBe(true);
    // communication: 5 vs 4 → agreed.
    expect(revealed.divergence.find((d: { key: string }) => d.key === 'communication').flagged).toBe(false);

    // A submitted scorecard is final: revising it after reading the room would
    // make it not independent.
    const reEdit = await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 5 }, submit: true },
    });
    expect(reEdit.status()).toBe(409);
  } finally {
    if (panelId) await prisma.interviewPanel.deleteMany({ where: { id: panelId } });
    await cleanupByEmail(cEmail);
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
  }
});

test('a scorecard exists without any mentorship, and someone off the panel cannot read or score it', async ({ page }) => {
  test.slow();
  const { aEmail, bEmail, cEmail, a, candidate } = await seedPanelCast('outsider');
  const outsiderEmail = uniqueEmail('outsider-mentor');
  const outsider = await seedUser(outsiderEmail, 'MentorPass123', 'MENTOR', 'Outsider Mentor');
  let panelId = '';
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const created = await page.request.post('/api/interview-panels', {
      data: { subjectId: candidate.id, interviewerIds: [a.id] },
    });
    expect(created.status()).toBe(201);
    panelId = (await created.json()).panel.id;

    await signInAsFreshUser(page, aEmail, 'MentorPass123', '/mentor');
    const scored = await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 4 }, submit: true },
    });
    expect(scored.status()).toBe(201);

    // The candidate has no mentorship at all, and the scorecard exists anyway.
    const relations = await prisma.mentorshipRelation.count({ where: { menteeId: candidate.id } });
    expect(relations).toBe(0);
    const row = await prisma.evaluation.findFirst({ where: { panelId } });
    expect(row?.relationId).toBeNull();
    expect(row?.subjectId).toBe(candidate.id);
    expect(row?.type).toBe('INTERVIEW');

    // A mentor who is not on the panel gets nothing at all.
    await signInAsFreshUser(page, outsiderEmail, 'MentorPass123', '/mentor');
    const read = await page.request.get(`/api/interview-panels/${panelId}`);
    expect(read.status()).toBe(403);
    const write = await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 1 }, submit: true },
    });
    expect(write.status()).toBe(403);
  } finally {
    if (panelId) await prisma.interviewPanel.deleteMany({ where: { id: panelId } });
    await cleanupByEmail(outsiderEmail);
    await cleanupByEmail(cEmail);
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
    await prisma.user.deleteMany({ where: { id: outsider.id } });
  }
});

test('closing a panel reveals what was submitted — but a member who never scored stays blind', async ({ page }) => {
  test.slow();
  const { aEmail, bEmail, cEmail, a, b, candidate } = await seedPanelCast('close');
  let panelId = '';
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const created = await page.request.post('/api/interview-panels', {
      data: { subjectId: candidate.id, interviewerIds: [a.id, b.id] },
    });
    panelId = (await created.json()).panel.id;

    await signInAsFreshUser(page, aEmail, 'MentorPass123', '/mentor');
    await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 3 }, comment: 'A showed up', submit: true },
    });

    // B never scores; the admin ends the collection.
    await signInAsFreshUser(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const closed = await page.request.post(`/api/interview-panels/${panelId}/close`);
    expect(closed.ok()).toBeTruthy();
    const adminView = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(adminView.revealed).toBe(true);
    expect(adminView.scorecards).toHaveLength(1);

    // B, who never submitted, still cannot read A — otherwise waiting would beat
    // scoring.
    await signInAsFreshUser(page, bEmail, 'MentorPass123', '/mentor');
    const bView = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(bView.revealed).toBe(false);
    expect(bView.scorecards).toEqual([]);
    expect(JSON.stringify(bView)).not.toContain('A showed up');
  } finally {
    if (panelId) await prisma.interviewPanel.deleteMany({ where: { id: panelId } });
    await cleanupByEmail(cEmail);
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
  }
});

test('the existing INTERIM/FINAL evaluation flow still works', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('regress-mentor');
  const menteeEmail = uniqueEmail('regress-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Regress Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Regress Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE' },
  });
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/evaluations', {
      data: { relationId: relation.id, type: 'FINAL', scores: { technical: 4, growth: 5 }, comment: 'Still works' },
    });
    expect(res.status()).toBe(201);
    const row = await prisma.evaluation.findFirst({ where: { relationId: relation.id } });
    expect(row?.type).toBe('FINAL');
    expect(row?.relationId).toBe(relation.id);
    // Relation-backed rows do not duplicate the subject, and are not on a panel.
    expect(row?.subjectId).toBeNull();
    expect(row?.panelId).toBeNull();

    const list = await (await page.request.get(`/api/evaluations?relationId=${relation.id}`)).json();
    expect(list.evaluations).toHaveLength(1);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
