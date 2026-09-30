import { test, expect, type Page } from '@playwright/test';
import crypto from 'crypto';
import { prisma } from './helpers/db';
import { seedTwoTenants, signInAsTenantActor, type SeededTenant, type TwoTenants } from './helpers/tenants';

/**
 * Analytics and invitations are read per tenant — with MT_ENFORCE_ISOLATION
 * **off** (leak audit WP3 + WP5, the #2542 pattern).
 *
 * Measured before the fix, on one database holding both products: every
 * analytics groupBy/count summed every organization, so a MARKETING (SaleVali)
 * admin's funnel, meeting and signup totals included the INTERNSHIP product's
 * rows; the aging report named the other product's candidates; `/api/cohorts`
 * listed every org's cohorts; and `GET /api/invite` gave an admin every
 * tenant's invitations, which `/api/invite/[id]` then resent, extended or
 * deleted by id. `withTenantScope()` wraps all of them but is a passthrough
 * with the flag off, so the routes now filter by hand.
 *
 * Runs on the DEFAULT project (no flag). Both tenants are fresh orgs, so each
 * total is exactly "this org's rows" and is asserted against the database.
 * Every exclusion has its positive twin, or an empty answer would pass it.
 */

let tenants: TwoTenants;

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'INTERNSHIP', verticalB: 'MARKETING' });
  // A's relation gets one logged interaction and one meeting inside the default
  // six-month window, so A's engagement totals are non-zero and B's must stay 0.
  const { orgA } = tenants;
  const meeting = await prisma.meeting.create({
    data: {
      relationId: orgA.relation.id,
      title: 'Isolation check meeting',
      scheduledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      rsvp: 'ACCEPTED',
      rsvpToken: crypto.randomBytes(16).toString('hex'),
      createdById: orgA.admin.id,
    },
  });
  await prisma.interactionLog.create({
    data: {
      relationId: orgA.relation.id,
      date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      notes: 'Isolation check interaction',
      type: 'Meeting',
      meetingId: meeting.id,
    },
  });
  // A cohort that belongs to B, which A's cohort list must never show.
  await prisma.cohort.create({ data: { orgId: tenants.orgB.org.id, name: `B cohort ${Date.now()}` } });
});

test.afterAll(async () => {
  if (tenants) await prisma.cohort.deleteMany({ where: { orgId: { in: tenants.orgIds } } });
  await tenants?.cleanup();
});

async function getJson(page: Page, path: string, status = 200) {
  const res = await page.request.get(path);
  expect(res.status(), `${path} should answer ${status}`).toBe(status);
  return res.json();
}

const sevenDaysAgo = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

test('analytics totals count the caller\'s own tenant only · both directions', { tag: '@smoke' }, async ({ page }) => {
  for (const [own, other] of [
    [tenants.orgA, tenants.orgB],
    [tenants.orgB, tenants.orgA],
  ] as Array<[SeededTenant, SeededTenant]>) {
    await page.context().clearCookies();
    await signInAsTenantActor(page, own.admin);

    const data = await getJson(page, '/api/admin/analytics');
    // Exactly this org's relations — the seed gives each org one.
    expect(data.totalRelations, `${own.label}: totalRelations`).toBe(
      await prisma.mentorshipRelation.count({ where: { orgId: own.org.id } }),
    );
    // Only A has an interaction and a meeting; B's must read zero.
    const expectEngagement = own === tenants.orgA ? 1 : 0;
    expect(data.engagement.interactions, `${own.label}: interactions`).toBe(expectEngagement);
    expect(data.engagement.meetings, `${own.label}: meetings`).toBe(expectEngagement);
    // The mentor list is this org's mentors, never the other's.
    const mentorIds = (data.mentorWorkload as { id: string }[]).map((m) => m.id);
    expect(mentorIds).not.toContain(other.mentor.id);
    if (own === tenants.orgA) expect(mentorIds).toContain(own.mentor.id);
    // The signup door counts this org's accounts.
    const week = (data.signupFunnel as { days: number; registered: number }[]).find((w) => w.days === 7);
    expect(week?.registered, `${own.label}: 7-day registrations`).toBe(
      await prisma.user.count({ where: { orgId: own.org.id, createdAt: { gte: sevenDaysAgo() } } }),
    );

    const funnel = await getJson(page, '/api/admin/analytics/funnel');
    expect(funnel.journeys, `${own.label}: funnel journeys`).toBe(1);
    const capacityIds = (funnel.capacity as { id: string }[]).map((m) => m.id);
    expect(capacityIds).not.toContain(other.mentor.id);
    expect(capacityIds).not.toContain(other.admin.id);
  }
});

