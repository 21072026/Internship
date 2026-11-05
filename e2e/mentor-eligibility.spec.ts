import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi } from './helpers/auth';

/**
 * Programme eligibility for mentors (#3423). A MENTEE rule written before the
 * target existed keeps its meaning and never touches the mentor pool; a MENTOR
 * rule drops the mentors it does not admit from suggestions and is enforced by
 * POST /api/mentorship with 403 not_eligible (side: mentor). The precedence
 * per side is unit-tested in scripts/test/eligibility.test.mjs.
 */

const PASSWORD = 'MentorElig123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor rule filters suggestions and refuses a direct pairing; an unchanged mentee rule never touches mentors', { tag: '@smoke' }, async () => {
  const slug = `melig-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `MElig ${slug}`, slug, plan: 'ENTERPRISE', eligibilityMode: 'RULES' } });
  const adminEmail = uniqueEmail('melig-admin').toLowerCase();
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'MElig Admin', org.id);
  const admin = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    expect((await signInViaApi(admin, adminEmail, PASSWORD)).ok).toBe(true);
    const skill = `Elixir${Date.now()}`;
    const mkMentor = async (name: string, department: string) => {
      const u = await seedUser(uniqueEmail(`melig-${name}`).toLowerCase(), 'x', 'MENTOR', name, org.id);
      return prisma.user.update({ where: { id: u.id }, data: { department, skills: [skill] } });
    };
    const senior = await mkMentor('Senior Mentor', 'Engineering');
    const junior = await mkMentor('Junior Mentor', 'Support');
    const mkMentee = async (name: string) => {
      const u = await seedUser(uniqueEmail(`melig-${name}`).toLowerCase(), 'x', 'MENTEE', name, org.id);
      return prisma.user.update({ where: { id: u.id }, data: { city: 'Berlin', skills: [skill] } });
    };
    const mentee = await mkMentee('Berlin Mentee');
    const other = await mkMentee('Other Mentee');

    // A mentee rule written the old way (no target): mentees in Berlin only.
    const menteeRule = await admin.post('/api/admin/eligibility', { data: { effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin'] } });
    expect(menteeRule.status(), await menteeRule.text()).toBe(201);
    expect((await menteeRule.json()).rule.appliesTo).toBe('MENTEE');

    const suggested = async () => {
      const res = await admin.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id } });
      expect(res.ok(), await res.text()).toBe(true);
      const body = await res.json();
      return (body.suggestions as { mentorId: string }[]).map((s) => s.mentorId);
    };
    // With no mentor rule, every mentor stands — the mentee rule never empties
    // the pool. (The org's ADMIN mentors too, so the list may carry them.)
    expect(await suggested()).toEqual(expect.arrayContaining([senior.id, junior.id]));

    // A mentor rule: only Engineering mentors mentor here.
    const mentorRule = await admin.post('/api/admin/eligibility', { data: { effect: 'ALLOW', attribute: 'department', operator: 'EQUALS', value: 'Engineering', appliesTo: 'MENTOR' } });
    expect(mentorRule.status(), await mentorRule.text()).toBe(201);
    // The admin has no department, so the rule drops them as well.
    expect(await suggested()).toEqual([senior.id]);

    // The dry run counts the two sides separately.
    const preview = await admin.post('/api/admin/eligibility/preview', {
      data: { mode: 'RULES', rules: [
        { effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin'] },
        { effect: 'ALLOW', attribute: 'department', operator: 'EQUALS', value: 'Engineering', appliesTo: 'MENTOR' },
      ] },
    });
    expect(await preview.json()).toMatchObject({ total: 2, admitted: 2, mentors: { total: 2, admitted: 1 } });

    // A direct pairing with the excluded mentor is refused, naming the side.
    const refused = await admin.post('/api/mentorship', { data: { mentorId: junior.id, menteeId: mentee.id } });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'not_eligible', side: 'mentor', ruleId: null });
    // The admitted mentor pairs; the mentee rule still judges the mentee as before.
    expect((await admin.post('/api/mentorship', { data: { mentorId: senior.id, menteeId: mentee.id } })).status()).toBe(201);
    await prisma.user.update({ where: { id: other.id }, data: { city: 'Paris' } });
    const menteeRefused = await admin.post('/api/mentorship', { data: { mentorId: senior.id, menteeId: other.id } });
    expect(menteeRefused.status()).toBe(403);
    expect(await menteeRefused.json()).toMatchObject({ code: 'not_eligible', side: 'mentee' });
  } finally {
    await admin.dispose();
    const users = await prisma.user.findMany({ where: { orgId: org.id }, select: { id: true, email: true } });
    const ids = users.map((u) => u.id);
    await prisma.matchFeedback.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.matchDecision.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ menteeId: { in: ids } }, { mentorId: { in: ids } }] } });
    await prisma.programEligibilityRule.deleteMany({ where: { orgId: org.id } });
    for (const u of users) await cleanupByEmail(u.email);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
