import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi, gotoSettled } from './helpers/auth';

// #1506 — promoting a MENTEE to MENTOR while they are still the mentee of an
// open relation. Both promotion paths (the mentor application approval and the
// admin's role convert, PATCH /api/users/[id]) refuse until the admin says what
// happens to those relations — coaching, end or keep — and apply the choice in
// the promotion's own transaction. Nothing is deleted; an account without open
// relations promotes exactly as before.

test.afterAll(async () => prisma.$disconnect());
test.use({ viewport: { width: 1280, height: 900 } });

const PW = 'Promotion123!';

async function sessionEmail(request: APIRequestContext): Promise<string | null> {
  const s = await (await request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

async function setup(label: string) {
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Promo ${label} ${s}`, slug: `promo-${label}-${s}` } });
  const adminEmail = uniqueEmail(`pr-${label}-admin`);
  const mentorEmail = uniqueEmail(`pr-${label}-mentor`);
  const menteeEmail = uniqueEmail(`pr-${label}-mentee`);
  await seedUser(adminEmail, PW, 'ADMIN', `Promo Admin ${label}`, org.id);
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', `Promo Mentor ${label}`, org.id);
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', `Promo Mentee ${label}`, org.id);
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'JOB_SEEKING_500' },
  });
  const cleanup = async () => {
    await prisma.mentorApplication.deleteMany({ where: { orgId: org.id } });
    await prisma.relationLifecycleEvent.deleteMany({ where: { relation: { orgId: org.id } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  };
  return { org, adminEmail, mentor, mentee, menteeEmail, relation, cleanup };
}

test('a mentor application approval asks first, applies the choice atomically and drops the old session', { tag: '@smoke' }, async ({ browser }) => {
  test.setTimeout(120_000);
  const f = await setup('app');
  try {
    const application = await prisma.mentorApplication.create({
      data: { orgId: f.org.id, fullName: 'Promo Mentee app', email: f.menteeEmail, motivation: 'I want to give back.', status: 'PENDING' },
    });

    // The applicant is signed in with their MENTEE session.
    const menteeContext = await browser.newContext();
    expect((await signInViaApi(menteeContext.request, f.menteeEmail, PW)).ok).toBe(true);
    expect(await sessionEmail(menteeContext.request)).toBe(f.menteeEmail);

    const adminContext = await browser.newContext();
    expect((await signInViaApi(adminContext.request, f.adminEmail, PW)).ok).toBe(true);
    const approve = (extra: Record<string, unknown> = {}) =>
      adminContext.request.patch(`/api/mentor-applications/${application.id}`, { data: { action: 'approve', ...extra } });

    // The admin sees the open relation before deciding.
    const detail = await (await adminContext.request.get(`/api/mentor-applications/${application.id}`)).json();
    expect(detail.openRelations).toEqual([{ id: f.relation.id, mentorName: 'Promo Mentor app', pipelineStatus: 'JOB_SEEKING_500', kind: 'PLACEMENT' }]);

    // No choice, or an unknown one: refused, and nothing moved — not the
    // application, not the role, not the relation.
    const missing = await approve();
    expect(missing.status()).toBe(400);
    expect((await missing.json()).code).toBe('promotion_choice_required');
    expect((await approve({ promotionChoice: 'DELETE' })).status()).toBe(400);
    expect((await prisma.mentorApplication.findUniqueOrThrow({ where: { id: application.id } })).status).toBe('PENDING');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.mentee.id } })).role).toBe('MENTEE');

    // COACHING: promoted, the relation stays and leaves the funnel.
    const ok = await approve({ promotionChoice: 'COACHING' });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).accountAction).toBe('promoted');
    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: f.relation.id } });
    expect([rel.status, rel.kind, rel.funnelEnteredAt]).toEqual(['ACTIVE', 'COACHING', null]);
    const promoted = await prisma.user.findUniqueOrThrow({ where: { id: f.mentee.id } });
    expect(promoted.role).toBe('MENTOR');
    expect(promoted.sessionsValidFrom).not.toBeNull();

    // The old MENTEE session is gone; the next sign-in carries the new role.
    await expect.poll(() => sessionEmail(menteeContext.request)).toBeNull();
    expect((await signInViaApi(menteeContext.request, f.menteeEmail, PW)).ok).toBe(true);
    const fresh = await (await menteeContext.request.get('/api/auth/session')).json();
    expect(fresh.user.role).toBe('MENTOR');

    // The audit row names the choice.
    const audit = await prisma.activityLog.findFirst({ where: { action: 'mentor_application.decided', targetId: application.id }, orderBy: { createdAt: 'desc' } });
    expect(audit?.detail).toContain('open relations COACHING (1)');
    await menteeContext.close();
    await adminContext.close();
  } finally {
    await f.cleanup();
  }
});

test('the role convert asks in the panel; END closes through the lifecycle and deletes nothing', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const f = await setup('convert');
  try {
    await signInAndSettle(page, f.adminEmail, PW, '/admin');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, `/admin/candidates/${f.mentee.id}`);
    await page.getByTestId(`convert-role-${f.mentee.id}`).click();
    await page.getByTestId(`convert-role-confirm-${f.mentee.id}`).click();

    // The first answer is the question: the relation and three choices, none picked.
    const prefix = `convert-role-${f.mentee.id}`;
    await expect(page.getByTestId(`${prefix}-choice`)).toBeVisible();
    await expect(page.getByTestId(`${prefix}-relations`)).toContainText('Promo Mentor convert');
    await expect(page.getByTestId(`convert-role-confirm-${f.mentee.id}`)).toBeDisabled();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.mentee.id } })).role).toBe('MENTEE');

    await page.getByTestId(`${prefix}-choice-END`).check();
    await page.getByTestId(`convert-role-confirm-${f.mentee.id}`).click();
    await expect
      .poll(async () => (await prisma.user.findUniqueOrThrow({ where: { id: f.mentee.id } })).role, { timeout: 15_000 })
      .toBe('MENTOR');
    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: f.relation.id } });
    expect([rel.status, rel.lifecycleState, rel.endReasonCode]).toEqual(['COMPLETED', 'ENDED_EARLY', 'changed_goals']);
    expect(rel.completedAt).not.toBeNull();
    const events = await prisma.relationLifecycleEvent.findMany({ where: { relationId: f.relation.id } });
    expect(events.map((e) => [e.fromState, e.toState, e.reasonCode])).toEqual([['ACTIVE', 'ENDED_EARLY', 'changed_goals']]);
    const audit = await prisma.activityLog.findFirst({ where: { action: 'user.role_changed', targetId: f.mentee.id }, orderBy: { createdAt: 'desc' } });
    expect(audit?.detail).toContain('open relations END (1)');
  } finally {
    await f.cleanup();
  }
});

test('KEEP leaves the relation as it was; an account without open relations promotes as before', async ({ request }) => {
  test.setTimeout(90_000);
  const f = await setup('keep');
  const loneEmail = uniqueEmail('pr-keep-lone');
  try {
    const lone = await seedUser(loneEmail, PW, 'MENTEE', 'Promo Lone', f.org.id);
    expect((await signInViaApi(request, f.adminEmail, PW)).ok).toBe(true);

    // No open relation: no question, one call.
    const plain = await request.patch(`/api/users/${lone.id}`, { data: { role: 'MENTOR' } });
    expect(plain.status()).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: lone.id } })).role).toBe('MENTOR');

    const missing = await request.patch(`/api/users/${f.mentee.id}`, { data: { role: 'MENTOR' } });
    expect(missing.status()).toBe(400);
    expect((await missing.json()).code).toBe('promotion_choice_required');
    const keep = await request.patch(`/api/users/${f.mentee.id}`, { data: { role: 'MENTOR', promotionChoice: 'KEEP' } });
    expect(keep.status()).toBe(200);
    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: f.relation.id } });
    expect([rel.status, rel.kind, rel.lifecycleState]).toEqual(['ACTIVE', 'PLACEMENT', f.relation.lifecycleState]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.mentee.id } })).role).toBe('MENTOR');
  } finally {
    await cleanupByEmail(loneEmail);
    await f.cleanup();
  }
});

test('the application page shows the open relations and keeps Approve shut until a choice is made', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const f = await setup('ui');
  try {
    const application = await prisma.mentorApplication.create({
      data: { orgId: f.org.id, fullName: 'Promo Mentee ui', email: f.menteeEmail, motivation: 'Ready to mentor.', status: 'UNDER_REVIEW' },
    });
    await signInAndSettle(page, f.adminEmail, PW, '/admin');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, `/admin/mentor-applications/${application.id}`);
    await expect(page.getByTestId('mentor-application-promotion-choice')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('mentor-application-promotion-relations')).toContainText('Promo Mentor ui');
    await expect(page.getByTestId('mentor-application-approve')).toBeDisabled();
    await page.getByTestId('mentor-application-promotion-choice-KEEP').check();
    await page.getByTestId('mentor-application-approve').click();
    await expect
      .poll(async () => (await prisma.mentorApplication.findUniqueOrThrow({ where: { id: application.id } })).status, { timeout: 15_000 })
      .toBe('APPROVED');
    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: f.relation.id } });
    expect([rel.status, rel.kind]).toEqual(['ACTIVE', 'PLACEMENT']);
  } finally {
    await f.cleanup();
  }
});
