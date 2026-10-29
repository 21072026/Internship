import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';

// #2042 — the company's applicant board explains every applicant in words,
// with NO provider configured: the deterministic sentence is always there, the
// score never reaches the company, nobody is filtered out, and asking for AI
// sentences degrades to "not available" instead of a blank screen or a 500.

const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'FitPass123!';
const emails: Record<string, string> = { company: uniqueEmail('fr-company'), strong: uniqueEmail('fr-strong'), weak: uniqueEmail('fr-weak') };
const ids: Record<string, string> = {};

async function login(page: Page, email: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
}

test.describe.serial('#2042 fit reasons on the applicant board', () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(password, 10);
    const org = await prisma.organization.create({ data: { name: `FR Org ${stamp}`, slug: `fr-${stamp}` } });
    ids.org = org.id;
    const company = await prisma.company.create({ data: { name: `FR Acme ${stamp}`, orgId: org.id } });
    ids.company = company.id;
    const user = (email: string, role: 'COMPANY' | 'MENTEE', extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { email, password: hash, fullName: email.split('@')[0], role, orgId: org.id, skills: [], ...extra } });
    await user(emails.company, 'COMPANY', { companyId: company.id });
    ids.strong = (await user(emails.strong, 'MENTEE', { targetPosition: 'Frontend Developer', city: 'Berlin' })).id;
    ids.weak = (await user(emails.weak, 'MENTEE', { targetPosition: 'Accountant', city: 'Munich' })).id;
    const skill = (key: string) => prisma.skill.create({ data: { orgId: org.id, key: `${key}-${stamp}`, labelEn: `${key} ${stamp}`.slice(0, 60), labelTr: key, labelDe: key } });
    const react = await skill('react');
    const ts = await skill('typescript');
    ids.reactLabel = react.labelEn;
    await prisma.userSkill.createMany({ data: [{ userId: ids.strong, skillId: react.id }, { userId: ids.strong, skillId: ts.id }] });
    const req = await prisma.requisition.create({
      data: { orgId: org.id, companyId: company.id, title: 'Frontend Developer', status: 'OPEN', openings: 1, city: 'Berlin', requiredSkills: ['React', 'TypeScript'] },
    });
    ids.req = req.id;
    await prisma.requisitionSkill.createMany({ data: [{ requisitionId: req.id, skillId: react.id }, { requisitionId: req.id, skillId: ts.id }] });
    for (const menteeId of [ids.strong, ids.weak]) {
      await prisma.application.create({ data: { orgId: org.id, requisitionId: req.id, menteeId, companyId: company.id } });
    }
  });

  test.afterAll(async () => {
    await prisma.requisitionFit.deleteMany({ where: { orgId: ids.org } }).catch(() => {});
    await prisma.application.deleteMany({ where: { orgId: ids.org } }).catch(() => {});
    await prisma.requisition.deleteMany({ where: { orgId: ids.org } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
    await prisma.skill.deleteMany({ where: { orgId: ids.org } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: ids.org } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: ids.org } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('every applicant gets a written reason, the company never sees a score, nobody is dropped', async ({ page }) => {
    await login(page, emails.company);
    const res = await page.request.get(`/api/company/requisitions/${ids.req}/applications`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = (body.columns.APPLIED?.items ?? []) as { mentee: { id: string }; fitReason?: { text: string; source: string } }[];
    expect(items.map((i) => i.mentee.id).sort()).toEqual([ids.strong, ids.weak].sort());
    const strong = items.find((i) => i.mentee.id === ids.strong)!;
    const weak = items.find((i) => i.mentee.id === ids.weak)!;
    expect(strong.fitReason).toMatchObject({ source: 'RULE' });
    expect(strong.fitReason!.text).toContain(ids.reactLabel);
    expect(weak.fitReason).toMatchObject({ source: 'RULE' });
    // The internal score, weights and breakdown stay the operator's.
    expect(JSON.stringify(body)).not.toMatch(/"score"|"breakdown"|"contribution"|"ruleSetVersion"/);

    // The ranking that was shown is on record, per pair, with its rule-set version.
    const rows = await prisma.requisitionFit.findMany({ where: { requisitionId: ids.req } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ruleSetVersion === 'requisition-fit/1')).toBe(true);
    expect(rows.find((r) => r.menteeId === ids.strong)!.score).toBeGreaterThan(rows.find((r) => r.menteeId === ids.weak)!.score);

    // No AI pack / no provider: an honest "not available", never a 500, and the board is unchanged.
    const ai = await page.request.post(`/api/company/requisitions/${ids.req}/fit-reasons`);
    expect(ai.status()).toBe(200);
    expect((await ai.json()).ai).not.toBe('ok');
    const again = await (await page.request.get(`/api/company/requisitions/${ids.req}/applications`)).json();
    expect(again.columns.APPLIED.items).toHaveLength(2);
    expect(again.columns.APPLIED.items.every((i: { fitReason?: { source: string } }) => i.fitReason?.source === 'RULE')).toBe(true);
  });

  test('another company cannot ask for reasons on this requisition', async ({ page }) => {
    const other = await prisma.company.create({ data: { name: `FR Other ${stamp}`, orgId: ids.org } });
    const email = uniqueEmail('fr-other');
    emails.other = email;
    await prisma.user.create({ data: { email, password: await bcrypt.hash(password, 10), fullName: 'other', role: 'COMPANY', orgId: ids.org, companyId: other.id, skills: [] } });
    await login(page, email);
    expect((await page.request.post(`/api/company/requisitions/${ids.req}/fit-reasons`)).status()).toBe(404);
  });
});
