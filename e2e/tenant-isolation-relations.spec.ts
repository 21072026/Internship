import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, putOnWorld, type SeededTenant, type TwoTenants } from './helpers/tenants';

/**
 * Relations, meetings and the calendar are one tenant's, never the other's —
 * with MT_ENFORCE_ISOLATION **off** (#2542 follow-up).
 *
 * Measured before the fix, on one database holding both products: the ADMIN
 * relation scope in src/lib/authzScope.ts was `{}` ("admins see the whole
 * tenant"), and the meeting and calendar routes had their own
 * `role === 'ADMIN' ? {}` branches. With the tenant middleware dormant that was
 * the whole DATABASE: a SaleVali (MARKETING) admin's `GET /api/mentorship`
 * listed the INTERNSHIP tenant's relations and mentee e-mails, `/api/meetings`
 * and `/api/calendar-events` its meetings and project calls, and the by-id
 * routes (timeline, person card, meeting move) opened them.
 *
 * Runs on the DEFAULT project, whose server has no MT_ENFORCE_ISOLATION — the
 * point is that the routes scope themselves. Every exclusion has its positive
 * twin (the caller's own row comes back), or a route that returned nothing at
 * all would pass it. Both directions, plus the DEFAULT org itself: the
 * INTERNSHIP product's real tenant is the `default` org, whose NULL-org rows
 * are its own (src/lib/tenantFilter.ts).
 */

type Extras = { meetingId: string; meetingTitle: string; projectId: string; seriesId: string };

let tenants: TwoTenants;
const extras = new Map<string, Extras>();

/** A scheduled 1:1 meeting, a stage deadline and a recurring project call for one tenant. */
async function seedCalendar(t: SeededTenant): Promise<Extras> {
  const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const meetingTitle = `Iso ${t.label} meeting ${crypto.randomBytes(3).toString('hex')}`;
  const meeting = await prisma.meeting.create({
    data: {
      relationId: t.relation.id,
      title: meetingTitle,
      scheduledAt: inAWeek,
      meetLink: `https://meet.example.test/${crypto.randomBytes(6).toString('hex')}`,
      rsvpToken: crypto.randomBytes(24).toString('hex'),
      createdById: t.mentor.id,
      batchKey: crypto.randomBytes(12).toString('hex'),
    },
  });
  await prisma.mentorshipRelation.update({ where: { id: t.relation.id }, data: { stageDeadline: inAWeek } });
  const project = await prisma.project.create({
    data: { orgId: t.org.id, name: `Iso ${t.label} project`, ownerType: 'ADMIN', ownerUserId: t.admin.id },
  });
  const series = await prisma.meetingSeries.create({
    data: {
      projectId: project.id,
      title: `Iso ${t.label} weekly`,
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeOfDay: '09:30',
      createdById: t.admin.id,
    },
  });
  return { meetingId: meeting.id, meetingTitle, projectId: project.id, seriesId: series.id };
}

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'INTERNSHIP', verticalB: 'MARKETING' });
  extras.set(tenants.orgA.org.id, await seedCalendar(tenants.orgA));
  extras.set(tenants.orgB.org.id, await seedCalendar(tenants.orgB));
});

test.afterAll(async () => {
  for (const e of extras.values()) {
    await prisma.meetingSeries.deleteMany({ where: { id: e.seriesId } });
    await prisma.project.deleteMany({ where: { id: e.projectId } });
  }
  await tenants?.cleanup();
});

async function listIds(page: Page, path: string, key: string): Promise<string[]> {
  const res = await page.request.get(path);
  expect(res.status(), `${path} should answer 200`).toBe(200);
  const rows = (await res.json())[key] as { id: string }[] | undefined;
  expect(Array.isArray(rows), `${path} should return ${key}[]`).toBe(true);
  return (rows ?? []).map((r) => r.id);
}

const DIRECTIONS: Array<[string, (t: TwoTenants) => [SeededTenant, SeededTenant]]> = [
  ['INTERNSHIP admin → MARKETING tenant', (t) => [t.orgA, t.orgB]],
  ['MARKETING admin → INTERNSHIP tenant', (t) => [t.orgB, t.orgA]],
];