test('aging: INTERNSHIP lists only its own candidates; MARKETING gets no candidate lists', async ({ page }) => {
  const { orgA, orgB } = tenants;

  await signInAsTenantActor(page, orgA.admin);
  const a = await getJson(page, '/api/admin/analytics/aging');
  const aRelations = (a.oldestStuck as { relationId: string }[]).map((r) => r.relationId);
  expect(a.candidateLists).toBe(true);
  expect(aRelations).toContain(orgA.relation.id);
  expect(aRelations).not.toContain(orgB.relation.id);
  expect(JSON.stringify(a)).not.toContain(orgB.mentee.fullName);

  await page.context().clearCookies();
  await signInAsTenantActor(page, orgB.admin);
  const b = await getJson(page, '/api/admin/analytics/aging');
  // The candidate panel is the internship product: withheld server-side.
  expect(b.candidateLists).toBe(false);
  expect(b.oldestStuck).toEqual([]);
  expect(b.overdue).toEqual([]);
  expect(JSON.stringify(b)).not.toContain(orgA.mentee.fullName);
  expect(JSON.stringify(b)).not.toContain(orgB.mentee.fullName);
  // The stage-level card stays for a sales funnel (#2423).
  expect(Array.isArray(b.stageAging)).toBe(true);

  // The other internship-only reports are refused outright for MARKETING.
  for (const path of ['/api/cohorts', '/api/admin/analytics/match-quality', '/api/admin/analytics/cohorts']) {
    const res = await page.request.get(path);
    expect(res.status(), `${path} must be gated for MARKETING`).toBe(403);
    expect((await res.json()).code).toBe('capability_unavailable');
  }
  const create = await page.request.post('/api/cohorts', { data: { name: 'must not exist' } });
  expect(create.status()).toBe(403);
});

test('cohorts: the list is the caller\'s own org, and a new cohort is stamped with it', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgA.admin);

  const name = `A cohort ${Date.now()}`;
  const created = await page.request.post('/api/cohorts', { data: { name } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).cohort.id as string;
  expect((await prisma.cohort.findUnique({ where: { id } }))?.orgId).toBe(orgA.org.id);

  const list = await getJson(page, '/api/cohorts');
  const ids = (list.cohorts as { id: string }[]).map((c) => c.id);
  expect(ids).toContain(id);
  const foreign = await prisma.cohort.findMany({ where: { orgId: orgB.org.id }, select: { id: true } });
  expect(foreign.length).toBeGreaterThan(0);
  for (const c of foreign) expect(ids, 'another org\'s cohort leaked').not.toContain(c.id);
});

test('invitations list only the caller\'s org · both directions', { tag: '@smoke' }, async ({ page }) => {
  for (const [own, other] of [
    [tenants.orgA, tenants.orgB],
    [tenants.orgB, tenants.orgA],
  ] as Array<[SeededTenant, SeededTenant]>) {
    await page.context().clearCookies();
    await signInAsTenantActor(page, own.admin);

    const invite = await getJson(page, '/api/invite');
    const ids = (invite.invitations as { id: string }[]).map((i) => i.id);
    expect(ids, `${own.label}: own invitation`).toContain(own.invitation.id);
    expect(ids, `${own.label}: /api/invite leaked another tenant's invitation`).not.toContain(other.invitation.id);

    const board = await getJson(page, '/api/admin/invitations');
    const boardIds = (board.invitations as { id: string }[]).map((i) => i.id);
    expect(boardIds).toContain(own.invitation.id);
    expect(boardIds).not.toContain(other.invitation.id);
  }
});

test('resend and delete of another tenant\'s invitation answer 404 and change nothing', { tag: '@smoke' }, async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgB.admin);

  const before = await prisma.invitationToken.findUniqueOrThrow({ where: { id: orgA.invitation.id } });

  const resend = await page.request.post(`/api/invite/${orgA.invitation.id}`);
  expect(resend.status()).toBe(404);
  expect(await resend.text()).not.toContain(orgA.invitation.token);
  const del = await page.request.delete(`/api/invite/${orgA.invitation.id}`);
  expect(del.status()).toBe(404);
  const bulk = await page.request.post('/api/admin/invitations/bulk', {
    data: { action: 'revoke', ids: [orgA.invitation.id] },
  });
  expect(bulk.status()).toBeLessThan(500);

  const after = await prisma.invitationToken.findUnique({ where: { id: orgA.invitation.id } });
  expect(after, 'the foreign invitation must still exist').not.toBeNull();
  expect(after!.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  expect(after!.revokedAt).toBeNull();

  // Positive twin: the caller's own invitation still resends.
  const own = await page.request.post(`/api/invite/${orgB.invitation.id}`);
  expect(own.status()).toBe(200);
});
