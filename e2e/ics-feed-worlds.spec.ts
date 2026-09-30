import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Worlds (docs/worlds.md): the subscription feed stays in its owner's world and
// tenant. The route is sessionless — a calendar app fetches it — so no tenant
// context is ever bound, and an ADMIN's feed used to carry EVERY organization's
// meetings, the other product's included, under a calendar named
// "InternshipCRM". The feed is fetched here exactly as a calendar app does it:
// by token, with no cookie.
const PASSWORD = 'IcsWorlds123!';
const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;

const emails = {
  mktAdmin: uniqueEmail('icsw-mkt-admin'),
  mktRep: uniqueEmail('icsw-mkt-rep'),
  mktLead: uniqueEmail('icsw-mkt-lead'),
  intAdmin: uniqueEmail('icsw-int-admin'),
  intMentor: uniqueEmail('icsw-int-mentor'),
  intMentee: uniqueEmail('icsw-int-mentee'),
};
const MKT_TITLE = `SaleVali demo call ${stamp}`;
const INT_TITLE = `Internship check-in ${stamp}`;

let orgId = '';
const tokens = { mkt: randomBytes(24).toString('hex'), int: randomBytes(24).toString('hex') };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `ICS worlds ${stamp}`, slug: `ics-worlds-${stamp}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const soon = new Date(Date.now() + 26 * 60 * 60 * 1000);

  const mktAdmin = await seedUser(emails.mktAdmin, PASSWORD, 'ADMIN', 'ICS Mkt Admin', orgId);
  const rep = await seedUser(emails.mktRep, PASSWORD, 'MENTOR', 'ICS Mkt Rep', orgId);
  const lead = await seedUser(emails.mktLead, PASSWORD, 'MENTEE', 'ICS Mkt Lead', orgId);
  const mktRel = await prisma.mentorshipRelation.create({ data: { mentorId: rep.id, menteeId: lead.id, orgId } });
  await prisma.meeting.create({
    data: { relationId: mktRel.id, title: MKT_TITLE, scheduledAt: soon, rsvpToken: randomBytes(16).toString('hex'), createdById: rep.id },
  });

  const intAdmin = await seedUser(emails.intAdmin, PASSWORD, 'ADMIN', 'ICS Int Admin');
  const mentor = await seedUser(emails.intMentor, PASSWORD, 'MENTOR', 'ICS Int Mentor');
  const mentee = await seedUser(emails.intMentee, PASSWORD, 'MENTEE', 'ICS Int Mentee');
  const intRel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.meeting.create({
    data: { relationId: intRel.id, title: INT_TITLE, scheduledAt: soon, rsvpToken: randomBytes(16).toString('hex'), createdById: mentor.id },
  });

  await prisma.user.update({ where: { id: mktAdmin.id }, data: { icsFeedToken: tokens.mkt } });
  await prisma.user.update({ where: { id: intAdmin.id }, data: { icsFeedToken: tokens.int } });
});

test.afterAll(async () => {
  for (const email of Object.values(emails)) await cleanupByEmail(email);
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test("a SaleVali admin's feed holds only their organization, named SaleVali", async ({ request }) => {
  const feed = await request.get(`/api/calendar/feed/${tokens.mkt}`);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-disposition']).toContain('filename="salevali.ics"');
  const body = await feed.text();
  expect(body).toContain(MKT_TITLE);
  expect(body).not.toContain(INT_TITLE);
  expect(body).toContain('X-WR-CALNAME:SaleVali');
  expect(body).toContain('PRODID:-//SaleVali//EN');
  expect(body).not.toContain('Internship');
});

test("an Internship CRM admin's feed never carries the other product's meetings", async ({ request }) => {
  const feed = await request.get(`/api/calendar/feed/${tokens.int}`);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-disposition']).toContain('filename="internship-crm.ics"');
  const body = await feed.text();
  expect(body).toContain(INT_TITLE);
  expect(body).not.toContain(MKT_TITLE);
  expect(body).toContain('X-WR-CALNAME:InternshipCRM');
});
