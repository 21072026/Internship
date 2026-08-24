import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// #819 (the half that needs no demographic data) — blind interview review.
//
// The property being tested is that the identity is withheld by the SERVER.
// A name that reaches the browser has already done its anchoring work whatever
// the UI paints over it, so every assertion reads the response body — and the
// list endpoint is checked alongside the detail one, because a name hidden on
// one page and printed on the page linking to it is not hidden.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function setBlindReview(page: import('@playwright/test').Page, on: boolean) {
  const current = await (await page.request.get('/api/admin/settings')).json();
  const res = await page.request.put('/api/admin/settings', {
    data: { ...current.settings, blindReview: on ? 'true' : 'false' },
  });
  expect(res.ok()).toBeTruthy();
}

test('a candidate stays anonymous — in the response, not just the UI — until the interviewer scores', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  const interviewerEmail = uniqueEmail('blind-interviewer');
  const candidateEmail = uniqueEmail('blind-candidate');
  const interviewer = await seedUser(interviewerEmail, 'MentorPass123', 'MENTOR', 'Blind Interviewer');
  const candidate = await seedUser(candidateEmail, 'MenteePass123', 'MENTEE', 'Zeynep Kayaalp');
  await prisma.user.updateMany({ where: { id: { in: [interviewer.id, candidate.id] } }, data: { orgId } });
  let panelId = '';

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await setBlindReview(page, true);

    const created = await page.request.post('/api/interview-panels', {
      data: { subjectId: candidate.id, interviewerIds: [interviewer.id], title: 'Blind round' },
    });
    expect(created.status()).toBe(201);
    panelId = (await created.json()).panel.id;

    // Even the assignment notification withholds the name — a push that says
    // who it is undoes the blinding before the panel is ever opened.
    const assigned = await prisma.notification.findFirst({
      where: { userId: interviewer.id, type: { startsWith: 'interview.assigned' } },
    });
    expect(assigned?.type).toBe('interview.assignedBlind');
    expect(JSON.stringify(assigned?.params ?? {})).not.toContain('Zeynep');

    await signInAsFreshUser(page, interviewerEmail, 'MentorPass123', '/mentor');

    // Detail endpoint: no name, no id (the id addresses the candidate page, so
    // leaving it would make the blinding one click deep).
    const before = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(before.panel.blind).toBe(true);
    expect(before.panel.subjectName).toBeNull();
    expect(before.panel.subjectId).toBeNull();
    expect(before.panel.blindLabel).toBeTruthy();
    expect(JSON.stringify(before)).not.toContain('Zeynep');

    // List endpoint too.
    const list = await (await page.request.get('/api/interview-panels')).json();
    const row = list.panels.find((p: { id: string }) => p.id === panelId);
    expect(row.blind).toBe(true);
    expect(row.subjectName).toBeNull();
    expect(JSON.stringify(list)).not.toContain('Zeynep');

    // The screen shows the stable label instead, so the panel can discuss the
    // same person without knowing who it is.
    await page.goto(`/interviews/${panelId}`);
    await expect(page.getByTestId('blind-subject')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('blind-subject')).toContainText(before.panel.blindLabel);

    // Submitting removes the anchor's power, so the identity comes back.
    const scored = await page.request.post(`/api/interview-panels/${panelId}/score`, {
      data: { scores: { technical: 4 }, submit: true },
    });
    expect(scored.status()).toBe(201);

    const after = await (await page.request.get(`/api/interview-panels/${panelId}`)).json();
    expect(after.panel.blind).toBe(false);
    expect(after.panel.subjectName).toBe('Zeynep Kayaalp');
    expect(after.panel.subjectId).toBe(candidate.id);
  } finally {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin').catch(() => {});
    await setBlindReview(page, false).catch(() => {});
    if (panelId) await prisma.interviewPanel.deleteMany({ where: { id: panelId } });
    await prisma.notification.deleteMany({ where: { userId: interviewer.id } });
    await cleanupByEmail(candidateEmail);
    await cleanupByEmail(interviewerEmail);
  }
});

test('with the setting off nothing is hidden, and an admin running the panel is never blinded', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  const interviewerEmail = uniqueEmail('unblind-interviewer');
  const candidateEmail = uniqueEmail('unblind-candidate');
  const interviewer = await seedUser(interviewerEmail, 'MentorPass123', 'MENTOR', 'Open Interviewer');
  const candidate = await seedUser(candidateEmail, 'MenteePass123', 'MENTEE', 'Deniz Aksoy');
  await prisma.user.updateMany({ where: { id: { in: [interviewer.id, candidate.id] } }, data: { orgId } });
  let openPanel = '';
  let blindPanel = '';

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await setBlindReview(page, false);
    openPanel = (
      await (
        await page.request.post('/api/interview-panels', {
          data: { subjectId: candidate.id, interviewerIds: [interviewer.id] },
        })
      ).json()
    ).panel.id;

    // Default behaviour is unchanged: the interviewer sees who it is.
    await signInAsFreshUser(page, interviewerEmail, 'MentorPass123', '/mentor');
    const open = await (await page.request.get(`/api/interview-panels/${openPanel}`)).json();
    expect(open.panel.blind).toBe(false);
    expect(open.panel.subjectName).toBe('Deniz Aksoy');

    // With it on, an ADMIN who is not on the panel still sees the name: they
    // have no scorecard to bias, and they are the one who has to run the
    // calibration and act on the decision.
    await signInAsFreshUser(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await setBlindReview(page, true);
    blindPanel = (
      await (
        await page.request.post('/api/interview-panels', {
          data: { subjectId: candidate.id, interviewerIds: [interviewer.id] },
        })
      ).json()
    ).panel.id;
    const adminView = await (await page.request.get(`/api/interview-panels/${blindPanel}`)).json();
    expect(adminView.panel.blind).toBe(false);
    expect(adminView.panel.subjectName).toBe('Deniz Aksoy');
  } finally {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin').catch(() => {});
    await setBlindReview(page, false).catch(() => {});
    for (const id of [openPanel, blindPanel]) {
      if (id) await prisma.interviewPanel.deleteMany({ where: { id } });
    }
    await prisma.notification.deleteMany({ where: { userId: interviewer.id } });
    await cleanupByEmail(candidateEmail);
    await cleanupByEmail(interviewerEmail);
  }
});
