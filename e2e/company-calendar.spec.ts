import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, submitSignInForm } from './helpers/auth';

// The COMPANY calendar (#2005). GET /api/calendar-events used to drop a
// COMPANY session into the mentee branch, where it matched nothing by luck.
// It now has its own scope — the meetings scheduled from ITS OWN interview
// requests — and every role without a calendar is refused outright. Pinned
// in both directions: the company sees its interview, and not a sibling
// company's interview, a mentor↔mentee meeting or another org's interview.

const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'CompanyCal123!';
const emails = {
  companyA: uniqueEmail('cal-company-a'),
  companyNull: uniqueEmail('cal-company-null'),
  source: uniqueEmail('cal-source'),
  mentor: uniqueEmail('cal-mentor'),
  mentee: uniqueEmail('cal-mentee'),
  menteeB: uniqueEmail('cal-mentee-b'),
};
const when = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const ids = { orgs: [] as string[], companies: [] as string[], meetings: [] as string[], relations: [] as string[], reqs: [] as string[] };
const titles = {
  own: `Own interview ${stamp}`,
  sibling: `Sibling interview ${stamp}`,
  pair: `Mentor call ${stamp}`,
  foreign: `Foreign interview ${stamp}`,
};

async function login(page: Page, email: string) {
  await submitSignInForm(page, email, password);
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
}

async function titlesFor(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/calendar-events');
  expect(res.status()).toBe(200);
  return ((await res.json()).events as { title: string }[]).map((e) => e.title);
}

test.describe.serial('COMPANY calendar scoping (#2005)', () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(password, 10);
    const orgA = await prisma.organization.create({ data: { name: `Cal A ${stamp}`, slug: `cal-a-${stamp}` } });
    const orgB = await prisma.organization.create({ data: { name: `Cal B ${stamp}`, slug: `cal-b-${stamp}` } });
    ids.orgs.push(orgA.id, orgB.id);
    const companyA = await prisma.company.create({ data: { name: `Cal Co A ${stamp}`, orgId: orgA.id } });
    const sibling = await prisma.company.create({ data: { name: `Cal Co Sibling ${stamp}`, orgId: orgA.id } });
    const companyB = await prisma.company.create({ data: { name: `Cal Co B ${stamp}`, orgId: orgB.id } });
    ids.companies.push(companyA.id, sibling.id, companyB.id);
    const user = (email: string, role: 'COMPANY' | 'SOURCE' | 'MENTOR' | 'MENTEE', orgId: string, companyId?: string) =>
      prisma.user.create({ data: { email, password: hash, role, fullName: email.split('@')[0], orgId, companyId, skills: [] } });
    await user(emails.companyA, 'COMPANY', orgA.id, companyA.id);
    await user(emails.companyNull, 'COMPANY', orgA.id);
    await user(emails.source, 'SOURCE', orgA.id);
    const mentor = await user(emails.mentor, 'MENTOR', orgA.id);
    const mentee = await user(emails.mentee, 'MENTEE', orgA.id);
    const menteeB = await user(emails.menteeB, 'MENTEE', orgB.id);
    const relation = await prisma.mentorshipRelation.create({
      data: { orgId: orgA.id, companyId: companyA.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
    });
    const relationB = await prisma.mentorshipRelation.create({
      data: { orgId: orgB.id, companyId: companyB.id, mentorId: mentor.id, menteeId: menteeB.id, status: 'ACTIVE' },
    });
    ids.relations.push(relation.id, relationB.id);
    const meeting = (relationId: string, title: string) =>
      prisma.meeting.create({ data: { relationId, title, scheduledAt: when, createdById: mentor.id, rsvpToken: `cal-${stamp}-${Math.random().toString(36).slice(2)}` } });
    const interview = async (orgId: string, companyId: string, relationId: string, menteeId: string, title: string) => {
      const m = await meeting(relationId, title);
      const requisition = await prisma.requisition.create({ data: { orgId, companyId, title: `Req ${title}`, openings: 1, requiredSkills: [] } });
      const req = await prisma.interviewRequest.create({
        data: { orgId, companyId, requisitionId: requisition.id, menteeId, status: 'SCHEDULED', meetingId: m.id, scheduledAt: when },
      });
      ids.meetings.push(m.id);
      ids.reqs.push(requisition.id);
      return req;
    };
    await interview(orgA.id, companyA.id, relation.id, mentee.id, titles.own);
    await interview(orgA.id, sibling.id, relation.id, mentee.id, titles.sibling);
    await interview(orgB.id, companyB.id, relationB.id, menteeB.id, titles.foreign);
    ids.meetings.push((await meeting(relation.id, titles.pair)).id);
  });

  test.afterAll(async () => {
    await prisma.interviewRequest.deleteMany({ where: { meetingId: { in: ids.meetings } } }).catch(() => {});
    await prisma.meeting.deleteMany({ where: { id: { in: ids.meetings } } }).catch(() => {});
    await prisma.requisition.deleteMany({ where: { id: { in: ids.reqs } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: ids.relations } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: ids.companies } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: ids.orgs } } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('a COMPANY sees its own interview and nothing else', { tag: '@smoke' }, async ({ page }) => {
    await login(page, emails.companyA);
    const seen = await titlesFor(page);
    expect(seen).toContain(titles.own);
    expect(seen).not.toContain(titles.sibling);
    expect(seen).not.toContain(titles.pair);
    expect(seen).not.toContain(titles.foreign);
    // Nothing but meetings: no deadline, logged interaction or project call.
    const res = await page.request.get('/api/calendar-events');
    for (const e of (await res.json()).events as { type: string }[]) expect(e.type).toBe('meeting');
  });

  test('a COMPANY without a company assignment sees nothing; SOURCE is refused', { tag: '@smoke' }, async ({ page }) => {
    await login(page, emails.companyNull);
    expect(await titlesFor(page)).toEqual([]);
    await login(page, emails.source);
    expect((await page.request.get('/api/calendar-events')).status()).toBe(403);
  });

  test('/company/calendar mounts the calendar on the company shell', async ({ page }) => {
    await login(page, emails.companyA);
    await gotoSettled(page, '/company/calendar');
    await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
    await expect(page.getByText('Your scheduled interviews at a glance', { exact: true })).toBeVisible();
  });
});
