import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// Plan-change requests (#1743): a tenant admin asks, a super admin of the org's
// world applies, and the plan moves — the subscription AND the legacy
// Organization.plan — in one go.
//
// The boundaries pinned here: the tenant route takes no orgId (one in the body
// is ignored), a second submit updates the one open request instead of adding
// a second, a MENTOR is refused by the handler, and the operator queue answers
// 403 to a tenant admin — read or write. A request handled once answers 409.

const PW = 'PlanChange123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('submit → apply moves the plan; only a super admin may apply', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tenant = await prisma.organization.create({ data: { name: `Plan Tenant ${stamp}`, slug: `plan-tenant-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `Plan Other ${stamp}`, slug: `plan-other-${stamp}` } });
  const def = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });

  const emails = {
    admin: uniqueEmail('plan-admin'),
    mentor: uniqueEmail('plan-mentor'),
    operator: uniqueEmail('plan-operator'),
  };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'Plan Admin', { orgId: tenant.id });
  await seedUser(emails.mentor, PW, 'MENTOR', 'Plan Mentor', { orgId: tenant.id });
  const operator = await seedUser(emails.operator, PW, 'ADMIN', 'Plan Operator', { orgId: def.id });
  await prisma.user.update({ where: { id: operator.id }, data: { isSuperAdmin: true } });

  const jars: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
  const jar = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    jars.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { headers: freshIp(`plan-${email}`) })).error).toBeNull();
    return ctx;
  };

  try {
    const a = await jar(emails.admin);
    const m = await jar(emails.mentor);

    // A MENTOR is refused by the handler.
    expect((await m.post('/api/org/plan-change', { data: { requestedPlan: 'program', billingCycle: 'MONTHLY' } })).status()).toBe(403);

    // The admin's first request — an orgId in the body changes nothing.
    const first = await a.post('/api/org/plan-change', {
      data: { requestedPlan: 'program', billingCycle: 'MONTHLY', orgId: other.id, reason: 'We are growing' },
    });
    expect(first.status()).toBe(201);
    // A second submit updates the open request instead of adding one.
    const second = await a.post('/api/org/plan-change', {
      data: { requestedPlan: 'program_plus', billingCycle: 'YEARLY', educationClaim: true },
    });
    expect(second.status()).toBe(201);
    const rows = await prisma.planChangeRequest.findMany({ where: { orgId: { in: [tenant.id, other.id] } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(tenant.id);
    expect(rows[0].requestedPlan).toBe('program_plus');
    expect(rows[0].status).toBe('NEW');
    expect(rows[0].educationClaim).toBe(true);
    const requestId = rows[0].id;

    // A refused combination: Enterprise is annual-only.
    const bad = await a.post('/api/org/plan-change', { data: { requestedPlan: 'enterprise', billingCycle: 'MONTHLY' } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).code).toBe('interval_not_sold');

    // The tenant admin cannot read or act on the operator queue.
    expect((await a.get('/api/admin/plan-requests')).status()).toBe(403);
    expect((await a.patch(`/api/admin/plan-requests/${requestId}`, { data: { action: 'apply' } })).status()).toBe(403);

    // The operator applies it from the queue.
    expect((await signInViaApi(page.request, emails.operator, PW, { headers: freshIp('plan-ui-operator') })).error).toBeNull();
    await gotoSettled(page, '/admin/plan-requests');
    const card = page.getByTestId(`plan-request-${requestId}`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('plan-request-to')).toContainText('program_plus');
    await card.getByTestId('plan-request-discount').check();
    await card.getByTestId('plan-request-apply').click();
    await expect(page.getByTestId(`plan-request-${requestId}`)).toHaveCount(0);

    // Applied: subscription and legacy plan in step; the requester is told.
    const sub = await prisma.subscription.findUnique({ where: { orgId: tenant.id } });
    expect(sub?.planKey).toBe('program_plus');
    expect(sub?.interval).toBe('YEARLY');
    expect(sub?.educationDiscount).toBe(true);
    expect((await prisma.organization.findUnique({ where: { id: tenant.id } }))?.plan).toBe('ENTERPRISE');
    expect((await prisma.planChangeRequest.findUnique({ where: { id: requestId } }))?.status).toBe('APPLIED');
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'plan_change.applied' } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { action: 'org.plan_change_requested', targetId: tenant.id } })).toBeGreaterThan(0);
    expect(await prisma.activityLog.count({ where: { action: 'org.plan_change_applied', targetId: tenant.id } })).toBe(1);

    // Handled once: a second apply is a conflict, and the tenant sees the answer.
    const o = await jar(emails.operator);
    expect((await o.patch(`/api/admin/plan-requests/${requestId}`, { data: { action: 'apply' } })).status()).toBe(409);
    const mine = await (await a.get('/api/org/plan-change')).json();
    expect(mine.requests[0].status).toBe('APPLIED');
    // A rejection needs a note.
    await a.post('/api/org/plan-change', { data: { requestedPlan: 'program', billingCycle: 'MONTHLY' } });
    const open = await prisma.planChangeRequest.findFirstOrThrow({ where: { orgId: tenant.id, status: 'NEW' } });
    expect((await o.patch(`/api/admin/plan-requests/${open.id}`, { data: { action: 'reject' } })).status()).toBe(400);
    expect((await o.patch(`/api/admin/plan-requests/${open.id}`, { data: { action: 'reject', note: 'Stay on annual' } })).status()).toBe(200);
  } finally {
    for (const ctx of jars) await ctx.dispose();
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.activityLog.deleteMany({ where: { targetId: tenant.id } });
    await prisma.organization.deleteMany({ where: { id: { in: [tenant.id, other.id] } } });
  }
});