for (const [label, pick] of DIRECTIONS) {
  test(`relations, meetings and the calendar list only the own tenant · ${label}`, { tag: '@smoke' }, async ({ page }) => {
    const [own, other] = pick(tenants);
    const mine = extras.get(own.org.id)!;
    const theirs = extras.get(other.org.id)!;
    await signInAsTenantActor(page, own.admin);

    // GET /api/mentorship — the root scope (authzScope.ts ADMIN builder).
    const relations = await page.request.get('/api/mentorship');
    expect(relations.status()).toBe(200);
    const relBody = await relations.text();
    const relIds = (JSON.parse(relBody).relations as { id: string }[]).map((r) => r.id);
    expect(relIds, '/api/mentorship leaked another tenant\'s relation').not.toContain(other.relation.id);
    expect(relBody, '/api/mentorship leaked another tenant\'s mentee e-mail').not.toContain(other.mentee.email);
    expect(relIds).toContain(own.relation.id);
    // The paginated shape builds the same `where` through a second query.
    const paged = await listIds(page, '/api/mentorship?page=1&pageSize=100', 'relations');
    expect(paged).not.toContain(other.relation.id);
    expect(paged).toContain(own.relation.id);
    // A search term is a conjunct of the scope, never a replacement (#2288).
    const searched = await listIds(page, `/api/mentorship?search=${encodeURIComponent('Iso')}`, 'relations');
    expect(searched).not.toContain(other.relation.id);
    expect(searched).toContain(own.relation.id);

    // GET /api/meetings
    const meetings = await listIds(page, '/api/meetings', 'meetings');
    expect(meetings, '/api/meetings leaked another tenant\'s meeting').not.toContain(theirs.meetingId);
    expect(meetings).toContain(mine.meetingId);

    // GET /api/calendar-events — meetings, deadlines and recurring project calls.
    const cal = await page.request.get('/api/calendar-events');
    expect(cal.status()).toBe(200);
    const eventIds = ((await cal.json()).events as { id: string }[]).map((e) => e.id);
    expect(eventIds).not.toContain(`meeting-${theirs.meetingId}`);
    expect(eventIds).not.toContain(`deadline-${other.relation.id}`);
    expect(eventIds.some((id) => id.startsWith(`series-${theirs.seriesId}-`)), 'calendar leaked another tenant\'s project call').toBe(false);
    expect(eventIds).toContain(`meeting-${mine.meetingId}`);
    expect(eventIds).toContain(`deadline-${own.relation.id}`);
    expect(eventIds.some((id) => id.startsWith(`series-${mine.seriesId}-`))).toBe(true);

    // The admin's ICS subscription is the same set without a session.
    const icsToken = crypto.randomBytes(24).toString('hex');
    await prisma.user.update({ where: { id: own.admin.id }, data: { icsFeedToken: icsToken } });
    const feed = await page.request.get(`/api/calendar/feed/${icsToken}`);
    expect(feed.status()).toBe(200);
    const ics = await feed.text();
    expect(ics, 'ICS feed leaked another tenant\'s meeting').not.toContain(theirs.meetingId);
    expect(ics).not.toContain(`deadline-${other.relation.id}`);
    expect(ics).not.toContain(`series-${theirs.seriesId}-`);
    expect(ics).toContain(mine.meetingId);
  });

  test(`relations and meetings by id answer 404 across tenants · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    const mine = extras.get(own.org.id)!;
    const theirs = extras.get(other.org.id)!;
    await signInAsTenantActor(page, own.admin);

    // Positive twins: the own rows open.
    expect((await page.request.get(`/api/mentorship/${own.relation.id}/timeline`)).status()).toBe(200);
    expect((await page.request.get(`/api/people/${own.mentee.id}/card`)).status()).toBe(200);
    expect((await page.request.get(`/api/meetings/${mine.meetingId}/guests`)).status()).toBe(200);

    for (const path of [
      `/api/mentorship/${other.relation.id}/timeline`,
      `/api/people/${other.mentee.id}/card`,
      `/api/people/${other.mentor.id}/card`,
      `/api/meetings/${theirs.meetingId}/guests`,
      `/api/meetings/${theirs.meetingId}/call-token`,
    ]) {
      const res = await page.request.get(path);
      expect(res.status(), `${path} must be a 404 for another tenant's admin`).toBe(404);
      expect(await res.text(), `${path} must not echo the foreign row`).not.toContain(other.mentee.email);
    }
  });

  test(`writes by id change nothing across tenants · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    const theirs = extras.get(other.org.id)!;
    await signInAsTenantActor(page, own.admin);

    const move = await page.request.patch(`/api/meetings/${theirs.meetingId}`, {
      data: { title: 'moved across tenants' },
    });
    expect(move.status(), 'PATCH another tenant\'s meeting').toBe(404);
    const cancel = await page.request.patch(`/api/meetings/${theirs.meetingId}`, { data: { status: 'CANCELLED' } });
    expect(cancel.status()).toBe(404);
    const remove = await page.request.delete(`/api/meetings/${theirs.meetingId}`);
    expect(remove.status()).toBe(404);
    const guests = await page.request.post(`/api/meetings/${theirs.meetingId}/guests`, {
      data: { guests: [{ email: 'guest.across@e2e.local' }] },
    });
    expect(guests.status()).toBe(404);

    // Scheduling on another tenant's relation id creates nothing.
    const schedule = await page.request.post('/api/meetings', {
      data: { relationIds: [other.relation.id], title: 'scheduled across tenants' },
    });
    expect(schedule.status()).toBe(200);
    expect((await schedule.json()).created).toBe(0);

    // Handing another tenant's mentee to one of ours.
    const transfer = await page.request.post(`/api/mentorship/${other.relation.id}/transfer`, {
      data: { toMentorId: own.mentor.id, reasonCode: 'mentor_unavailable' },
    });
    expect(transfer.status()).toBe(404);

    // The recurring rule of another tenant's project.
    expect((await page.request.get(`/api/meeting-series?projectId=${theirs.projectId}`)).status()).toBe(404);

    // Asked of the database: a 404 that still wrote would pass all of the above.
    const meeting = await prisma.meeting.findUniqueOrThrow({
      where: { id: theirs.meetingId },
      select: { title: true, status: true },
    });
    expect(meeting).toEqual({ title: theirs.meetingTitle, status: 'SCHEDULED' });
    expect(await prisma.meetingGuest.count({ where: { meetingId: theirs.meetingId } })).toBe(0);
    expect(await prisma.meeting.count({ where: { relationId: other.relation.id } })).toBe(1);
    const relation = await prisma.mentorshipRelation.findUniqueOrThrow({
      where: { id: other.relation.id },
      select: { mentorId: true, status: true },
    });
    expect(relation).toEqual({ mentorId: other.mentor.id, status: 'ACTIVE' });
  });
}

/**
 * The INTERNSHIP product's real tenant is the `default` org, whose NULL-org
 * rows are its own. Its admin must not read the MARKETING tenant, and the
 * MARKETING admin must not read a default-org relation.
 */
test('the default org and a MARKETING org do not see each other\'s relations', async ({ page }) => {
  const { orgB } = tenants;
  const defaultOrg = await prisma.organization.findUniqueOrThrow({ where: { slug: 'default' }, select: { id: true } });
  const emails = {
    admin: uniqueEmail('iso-rel-default-admin'),
    mentor: uniqueEmail('iso-rel-default-mentor'),
    mentee: uniqueEmail('iso-rel-default-mentee'),
  };
  const password = 'IsoDefault123!';
  const admin = await seedUser(emails.admin, password, 'ADMIN', 'Iso Default Admin', defaultOrg.id);
  const mentor = await seedUser(emails.mentor, password, 'MENTOR', 'Iso Default Mentor', defaultOrg.id);
  const mentee = await seedUser(emails.mentee, password, 'MENTEE', 'Iso Default Mentee', defaultOrg.id);
  try {
    // orgId NULL on purpose: such a row is the default org's (backfill rule).
    const relation = await prisma.mentorshipRelation.create({
      data: { orgId: null, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
    });

    await putOnWorld(page, 'INTERNSHIP');
    await signInAsFreshUser(page, emails.admin, password, '/admin');
    const defaultSees = await listIds(page, '/api/mentorship', 'relations');
    expect(defaultSees).toContain(relation.id);
    expect(defaultSees).not.toContain(orgB.relation.id);
    expect((await page.request.get(`/api/mentorship/${orgB.relation.id}/timeline`)).status()).toBe(404);
    expect((await page.request.get(`/api/people/${orgB.mentee.id}/card`)).status()).toBe(404);

    await signInAsTenantActor(page, orgB.admin);
    const marketingSees = await listIds(page, '/api/mentorship', 'relations');
    expect(marketingSees).not.toContain(relation.id);
    expect(marketingSees).toContain(orgB.relation.id);
    expect((await page.request.get(`/api/mentorship/${relation.id}/timeline`)).status()).toBe(404);
    expect((await page.request.get(`/api/people/${mentee.id}/card`)).status()).toBe(404);
    expect((await page.request.get(`/api/people/${admin.id}/card`)).status()).toBe(404);
  } finally {
    for (const email of Object.values(emails)) await cleanupByEmail(email);
  }
});
