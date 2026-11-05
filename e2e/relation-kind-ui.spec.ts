import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi, gotoSettled } from './helpers/auth';

// #1507 — the UI of the relation kind and the hire attribution (#1503).
//
//   1. A COACHING pair has no stage to pick: not on the admin's candidate page,
//      not on the mentor's mentee page, and the mentee's portal shows no stage
//      strip. The admin moves it into the placement funnel; a mentor cannot,
//      and the server says so (kind_admin_only) — hiding the button is not the check.
//   2. A move into a hire stage asks whose outcome it is before the request
//      goes out. Cancelling sends nothing.
//   3. The move still goes through the stage gate (#1589): with a document gate
//      on the hire stage, the attribution answer is followed by the gate dialog
//      (#1590) and the stage does not move; with the gate lifted the same answer
//      moves it and stores the attribution.

test.afterAll(async () => prisma.$disconnect());
test.use({ viewport: { width: 1280, height: 900 } });

const PW = 'RelationKind123!';

test('coaching hides the stage; a hire asks for the attribution and still passes the stage gate', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Kind UI ${s}`, slug: `kind-ui-${s}`, plan: 'FREE' } });
  const emails = ['rk-admin', 'rk-mentor', 'rk-mentee'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, menteeEmail] = emails;
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Kind Admin', org.id);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Kind Mentor', org.id);
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Coached Cem', org.id);
    const relation = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, kind: 'COACHING', pipelineStatus: 'HIREABLE_600', funnelEnteredAt: null },
    });

    // ── 1a. The mentor: a coaching note instead of a stage select, and no way to reclassify.
    const mentorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mentorContext.addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    const mentorPage = await mentorContext.newPage();
    await signInAndSettle(mentorPage, mentorEmail, PW, '/mentor');
    await gotoSettled(mentorPage, `/mentor/mentees/${relation.id}`);
    await expect(mentorPage.getByTestId('relation-coaching')).toBeVisible({ timeout: 20_000 });
    await expect(mentorPage.getByTestId('stage-select')).toHaveCount(0);
    const refused = await mentorPage.request.put(`/api/mentorship/${relation.id}`, { data: { kind: 'PLACEMENT' } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('kind_admin_only');

    // ── 1b. The mentee's portal: no stage strip for a coaching pair.
    const menteeContext = await browser.newContext();
    expect((await signInViaApi(menteeContext.request, menteeEmail, PW)).ok).toBe(true);
    const menteePage = await menteeContext.newPage();
    await gotoSettled(menteePage, '/portal');
    await expect(menteePage.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(menteePage.getByTestId('journey-tracker')).toHaveCount(0);
    await menteeContext.close();

    // ── 1c. The admin: badged in the candidate list (the desktop list —
    // the page renders a mobile copy too), then badge, note and the one way
    // into the funnel on the candidate page.
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, '/admin/candidates');
    await expect(page.getByTestId('candidates-desktop-list').getByTestId(`candidate-coaching-${mentee.id}`)).toBeVisible({ timeout: 20_000 });
    await gotoSettled(page, `/admin/candidates/${mentee.id}`);
    await expect(page.getByTestId('relation-kind-coaching')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('stage-select')).toHaveCount(0);
    await page.getByTestId('relation-to-placement').click();
    await expect(page.getByTestId('stage-select')).toBeVisible();
    await expect(page.getByTestId('relation-kind-coaching')).toHaveCount(0);
    const moved = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } });
    expect(moved.kind).toBe('PLACEMENT');
    expect(moved.funnelEnteredAt).not.toBeNull();

    // ── 3a. A document gate on the hire stage, set through the stage editor's own API.
    await prisma.documentRequirement.create({
      data: { orgId: org.id, key: 'signed-contract', labels: { en: 'Signed contract', tr: 'İmzalı sözleşme', de: 'Unterschriebener Vertrag' }, appliesToStage: 'HIRED_660', appliesToRole: 'MENTEE' },
    });
    const stagesUrl = `/api/admin/organizations/${org.id}/pipeline-stages`;
    const stagesNow = (await (await page.request.get(stagesUrl)).json()).stages as { key: string; gateDocuments?: boolean }[];
    const setGate = async (on: boolean) => {
      const res = await page.request.put(stagesUrl, { data: { stages: stagesNow.map((st) => (st.key === 'HIRED_660' ? { ...st, gateDocuments: on } : st)) } });
      expect(res.ok()).toBe(true);
    };
    await setGate(true);

    // ── 2. A move into a hire stage asks first; cancelling sends nothing.
    await gotoSettled(page, `/admin/candidates/${mentee.id}`);
    await page.getByTestId('stage-select').selectOption('HIRED_660');
    const ask = page.getByTestId('employment-attribution-dialog');
    await expect(ask).toBeVisible();
    await expect(page.getByTestId('employment-attribution-confirm')).toBeDisabled();
    await page.getByTestId('employment-attribution-cancel').click();
    await expect(ask).toHaveCount(0);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('HIREABLE_600');

    // ── 3b. Answered, then refused by the gate: the gate dialog takes over, nothing moved.
    await gotoSettled(page, `/admin/candidates/${mentee.id}`);
    await page.getByTestId('stage-select').selectOption('HIRED_660');
    await page.getByTestId('employment-attribution-SELF_FOUND').check();
    await page.getByTestId('employment-attribution-confirm').click();
    await expect(page.getByTestId('employment-attribution-dialog')).toHaveCount(0);
    const gate = page.getByTestId('stage-gate-dialog');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-code', 'documents');
    const blocked = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } });
    expect([blocked.pipelineStatus, blocked.employmentAttribution]).toEqual(['HIREABLE_600', null]);
    await gate.getByTestId('stage-gate-close').click();

    // ── 3c. Gate lifted: the same answer moves it, through the recorded stage path.
    await setGate(false);
    await gotoSettled(page, `/admin/candidates/${mentee.id}`);
    await page.getByTestId('stage-select').selectOption('HIRED_660');
    await page.getByTestId('employment-attribution-SELF_FOUND').check();
    await page.getByTestId('employment-attribution-confirm').click();
    await expect
      .poll(async () => {
        const r = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } });
        return [r.pipelineStatus, r.employmentAttribution];
      }, { timeout: 15_000 })
      .toEqual(['HIRED_660', 'SELF_FOUND']);
    expect(await prisma.statusChange.count({ where: { relationId: relation.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660' } })).toBe(1);

    // ── The mentor, now on a placement pair, is asked too.
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { pipelineStatus: 'HIREABLE_600', employmentAttribution: null } });
    await gotoSettled(mentorPage, `/mentor/mentees/${relation.id}`);
    await mentorPage.getByTestId('stage-select').selectOption('EMPLOYED_700');
    await mentorPage.getByTestId('employment-attribution-THROUGH_US').check();
    await mentorPage.getByTestId('employment-attribution-confirm').click();
    await expect
      .poll(async () => {
        const r = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } });
        return [r.pipelineStatus, r.employmentAttribution];
      }, { timeout: 15_000 })
      .toEqual(['EMPLOYED_700', 'THROUGH_US']);
    await mentorContext.close();
  } finally {
    await prisma.documentRequirement.deleteMany({ where: { orgId: org.id } });
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const email of emails) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
