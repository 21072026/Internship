import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

// The SOURCE outcome panel (#1914): a referral partner sees what ITS referrals
// became — and nothing of another partner's. Tagged @smoke for the isolation
// and fail-closed halves: they are a tenant/scope boundary.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = 'SourcePass123!';
const DAY = 24 * 60 * 60 * 1000;

test('a source sees only its own referral outcomes; no source id is a 403', { tag: '@smoke' }, async ({ page }) => {
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Outcomes Org ${stamp}`, slug: `outcomes-${stamp}` } });
  const [srcA, srcB] = await Promise.all([
    prisma.source.create({ data: { name: `Career Centre A ${stamp}`, orgId: org.id } }),
    prisma.source.create({ data: { name: `Career Centre B ${stamp}`, orgId: org.id } }),
  ]);
  const emails = {
    repA: uniqueEmail('so-rep-a'),
    repB: uniqueEmail('so-rep-b'),
    orphan: uniqueEmail('so-orphan'),
    mentor: uniqueEmail('so-mentor'),
    a1: uniqueEmail('so-a1'),
    a2: uniqueEmail('so-a2'),
    a3: uniqueEmail('so-a3'),
    b1: uniqueEmail('so-b1'),
  };
  const repA = await seedUser(emails.repA, PASSWORD, 'SOURCE', 'Rep A', org.id);
  const repB = await seedUser(emails.repB, PASSWORD, 'SOURCE', 'Rep B', org.id);
  await seedUser(emails.orphan, PASSWORD, 'SOURCE', 'Rep Without Source', org.id);
  await prisma.user.update({ where: { id: repA.id }, data: { sourceId: srcA.id } });
  await prisma.user.update({ where: { id: repB.id }, data: { sourceId: srcB.id } });
  const mentor = await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'Outcome Mentor', org.id);

  const referredAt = new Date(Date.now() - 40 * DAY);
  const mkMentee = async (email: string, name: string, sourceId: string) => {
    const u = await seedUser(email, PASSWORD, 'MENTEE', name, org.id);
    return prisma.user.update({ where: { id: u.id }, data: { sourceId, createdAt: referredAt } });
  };
  const a1 = await mkMentee(emails.a1, 'Alpha Placed', srcA.id);
  const a2 = await mkMentee(emails.a2, 'Alpha Interviewing', srcA.id);
  await mkMentee(emails.a3, 'Alpha Waiting', srcA.id);
  const b1 = await mkMentee(emails.b1, 'Bravo Only', srcB.id);

  // a1: placed 10 days after referral. a2: still in the pipeline.
  const placedRel = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: mentor.id, menteeId: a1.id, status: 'COMPLETED', pipelineStatus: 'HIRED_660', startDate: referredAt },
  });
  await prisma.statusChange.create({
    data: { relationId: placedRel.id, fromStatus: 'INTERVIEW_PENDING_250', toStatus: 'HIRED_660', createdAt: new Date(referredAt.getTime() + 10 * DAY) },
  });
  const openRel = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: mentor.id, menteeId: a2.id, status: 'ACTIVE', pipelineStatus: 'INTERVIEW_PENDING_250', startDate: referredAt },
  });

  try {
    await signInAsFreshUser(page, emails.repA, PASSWORD, '/source');
    const res = await page.request.get('/api/source/outcomes');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.referred).toBe(3);
    expect(body.placed).toBe(1);
    expect(body.inPipeline).toBe(1);
    expect(body.notPickedUp).toBe(1);
    // Three referrals is below the floor: counts yes, a rate no.
    expect(body.conversion).toBeNull();
    expect(body.suppressed).toBe(true);
    expect(body.programmeConversion).toBeNull();
    // The median covers the one placed referral only.
    expect(body.timeToPlacement).toMatchObject({ medianDays: 10, placed: 1, considered: 3 });
    // Stage labels are the tenant's resolved labels, never enum keys.
    const interview = body.stages.find((s: { key: string }) => s.key === 'INTERVIEW_PENDING_250');
    expect(interview.count).toBe(1);
    expect(interview.label).not.toBe('INTERVIEW_PENDING_250');
    const ids = body.rows.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(b1.id);
    expect(body.rows.map((r: { fullName: string }) => r.fullName).sort()).toEqual(['Alpha Interviewing', 'Alpha Placed', 'Alpha Waiting']);

    // The panel renders the same numbers, linked from the portal.
    await page.getByTestId('source-outcomes-link').click();
    await page.waitForURL('**/source/outcomes');
    await expect(page.getByTestId('outcomes-referred')).toHaveText('3');
    await expect(page.getByTestId('outcomes-placed')).toHaveText('1');
    await expect(page.getByTestId('outcomes-conversion')).toHaveText('—');
    await expect(page.getByTestId(`outcomes-row-${a1.id}`)).toBeVisible();
    await expect(page.getByTestId(`outcomes-row-${b1.id}`)).toHaveCount(0);

    // The export holds this source's rows only.
    const download = page.waitForEvent('download');
    await page.getByTestId('outcomes-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);

    // A second source sees nothing of the first.
    await signInAsFreshUser(page, emails.repB, PASSWORD, '/source');
    const other = await (await page.request.get('/api/source/outcomes')).json();
    expect(other.referred).toBe(1);
    expect(other.rows.map((r: { id: string }) => r.id)).toEqual([b1.id]);

    // A SOURCE login with no source is refused, not answered unscoped.
    await signInAsFreshUser(page, emails.orphan, PASSWORD, '/source');
    expect((await page.request.get('/api/source/outcomes')).status()).toBe(403);
    await gotoSettled(page, '/source/outcomes');
    await expect(page.getByTestId('outcomes-error')).toBeVisible();
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: { in: [placedRel.id, openRel.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [placedRel.id, openRel.id] } } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.source.deleteMany({ where: { id: { in: [srcA.id, srcB.id] } } });
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
