import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Offer management (#809): state machine, role scoping, the compensationNote
// sensitivity rule, audit trail, and the idempotent expiry cron.
test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page, email: string, password: string, redirectPrefix: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(redirectPrefix), { timeout: 20_000 });
}

async function seedScenario(prefix: string) {
  const pw = 'OfferTestPass123!';
  const adminEmail = uniqueEmail(`${prefix}admin`);
  const mentorEmail = uniqueEmail(`${prefix}mentor`);
  const menteeEmail = uniqueEmail(`${prefix}mentee`);
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Offer Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Offer Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Offer Mentee');
  const company = await prisma.company.create({ data: { name: `Offer Co ${Date.now()}` } });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id },
  });

  return {
    pw,
    adminEmail,
    mentorEmail,
    menteeEmail,
    admin,
    mentor,
    mentee,
    company,
    relation,
    cleanup: async () => {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: await prisma.offer.findMany({ where: { relationId: relation.id }, select: { id: true } }).then((os) => os.map((o) => o.id)) } } });
      await prisma.offer.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await prisma.company.deleteMany({ where: { id: company.id } });
      await cleanupByEmail(menteeEmail);
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(adminEmail);
    },
  };
}

test('admin creates and sends an offer via the wizard; mentee accepts it and sees a persistent state', { tag: '@smoke' }, async ({ page }) => {
  const s = await seedScenario('wiz');
  try {
    await signIn(page, s.adminEmail, s.pw, '/admin');
    await page.goto(`/admin/candidates/${s.mentee.id}`);
    await expect(page.getByTestId('offer-management-panel')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('offer-create-button').click();
    const modal = page.getByTestId('offer-wizard-modal');
    await expect(modal).toBeVisible();
    await modal.getByLabel('Position').fill('Frontend Developer');
    await modal.getByRole('button', { name: 'Next' }).click();
    await modal.getByRole('button', { name: 'Next' }).click();
    const sent = page.waitForResponse((r) => r.url().includes('/api/offers/') && r.request().method() === 'PATCH');
    await modal.getByRole('button', { name: 'Save and send' }).click();
    await sent;

    const offer = await prisma.offer.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect(offer.status).toBe('SENT');
    expect(offer.position).toBe('Frontend Developer');

    // Mentee sees the offer and accepts it.
    await page.context().clearCookies();
    await signIn(page, s.menteeEmail, s.pw, '/portal');
    await expect(page.getByTestId('offer-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('offer-card')).toContainText('Frontend Developer');
    await page.getByTestId('offer-accept-button').click();
    const accepted = page.waitForResponse((r) => r.url().includes(`/api/offers/${offer.id}`) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Yes, accept' }).click();
    await accepted;
    await expect(page.getByTestId('offer-card-decided')).toContainText('Offer accepted');

    // Persistent — reloading still shows the decided state, not the form again.
    await page.reload();
    await expect(page.getByTestId('offer-card-decided')).toContainText('Offer accepted');

    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.status).toBe('ACCEPTED');
    expect(after.decidedById).toBe(s.mentee.id);

    const auditActions = (await prisma.auditLog.findMany({ where: { targetId: offer.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(auditActions).toEqual(['offer.create', 'offer.send', 'offer.accept']);
  } finally {
    await s.cleanup();
  }
});

test('mentee declines an offer with a reason and sees a persistent declined state', async ({ page }) => {
  const s = await seedScenario('decl');
  try {
    const offer = await prisma.offer.create({
      data: {
        relationId: s.relation.id,
        companyId: s.company.id,
        status: 'SENT',
        position: 'Backend Developer',
        sentAt: new Date(),
        createdById: s.admin.id,
      },
    });

    await signIn(page, s.menteeEmail, s.pw, '/portal');
    await expect(page.getByTestId('offer-card')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('offer-decline-button').click();
    await page.getByTestId('offer-decline-reason').selectOption('LOCATION');
    const declined = page.waitForResponse((r) => r.url().includes(`/api/offers/${offer.id}`) && r.request().method() === 'PATCH');
    await page.getByTestId('offer-decline-submit').click();
    await declined;
    await expect(page.getByTestId('offer-card-decided')).toContainText('Offer declined');

    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.status).toBe('DECLINED');
    expect(after.declineReasonCode).toBe('LOCATION');

    const auditActions = (await prisma.auditLog.findMany({ where: { targetId: offer.id } })).map((a) => a.action);
    expect(auditActions).toContain('offer.decline');
  } finally {
    await s.cleanup();
  }
});

test('an invalid state transition is rejected with 400', async ({ page }) => {
  const s = await seedScenario('inv');
  try {
    const draft = await prisma.offer.create({
      data: { relationId: s.relation.id, companyId: s.company.id, status: 'DRAFT', position: 'QA Engineer', createdById: s.admin.id },
    });

    await signIn(page, s.adminEmail, s.pw, '/admin');
    // DRAFT -> ACCEPTED is not a legal edge (only DRAFT -> SENT is).
    const res = await page.request.fetch(`/api/offers/${draft.id}`, {
      method: 'PATCH',
      data: { action: 'accept' },
    });
    expect(res.status()).toBe(400);

    const unchanged = await prisma.offer.findUniqueOrThrow({ where: { id: draft.id } });
    expect(unchanged.status).toBe('DRAFT');
  } finally {
    await s.cleanup();
  }
});

test('a mentee cannot read another mentee\'s offer', async ({ page }) => {
  const s = await seedScenario('idor');
  const otherMenteeEmail = uniqueEmail('idorother');
  const otherMentee = await seedUser(otherMenteeEmail, s.pw, 'MENTEE', 'Other Mentee');
  try {
    const offer = await prisma.offer.create({
      data: { relationId: s.relation.id, companyId: s.company.id, status: 'SENT', position: 'Data Analyst', sentAt: new Date(), createdById: s.admin.id },
    });

    await signIn(page, otherMenteeEmail, s.pw, '/portal');
    const res = await page.request.get(`/api/offers/${offer.id}`);
    expect(res.status()).toBe(403);

    const list = await page.request.get('/api/offers');
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect((body.offers as { id: string }[]).some((o) => o.id === offer.id)).toBe(false);
  } finally {
    await cleanupByEmail(otherMenteeEmail);
    await s.cleanup();
  }
});

test('a mentee cannot list a DRAFT offer by asking for it explicitly', async ({ page }) => {
  const s = await seedScenario('draftfilter');
  try {
    const draft = await prisma.offer.create({
      data: {
        relationId: s.relation.id,
        companyId: s.company.id,
        status: 'DRAFT',
        position: 'Unsent Role',
        compensationNote: 'draft-only-compensation',
        createdById: s.admin.id,
      },
    });

    await signIn(page, s.menteeEmail, s.pw, '/portal');

    // The role filter must win over the query string: ?status=DRAFT used to
    // skip the not-DRAFT guard and leak the admin's unsent staging offer.
    const res = await page.request.get('/api/offers?status=DRAFT');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect((JSON.parse(body).offers as { id: string }[]).some((o) => o.id === draft.id)).toBe(false);
    expect(body).not.toContain('draft-only-compensation');
  } finally {
    await s.cleanup();
  }
});

test('an unauthorized/other role never receives compensationNote in the response body', { tag: '@smoke' }, async ({ page }) => {
  const s = await seedScenario('comp');
  const companyEmail = uniqueEmail('compuser');
  const companyUser = await prisma.user.create({
    data: { email: companyEmail, password: await bcrypt.hash(s.pw, 10), role: 'COMPANY', fullName: 'Comp Observer', companyId: s.company.id, skills: [] },
  });
  try {
    const offer = await prisma.offer.create({
      data: {
        relationId: s.relation.id,
        companyId: s.company.id,
        status: 'SENT',
        position: 'Platform Engineer',
        compensationNote: 'Base 45k + equity — do not leak this',
        sentAt: new Date(),
        createdById: s.admin.id,
      },
    });

    // COMPANY may see the offer (it's theirs) but must never get compensationNote.
    await signIn(page, companyEmail, s.pw, '/company');
    const res = await page.request.get(`/api/offers/${offer.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.offer.position).toBe('Platform Engineer');
    expect(body.offer).not.toHaveProperty('compensationNote');
    expect(JSON.stringify(body)).not.toContain('do not leak this');

    const listRes = await page.request.get('/api/offers');
    const listBody = await listRes.json();
    for (const o of listBody.offers) expect(o).not.toHaveProperty('compensationNote');

    // The mentee it belongs to IS authorized to see it (they need it to decide).
    await page.context().clearCookies();
    await signIn(page, s.menteeEmail, s.pw, '/portal');
    const menteeRes = await page.request.get(`/api/offers/${offer.id}`);
    expect(menteeRes.status()).toBe(200);
    const menteeBody = await menteeRes.json();
    expect(menteeBody.offer.compensationNote).toBe('Base 45k + equity — do not leak this');
  } finally {
    await prisma.user.deleteMany({ where: { id: companyUser.id } });
    await s.cleanup();
  }
});

test('a company with no companyId gets 403, not a query against null', async ({ page }) => {
  const companyEmail = uniqueEmail('nocompany');
  const orphanCompanyUser = await prisma.user.create({
    data: { email: companyEmail, password: await bcrypt.hash('OfferTestPass123!', 10), role: 'COMPANY', fullName: 'No Company', companyId: null, skills: [] },
  });
  try {
    await signIn(page, companyEmail, 'OfferTestPass123!', '/company');
    const res = await page.request.get('/api/offers');
    expect(res.status()).toBe(403);
  } finally {
    await prisma.user.deleteMany({ where: { id: orphanCompanyUser.id } });
  }
});

test('admin can withdraw a sent offer', async ({ page }) => {
  const s = await seedScenario('wd');
  try {
    const offer = await prisma.offer.create({
      data: { relationId: s.relation.id, companyId: s.company.id, status: 'SENT', position: 'DevOps Engineer', sentAt: new Date(), createdById: s.admin.id },
    });

    await signIn(page, s.adminEmail, s.pw, '/admin');
    await page.goto(`/admin/candidates/${s.mentee.id}`);
    await expect(page.getByTestId(`offer-row-${offer.id}`)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Withdraw' }).first().click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    const withdrawn = page.waitForResponse((r) => r.url().includes(`/api/offers/${offer.id}`) && r.request().method() === 'PATCH');
    await page.getByTestId('confirm-dialog-confirm').click();
    await withdrawn;

    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.status).toBe('WITHDRAWN');
  } finally {
    await s.cleanup();
  }
});

test('the expiry cron transitions a due offer exactly once across two runs', async ({ page }) => {
  const s = await seedScenario('exp');
  try {
    const offer = await prisma.offer.create({
      data: {
        relationId: s.relation.id,
        companyId: s.company.id,
        status: 'SENT',
        position: 'Site Reliability Engineer',
        sentAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        createdById: s.admin.id,
      },
    });

    await signIn(page, s.adminEmail, s.pw, '/admin');
    const first = await page.request.get('/api/cron');
    expect(first.status()).toBe(200);
    const second = await page.request.get('/api/cron');
    expect(second.status()).toBe(200);

    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.status).toBe('EXPIRED');

    const expireLogs = await prisma.auditLog.findMany({ where: { targetId: offer.id, action: 'offer.expire' } });
    expect(expireLogs).toHaveLength(1);

    const notifications = await prisma.notification.findMany({ where: { userId: s.admin.id, type: 'offer_expired.admin' } });
    expect(notifications).toHaveLength(1);
  } finally {
    await s.cleanup();
  }
});
