import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// Offer management (#809): state machine, role scoping, the compensationNote
// sensitivity rule, audit trail, and the idempotent expiry cron.
test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedScenario(prefix: string) {
  const pw = 'OfferTestPass123!';
  const adminEmail = uniqueEmail(`${prefix}admin`);
  const mentorEmail = uniqueEmail(`${prefix}mentor`);
  const menteeEmail = uniqueEmail(`${prefix}mentee`);
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Offer Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Offer Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Offer Mentee');
  const org = await prisma.organization.create({ data: { name: `Offer Org ${Date.now()}`, slug: `offer-${Date.now()}-${Math.round(Math.random() * 10000)}` } });
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentor.id, mentee.id] } }, data: { orgId: org.id } });
  const company = await prisma.company.create({ data: { name: `Offer Co ${Date.now()}`, orgId: org.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, orgId: org.id },
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
    org,
    relation,
    cleanup: async () => {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: await prisma.offer.findMany({ where: { relationId: relation.id }, select: { id: true } }).then((os) => os.map((o) => o.id)) } } });
      await prisma.offer.deleteMany({ where: { relationId: relation.id } });
      await prisma.requisition.deleteMany({ where: { orgId: org.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await prisma.company.deleteMany({ where: { orgId: org.id } });
      await cleanupByEmail(menteeEmail);
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(adminEmail);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    },
  };
}

test('admin creates and sends an offer via the wizard; mentee accepts it and sees a persistent state', { tag: '@smoke' }, async ({ page }) => {
  const s = await seedScenario('wiz');
  try {
    const otherCompany = await prisma.company.create({ data: { name: 'Other Offer Company', orgId: s.org.id } });
    const open = await prisma.requisition.create({ data: { orgId: s.org.id, companyId: s.company.id, title: 'Open Frontend Requisition', status: 'OPEN', openings: 1, requiredSkills: [] } });
    const closed = await prisma.requisition.create({ data: { orgId: s.org.id, companyId: s.company.id, title: 'Closed Requisition', status: 'FILLED', openings: 1, filled: 1, requiredSkills: [] } });
    const other = await prisma.requisition.create({ data: { orgId: s.org.id, companyId: otherCompany.id, title: 'Other Company Requisition', status: 'OPEN', openings: 1, requiredSkills: [] } });
    await signInAndSettle(page, s.adminEmail, s.pw, '/admin');
    await page.goto(`/admin/candidates/${s.mentee.id}`);
    await expect(page.getByTestId('offer-management-panel')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('offer-create-button').click();
    const modal = page.getByTestId('offer-wizard-modal');
    await expect(modal).toBeVisible();
    await modal.getByLabel('Position').fill('Frontend Developer');
    const requisitionSelect = modal.getByTestId('offer-requisition-select');
    await expect(requisitionSelect).toBeVisible();
    await expect(requisitionSelect.locator('option')).toHaveText(['No requisition', 'Open Frontend Requisition']);
    await expect(requisitionSelect).not.toContainText(closed.title);
    await expect(requisitionSelect).not.toContainText(other.title);
    await requisitionSelect.selectOption('');
    await requisitionSelect.selectOption(open.id);
    await modal.getByRole('button', { name: 'Next' }).click();
    await modal.getByRole('button', { name: 'Next' }).click();
    const sent = page.waitForResponse((r) => r.url().includes('/api/offers/') && r.request().method() === 'PATCH');
    await modal.getByRole('button', { name: 'Save and send' }).click();
    await sent;

    const offer = await prisma.offer.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect(offer.status).toBe('SENT');
    expect(offer.position).toBe('Frontend Developer');
    expect(offer.requisitionId).toBe(open.id);
    await expect(page.getByTestId(`offer-requisition-title-${offer.id}`)).toHaveText('Requisition (optional): Open Frontend Requisition');
    await expect(page.getByTestId(`offer-row-${offer.id}`)).not.toContainText(open.id);

    // Mentee sees the offer and accepts it.
    await signInAsFreshUser(page, s.menteeEmail, s.pw, '/portal');
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

    // The acceptance took the requisition's only seat (#1411/#1854): counted
    // once, FILLED, closed — in the same transaction as the offer itself.
    const filled = await prisma.requisition.findUniqueOrThrow({ where: { id: open.id } });
    expect(filled.filled).toBe(1);
    expect(filled.status).toBe('FILLED');
    expect(filled.closedAt).not.toBeNull();
    expect(after.requisitionCountedAt).not.toBeNull();
  } finally {
    await s.cleanup();
  }
});

test('offer create and draft edit validate requisitions and allow an optional cleared value', async ({ page }) => {
  const s = await seedScenario('reqvalidation');
  try {
    const otherCompany = await prisma.company.create({ data: { name: 'Validation Other Company', orgId: s.org.id } });
    const valid = await prisma.requisition.create({ data: { orgId: s.org.id, companyId: s.company.id, title: 'Valid Requisition', status: 'OPEN', openings: 1, requiredSkills: [] } });
    const wrongCompany = await prisma.requisition.create({ data: { orgId: s.org.id, companyId: otherCompany.id, title: 'Wrong Company', status: 'OPEN', openings: 1, requiredSkills: [] } });
    await signInAndSettle(page, s.adminEmail, s.pw, '/admin');

    const create = (requisitionId?: string | null) => page.request.post('/api/offers', { data: {
      relationId: s.relation.id, position: 'API-created role', ...(requisitionId === undefined ? {} : { requisitionId }),
    } });
    const validCreate = await create(valid.id);
    expect(validCreate.status()).toBe(201);
    const validOfferId = (await validCreate.json()).offer.id as string;
    expect((await create(null)).status()).toBe(201);
    expect((await create()).status()).toBe(201);

    const missingCreate = await create('missing-requisition-id');
    expect(missingCreate.status()).toBe(404);
    expect(await missingCreate.json()).toMatchObject({ code: 'requisition_not_found' });
    const mismatchCreate = await create(wrongCompany.id);
    expect(mismatchCreate.status()).toBe(400);
    expect(await mismatchCreate.json()).toMatchObject({ code: 'requisition_company_mismatch' });

    const validPatch = await page.request.patch(`/api/offers/${validOfferId}`, { data: { requisitionId: valid.id } });
    expect(validPatch.status()).toBe(200);
    const missingPatch = await page.request.patch(`/api/offers/${validOfferId}`, { data: { requisitionId: 'missing-requisition-id' } });
    expect(missingPatch.status()).toBe(404);
    expect(await missingPatch.json()).toMatchObject({ code: 'requisition_not_found' });
    const mismatchPatch = await page.request.patch(`/api/offers/${validOfferId}`, { data: { requisitionId: wrongCompany.id } });
    expect(mismatchPatch.status()).toBe(400);
    expect(await mismatchPatch.json()).toMatchObject({ code: 'requisition_company_mismatch' });
    const clearPatch = await page.request.patch(`/api/offers/${validOfferId}`, { data: { requisitionId: '' } });
    expect(clearPatch.status()).toBe(200);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: validOfferId } })).requisitionId).toBeNull();
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

    await signInAndSettle(page, s.menteeEmail, s.pw, '/portal');
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

    await signInAndSettle(page, s.adminEmail, s.pw, '/admin');
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

    await signInAndSettle(page, otherMenteeEmail, s.pw, '/portal');
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

    await signInAndSettle(page, s.menteeEmail, s.pw, '/portal');

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
    await signInAndSettle(page, companyEmail, s.pw, '/company');
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
    await signInAsFreshUser(page, s.menteeEmail, s.pw, '/portal');
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
    await signInAndSettle(page, companyEmail, 'OfferTestPass123!', '/company');
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

    await signInAndSettle(page, s.adminEmail, s.pw, '/admin');
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

    await signInAndSettle(page, s.adminEmail, s.pw, '/admin');
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

