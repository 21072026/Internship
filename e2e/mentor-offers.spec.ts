import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// #1809 Mentor Offers: a mentor with headroom offers to an opted-in, unmatched
// mentee; accepting creates exactly one relation through the shared decision
// path. A mentee who has not opted in is unreachable, and the quota holds.
const PASSWORD = 'MentorOffer123!';
const emails = {
  mentor: uniqueEmail('mo-mentor'),
  open: uniqueEmail('mo-open'),
  closed: uniqueEmail('mo-closed'),
  quota: [1, 2, 3, 4].map((n) => uniqueEmail(`mo-quota${n}`)),
};
let mentor: APIRequestContext;
let mentee: APIRequestContext;
let mentorId = '';
let openId = '';
let closedId = '';
const quotaIds: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  mentorId = (await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'Offering Mentor')).id;
  await prisma.user.update({ where: { id: mentorId }, data: { mentorCapacity: 10, acceptingMentees: true } });
  openId = (await seedUser(emails.open, PASSWORD, 'MENTEE', 'Open Mentee')).id;
  await prisma.user.update({ where: { id: openId }, data: { openToOffers: true } });
  closedId = (await seedUser(emails.closed, PASSWORD, 'MENTEE', 'Closed Mentee')).id;
  for (const e of emails.quota) {
    const id = (await seedUser(e, PASSWORD, 'MENTEE', 'Quota Mentee')).id;
    await prisma.user.update({ where: { id }, data: { openToOffers: true } });
    quotaIds.push(id);
  }
  mentor = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await signInViaApi(mentor, emails.mentor, PASSWORD)).ok).toBe(true);
  mentee = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await signInViaApi(mentee, emails.open, PASSWORD)).ok).toBe(true);
});

test.afterAll(async () => {
  await mentor.dispose();
  await mentee.dispose();
  await prisma.mentorOffer.deleteMany({ where: { mentorId } });
  for (const e of [emails.open, emails.closed, ...emails.quota, emails.mentor]) await cleanupByEmail(e);
  await prisma.$disconnect();
});

test('a mentee who has not opted in is neither listed nor offerable', async () => {
  const list = await (await mentor.get('/api/mentor/offers')).json();
  const ids = list.offerable.map((m: { id: string }) => m.id);
  expect(ids).toContain(openId);
  expect(ids).not.toContain(closedId);
  // Never a contact detail on the listing.
  expect(JSON.stringify(list.offerable)).not.toContain('@');
  const res = await mentor.post('/api/mentor/offers', { data: { menteeId: closedId } });
  expect(res.status()).toBe(404);
});

test('offer → accept → exactly one relation, through the shared path', async () => {
  const sent = await mentor.post('/api/mentor/offers', { data: { menteeId: openId, message: 'Happy to help with your first steps.' } });
  expect(sent.status(), await sent.text()).toBe(201);
  const offerId = (await sent.json()).id;
  expect((await mentor.post('/api/mentor/offers', { data: { menteeId: openId } })).status()).toBe(409);
  expect(await prisma.notification.count({ where: { userId: openId, type: 'mentor_offer.new' } })).toBe(1);

  const mine = await (await mentee.get('/api/mentee/offers')).json();
  expect(mine.offers.map((o: { id: string }) => o.id)).toEqual([offerId]);

  const accepted = await mentee.post(`/api/mentee/offers/${offerId}`, { data: { action: 'accept' } });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  expect(await prisma.mentorshipRelation.count({ where: { menteeId: openId, status: 'ACTIVE' } })).toBe(1);
  expect(await prisma.mentorshipRelation.count({ where: { menteeId: openId, mentorId, status: 'ACTIVE' } })).toBe(1);
  expect((await prisma.mentorOffer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('ACCEPTED');
  // The shared path approved a request naming the mentor.
  expect(await prisma.mentorshipRequest.count({ where: { menteeId: openId, preferredMentorId: mentorId, status: 'APPROVED' } })).toBe(1);
  // A second answer is refused.
  expect((await mentee.post(`/api/mentee/offers/${offerId}`, { data: { action: 'decline' } })).status()).toBe(409);
});

test('the quota holds: a 4th pending offer is refused server-side', async () => {
  for (const id of quotaIds.slice(0, 3)) {
    expect((await mentor.post('/api/mentor/offers', { data: { menteeId: id } })).status()).toBe(201);
  }
  const fourth = await mentor.post('/api/mentor/offers', { data: { menteeId: quotaIds[3] } });
  expect(fourth.status()).toBe(409);
  expect((await fourth.json()).code).toBe('quota_pending');
  // Withdrawing one frees a slot — but the weekly cap (5) now binds: 1 + 3 sent already.
  const pending = await prisma.mentorOffer.findFirstOrThrow({ where: { mentorId, status: 'PENDING' } });
  expect((await mentor.delete(`/api/mentor/offers/${pending.id}`)).ok()).toBeTruthy();
  expect((await mentor.post('/api/mentor/offers', { data: { menteeId: quotaIds[3] } })).status()).toBe(201);
  const sixth = await mentor.post('/api/mentor/offers', { data: { menteeId: pending.menteeId } });
  expect(sixth.status()).toBe(409);
  expect(['quota_weekly', 'quota_pending']).toContain((await sixth.json()).code);
});

test('the mentor page and the portal panel render', async ({ page }) => {
  // An unmatched, opted-in mentee with an open offer: the panel shows the switch and the offer.
  expect((await signInViaApi(page.request, emails.quota[1], PASSWORD)).ok).toBe(true);
  await page.goto('/portal');
  await expect(page.getByTestId('open-to-offers-toggle')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('open-to-offers-toggle')).toHaveAttribute('aria-checked', 'true');
  const res = await mentor.get('/mentor/offers');
  expect(res.status()).toBe(200);
});

test('a mentor who is not accepting cannot offer', async () => {
  await prisma.user.update({ where: { id: mentorId }, data: { acceptingMentees: false } });
  await prisma.mentorOffer.updateMany({ where: { mentorId, status: 'PENDING' }, data: { status: 'WITHDRAWN' } });
  const res = await mentor.post('/api/mentor/offers', { data: { menteeId: quotaIds[0] } });
  expect(res.status()).toBe(403);
  expect((await res.json()).code).toBe('mentor_unavailable');
});
