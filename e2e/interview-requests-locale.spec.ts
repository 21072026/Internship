import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// #1422: /admin/interview-requests rendered entirely in Turkish but printed the
// request date as "8/25/2026" and the proposed interview slots on whatever clock
// the browser happened to be on, with no zone named. Both came from calling
// `toLocaleDateString()` / `toLocaleString()` with no arguments, which asks the
// BROWSER, not the app.
//
// The whole point of this spec is the mismatch, so it is set up deliberately:
// the browser is `en-US` in `America/New_York`, the app language is `tr`, and
// the viewer's saved `User.timezone` is Europe/Istanbul. A correct render
// therefore agrees with none of the browser's defaults — Turkish date format,
// and the slot on the Istanbul clock with the zone spelled out.
test.use({ locale: 'en-US', timezoneId: 'America/New_York' });

const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'LocaleDates123!';
const adminEmail = uniqueEmail('locdate-admin');
const mentorEmail = uniqueEmail('locdate-mentor');
const menteeEmail = uniqueEmail('locdate-mentee');

// 13:30 UTC = 16:30 in Istanbul, 09:30 in New York. Two readings far enough
// apart that a browser-clock regression cannot pass by coincidence.
const CREATED_AT = new Date('2026-08-25T13:30:00Z');
const SLOT = '2026-08-25T13:30:00.000Z';

let org: { id: string };
let company: { id: string };
let mentor: { id: string };
let mentee: { id: string };
let requisition: { id: string };
let relation: { id: string };
let request: { id: string };

test.beforeAll(async () => {
  const hash = await bcrypt.hash(password, 10);
  org = await prisma.organization.create({ data: { name: `Loc Dates ${stamp}`, slug: `loc-dates-${stamp}` } });
  company = await prisma.company.create({ data: { name: `Loc Dates Co ${stamp}`, orgId: org.id } });
  const user = (email: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', timezone?: string) =>
    prisma.user.create({
      data: { email, password: hash, role, fullName: email.split('@')[0], orgId: org.id, skills: [], timezone },
    });
  // The admin's SAVED zone — not the browser's — is the clock the slot must be
  // printed on, and the reason the API hands `viewerTimezone` to the client.
  await user(adminEmail, 'ADMIN', 'Europe/Istanbul');
  mentor = await user(mentorEmail, 'MENTOR');
  mentee = await user(menteeEmail, 'MENTEE');
  relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, companyId: company.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });
  requisition = await prisma.requisition.create({
    data: { orgId: org.id, companyId: company.id, title: `Loc Dates Req ${stamp}`, openings: 1, requiredSkills: [] },
  });
  request = await prisma.interviewRequest.create({
    data: {
      orgId: org.id,
      companyId: company.id,
      requisitionId: requisition.id,
      menteeId: mentee.id,
      createdAt: CREATED_AT,
      proposedSlots: [SLOT],
    },
  });
});

test.afterAll(async () => {
  await prisma.interviewRequest.deleteMany({ where: { id: request?.id } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { id: relation?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { id: requisition?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, mentorEmail, menteeEmail] } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { id: company?.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
  await prisma.$disconnect();
});

test('a Turkish UI on a US-locale browser prints 25.08.2026 and names the slot zone', async ({ page }) => {
  await signInAndSettle(page, adminEmail, password, '/admin');
  await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
  await gotoSettled(page, '/admin/interview-requests');

  // Scope everything to the card for THIS request. It has to be the card's own
  // testid, not `locator('div').filter({ hasText })`: filter+first() returns the
  // first match in DOM order, which is the `space-y-4` wrapper around the whole
  // list — so the slot assertion below would read whichever request happened to
  // be rendered first.
  const queue = page.getByTestId('admin-interview-requests');
  const card = queue.getByTestId(`interview-request-${request.id}`);
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The request date: Turkish gg.aa.yyyy, never the en-US M/D/YYYY the browser
  // would have produced.
  await expect(card).toContainText('25.08.2026');
  await expect(card).not.toContainText(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);

  // The proposed slot: read on the admin's saved Istanbul clock (16:30), not on
  // the browser's New York one (09:30), and saying which clock that was.
  // One seeded slot, so this also proves the scoping above held: an unscoped
  // card locator would drag in every other request's slots too.
  await expect(card.locator('li')).toHaveCount(1);
  const slot = card.locator('li').first();
  await expect(slot).toContainText('16:30');
  await expect(slot).toContainText('(GMT+3)');
  await expect(slot).not.toContainText('09:30');
});