// #1411/#1854 — an accepted offer fills its requisition. The counter is the
// "how many roles are still open" number, so the properties that matter are
// the ones a hand-kept counter got wrong: exactly one per acceptance, never
// past `openings`, and never at the candidate's expense.
test('accepted offers fill a requisition: once each, never past openings, and a full one never blocks the candidate', async ({ page }) => {
  const s = await seedScenario('reqfill');
  const sentOffer = (requisitionId: string | null, position: string) =>
    prisma.offer.create({
      data: {
        orgId: s.org.id, relationId: s.relation.id, companyId: s.company.id, requisitionId,
        position, status: 'SENT', sentAt: new Date(), createdById: s.admin.id,
      },
    });
  try {
    const req = await prisma.requisition.create({
      data: { orgId: s.org.id, companyId: s.company.id, title: 'Three Seats', status: 'OPEN', openings: 3, requiredSkills: [] },
    });
    await signInAndSettle(page, s.adminEmail, s.pw, '/admin');
    const accept = (id: string) => page.request.patch(`/api/offers/${id}`, { data: { action: 'accept' } });

    // One acceptance, one seat; the requisition stays open below capacity.
    const first = await sentOffer(req.id, 'Seat one');
    expect((await accept(first.id)).status()).toBe(200);
    let row = await prisma.requisition.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.filled).toBe(1);
    expect(row.status).toBe('OPEN');
    expect(row.closedAt).toBeNull();

    // A replayed accept is refused by the state machine and counts nothing.
    expect((await accept(first.id)).status()).toBe(400);
    expect((await prisma.requisition.findUniqueOrThrow({ where: { id: req.id } })).filled).toBe(1);

    // An offer with no requisition touches no counter.
    const unlinked = await sentOffer(null, 'No requisition');
    expect((await accept(unlinked.id)).status()).toBe(200);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: unlinked.id } })).requisitionCountedAt).toBeNull();

    // Three offers race for the last two seats: exactly two count, the
    // requisition flips to FILLED once, and all three candidates are ACCEPTED.
    const racers = await Promise.all([sentOffer(req.id, 'Race A'), sentOffer(req.id, 'Race B'), sentOffer(req.id, 'Race C')]);
    const statuses = await Promise.all(racers.map((o) => accept(o.id).then((r) => r.status())));
    expect(statuses).toEqual([200, 200, 200]);
    row = await prisma.requisition.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.filled).toBe(3);
    expect(row.status).toBe('FILLED');
    expect(row.closedAt).not.toBeNull();
    const decided = await prisma.offer.findMany({ where: { id: { in: racers.map((o) => o.id) } } });
    expect(decided.every((o) => o.status === 'ACCEPTED')).toBe(true);
    expect(decided.filter((o) => o.requisitionCountedAt !== null)).toHaveLength(2);

    // The refused count is on the record, where the admin reads the offer's history.
    const refused = decided.find((o) => o.requisitionCountedAt === null)!;
    const refusedAudit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: refused.id, action: 'offer.accept' } });
    expect(refusedAudit.detail).toContain('full — not counted');

    // A cancelled requisition takes no seats either.
    const cancelled = await prisma.requisition.create({
      data: { orgId: s.org.id, companyId: s.company.id, title: 'Cancelled', status: 'CANCELLED', openings: 2, requiredSkills: [] },
    });
    const late = await sentOffer(cancelled.id, 'Too late');
    expect((await accept(late.id)).status()).toBe(200);
    expect((await prisma.requisition.findUniqueOrThrow({ where: { id: cancelled.id } })).filled).toBe(0);
  } finally {
    await s.cleanup();
  }
});
