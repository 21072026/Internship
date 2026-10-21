import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, userInWorld } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// #1723 — /admin/sla: the breach queue lists the caller's open breaches only,
// filters, and acknowledges (audited); the compliance rate is reported with
// numerator, denominator and its definition.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;
const STAGE = 'APPROVAL_PENDING_220';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedBreach(prefix: string, orgId: string | null, menteeName: string, daysPast: number) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', `Queue Mentor ${prefix}`);
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', menteeName);
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId } });
  const dueAt = new Date(Date.now() - daysPast * DAY);
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId, status: 'ACTIVE', pipelineStatus: STAGE, stageDeadline: dueAt },
  });
  const breach = await prisma.slaBreach.create({ data: { orgId, relationId: relation.id, stageKey: STAGE, dueAt, level: 1 } });
  return { mentorEmail, menteeEmail, mentor, mentee, relation, breach };
}

test('the queue lists, filters and acknowledges the caller’s breaches only', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const admin = await userInWorld(ADMIN_EMAIL, 'INTERNSHIP', { id: true, orgId: true });
  const orgId = admin!.orgId!;
  const stamp = Date.now();
  const other = await prisma.organization.create({ data: { name: 'Queue Other Org', slug: `queue-other-${stamp}` } });
  const mine = await seedBreach('q-mine', orgId, `Queue Alpha ${stamp}`, 3);
  const mine2 = await seedBreach('q-mine2', orgId, `Queue Beta ${stamp}`, 6);
  const theirs = await seedBreach('q-theirs', other.id, `Queue Foreign ${stamp}`, 4);
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    // The route: own breaches only, filtered server-side.
    const listed = await page.request.get(`/api/admin/sla?q=${encodeURIComponent(String(stamp))}`);
    expect(listed.ok()).toBeTruthy();
    const body = await listed.json();
    const ids = body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([mine.breach.id, mine2.breach.id]));
    expect(ids).not.toContain(theirs.breach.id);
    // Oldest deadline first.
    expect(ids.indexOf(mine2.breach.id)).toBeLessThan(ids.indexOf(mine.breach.id));

    // Another tenant's id is "not found" for the bulk route too.
    const cross = await page.request.post('/api/admin/sla/acknowledge', { data: { ids: [theirs.breach.id] } });
    expect(await cross.json()).toEqual({ acknowledged: [], missing: [theirs.breach.id] });
    expect((await prisma.slaBreach.findUniqueOrThrow({ where: { id: theirs.breach.id } })).acknowledgedAt).toBeNull();

    // The page: filter box (scoped by testid, not AdminNav's search box), then acknowledge.
    await gotoSettled(page, '/admin/sla');
    await page.getByTestId('sla-filter').fill(`Queue Alpha ${stamp}`);
    const table = page.getByTestId('sla-table');
    await expect(table.getByText(`Queue Alpha ${stamp}`, { exact: true })).toBeVisible();
    await expect(table.getByText(`Queue Beta ${stamp}`, { exact: true })).toHaveCount(0);
    await page.getByTestId(`sla-ack-${mine.breach.id}`).click();
    await expect(page.getByTestId(`sla-ack-${mine.breach.id}`)).toHaveCount(0);
    const acked = await prisma.slaBreach.findUniqueOrThrow({ where: { id: mine.breach.id } });
    expect(acked.acknowledgedAt).not.toBeNull();
    expect(acked.acknowledgedById).toBe(admin!.id);
    expect(await prisma.activityLog.count({ where: { action: 'sla.breach_acknowledged', targetId: mine.breach.id } })).toBe(1);

    // The acknowledged filter.
    const notAcked = await (await page.request.get(`/api/admin/sla?q=${stamp}&acknowledged=no`)).json();
    expect(notAcked.items.map((i: { id: string }) => i.id)).toEqual([mine2.breach.id]);

    // The compliance card states its definition.
    await expect(page.getByTestId('sla-compliance-definition')).toBeVisible();
  } finally {
    for (const p of [mine, mine2, theirs]) {
      await cleanupByEmail(p.menteeEmail);
      await cleanupByEmail(p.mentorEmail);
    }
    await prisma.organization.delete({ where: { id: other.id } }).catch(() => {});
  }
});

test('the compliance rate reports numerator and denominator over the period', async ({ page }) => {
  test.slow();
  const admin = await userInWorld(ADMIN_EMAIL, 'INTERNSHIP', { id: true, orgId: true });
  const orgId = admin!.orgId!;
  const prior = await prisma.stageSla.findUnique({ where: { orgId_stageKey: { orgId, stageKey: STAGE } } });
  await prisma.stageSla.upsert({
    where: { orgId_stageKey: { orgId, stageKey: STAGE } },
    update: { days: 5 },
    create: { orgId, stageKey: STAGE, days: 5 },
  });
  const p = await seedBreach('q-rate', orgId, `Queue Rate ${Date.now()}`, 1);
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const before = await (await page.request.get('/api/admin/sla/compliance?days=30')).json();
    // One move out of the SLA stage after 2 days (met), recorded as history.
    await prisma.mentorshipRelation.update({ where: { id: p.relation.id }, data: { startDate: new Date(Date.now() - 10 * DAY) } });
    await prisma.statusChange.createMany({
      data: [
        { relationId: p.relation.id, fromStatus: 'APPLICATION_100', toStatus: STAGE, createdAt: new Date(Date.now() - 4 * DAY) },
        { relationId: p.relation.id, fromStatus: STAGE, toStatus: 'INTERVIEW_PENDING_250', createdAt: new Date(Date.now() - 2 * DAY) },
      ],
    });
    const after = await (await page.request.get('/api/admin/sla/compliance?days=30')).json();
    expect(after.days).toBe(30);
    expect(after.total).toBe(before.total + 1);
    expect(after.met).toBe(before.met + 1);
    expect(typeof after.from).toBe('string');
  } finally {
    await cleanupByEmail(p.menteeEmail);
    await cleanupByEmail(p.mentorEmail);
    if (prior) await prisma.stageSla.update({ where: { id: prior.id }, data: { days: prior.days } });
    else await prisma.stageSla.deleteMany({ where: { orgId, stageKey: STAGE } });
  }
});
