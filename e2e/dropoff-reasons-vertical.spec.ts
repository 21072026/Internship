import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStages } from '../src/lib/programTemplates';
import { DROPOFF_REASON_CODES, MARKETING_DROPOFF_REASON_CODES } from '../src/lib/dropoffReasons';

// Lost-deal reasons per vertical (#2573). A SaleVali rep moving a lead to
// DEAL_LOST was offered hiring reasons ("Skill mismatch", "Location"), so every
// loss was filed as OTHER and the breakdown said nothing. The org's vertical
// now decides the list — on the write path (validateDropoffReason) and in the
// picker — and the other product's codes are refused, not mapped.

const PW = 'LossReason123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedMarketing(prefix: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Loss ${stamp}`, slug: `loss-${prefix}-${stamp}`, vertical: 'MARKETING' },
  });
  const template = defaultTemplateForVertical('MARKETING');
  const stages = template ? templateStages(template, 'en') : [];
  await prisma.pipelineStage.createMany({
    data: stages.map((s) => ({
      orgId: org.id, key: s.key, label: s.label, order: s.order,
      isTerminal: s.isTerminal, isOffPath: s.isOffPath, color: s.color,
    })),
  });
  const emails = [uniqueEmail(`${prefix}-admin`), uniqueEmail(`${prefix}-rep`), uniqueEmail(`${prefix}-lead`)];
  const admin = await seedUser(emails[0], PW, 'ADMIN', 'Loss Admin');
  const rep = await seedUser(emails[1], PW, 'MENTOR', 'Loss Rep');
  const lead = await seedUser(emails[2], PW, 'MENTEE', 'Loss Lead');
  await prisma.user.updateMany({ where: { id: { in: [admin.id, rep.id, lead.id] } }, data: { orgId: org.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, status: 'ACTIVE', pipelineStatus: 'LEAD_NEW' },
  });
  return {
    org, emails, lead, relation,
    cleanup: async () => {
      await prisma.statusChange.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      for (const e of emails) await cleanupByEmail(e);
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    },
  };
}

test('a MARKETING loss takes a sales reason and refuses a hiring one (#2573)', async ({ page }) => {
  const s = await seedMarketing('api');
  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST)); // MARKETING-org account => marketing host only (#2590)
    await signInAndSettle(page, s.emails[0], PW, '/admin');

    const hiring = await page.request.put(`/api/mentorship/${s.relation.id}`, {
      data: { pipelineStatus: 'DEAL_LOST', reasonCode: 'SKILL_MISMATCH' },
    });
    expect(hiring.status()).toBe(400);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } })).pipelineStatus).toBe('LEAD_NEW');

    const sales = await page.request.put(`/api/mentorship/${s.relation.id}`, {
      data: { pipelineStatus: 'DEAL_LOST', reasonCode: 'COMPETITOR' },
    });
    expect(sales.status()).toBe(200);
    const change = await prisma.statusChange.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect([change.toStatus, change.reasonCode]).toEqual(['DEAL_LOST', 'COMPETITOR']);
  } finally {
    await s.cleanup();
  }
});

test('the MARKETING reason picker offers exactly the sales list (#2573)', async ({ page }) => {
  const s = await seedMarketing('ui');
  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST)); // MARKETING-org account => marketing host only (#2590)
    await signInAndSettle(page, s.emails[0], PW, '/admin');
    await page.goto(`/admin/candidates/${s.lead.id}`);
    await expect(page.getByTestId('stage-select')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('stage-select').selectOption('DEAL_LOST');
    await expect(page.getByTestId('dropoff-reason-dialog')).toBeVisible();
    const values = await page
      .getByTestId('dropoff-reason-select')
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(values).toEqual([...MARKETING_DROPOFF_REASON_CODES]);
    await expect(page.getByTestId('dropoff-reason-select').locator('option', { hasText: 'Chose a competitor' })).toHaveCount(1);

    await page.getByTestId('dropoff-reason-select').selectOption('PRICE');
    const put = page.waitForResponse((r) => r.url().includes(`/api/mentorship/${s.relation.id}`) && r.request().method() === 'PUT');
    await page.getByTestId('dropoff-reason-confirm').click();
    expect((await put).ok()).toBe(true);
    const change = await prisma.statusChange.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect(change.reasonCode).toBe('PRICE');
  } finally {
    await s.cleanup();
  }
});

test('an INTERNSHIP drop-off still takes the hiring list and refuses a sales reason (#2573)', async ({ page }) => {
  const emails = [uniqueEmail('loss-int-admin'), uniqueEmail('loss-int-mentor'), uniqueEmail('loss-int-mentee')];
  const admin = await seedUser(emails[0], PW, 'ADMIN', 'Int Admin');
  const mentor = await seedUser(emails[1], PW, 'MENTOR', 'Int Mentor');
  const mentee = await seedUser(emails[2], PW, 'MENTEE', 'Int Mentee');
  void admin;
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  try {
    await signInAndSettle(page, emails[0], PW, '/admin');
    const sales = await page.request.put(`/api/mentorship/${relation.id}`, {
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'PRICE' },
    });
    expect(sales.status()).toBe(400);
    const hiring = await page.request.put(`/api/mentorship/${relation.id}`, {
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'SKILL_MISMATCH' },
    });
    expect(hiring.status()).toBe(200);
    expect(DROPOFF_REASON_CODES).toContain('SKILL_MISMATCH');
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of emails) await cleanupByEmail(e);
  }
});
