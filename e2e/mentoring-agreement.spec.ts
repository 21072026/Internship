import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';
import { acceptAgreement, agreementStateForRelation, agreementVersionText } from '../src/lib/mentoringAgreement';

// The mentoring agreement (#1790). Its own org.
//   • a fresh org gets the starter template as v1, in EN/TR/DE, EN binding;
//   • saving is always a new version; v1 stays readable, and an acceptance of
//     v1 still points at v1's exact text;
//   • PATCH / PUT / DELETE are refused server-side (405 immutable);
//   • another tenant's admin sees only their own org's agreement.

const PW = 'Agreement123!';

test.describe('mentoring agreement', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('ma-admin');
  const other = uniqueEmail('ma-other');
  const mentor = uniqueEmail('ma-mentor');
  const mentee = uniqueEmail('ma-mentee');
  let orgId = '';
  let otherOrgId = '';
  let relationId = '';
  let menteeId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `MA Org ${stamp}`, slug: `ma-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `MA Other ${stamp}`, slug: `ma-o-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `MA Admin ${stamp}`, orgId);
    await seedUser(other, PW, 'ADMIN', `MA Other ${stamp}`, otherOrgId);
    const mentorId = (await seedUser(mentor, PW, 'MENTOR', `MA Mentor ${stamp}`, orgId)).id;
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `MA Mentee ${stamp}`, orgId)).id;
    relationId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId } })).id;
  });

  test.afterAll(async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.mentoringAgreement.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    for (const email of [admin, other, mentor, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('template v1, a saved edit is v2, v1 stays what was accepted, no edits', async ({ page }) => {
    test.slow();
    await signInAndSettle(page, admin, PW, '/admin');
    const first = await (await page.request.get('/api/admin/agreements')).json();
    expect(first.versions).toHaveLength(1);
    const v1 = first.versions[0];
    expect(v1.version).toBe('1');
    expect(v1.texts.map((x: { locale: string }) => x.locale).sort()).toEqual(['de', 'en', 'tr']);
    expect(v1.texts.find((x: { isAuthoritative: boolean }) => x.isAuthoritative).locale).toBe('en');
    expect(v1.texts.find((x: { locale: string }) => x.locale === 'en').body).toContain('Template');

    // The mentee accepts v1.
    await acceptAgreement({ relationId, userId: menteeId, version: '1', locale: 'en' });
    expect((await agreementStateForRelation(relationId))).toMatchObject({ required: true, version: '1', bothAccepted: false });
    expect(await prisma.mentoringAgreementAcceptance.findFirst({ where: { relationId } })).toMatchObject({ role: 'MENTEE', version: '1' });

    // The editor saves an edit: version 2, binding in German.
    await gotoSettled(page, '/admin/agreements');
    await expect(page.getByTestId('agreement-current')).toContainText('1', { timeout: 60_000 });
    await page.getByTestId('agreement-body-de').fill('## Vereinbarung v2\n\nNeuer Text.');
    await page.getByTestId('agreement-authoritative').selectOption('de');
    await page.getByTestId('agreement-save').click();
    await expect(page.getByTestId('agreement-message')).toContainText('2');
    await expect(page.getByTestId('agreement-version-2')).toBeVisible();
    await expect(page.getByTestId('agreement-version-1')).toBeVisible();

    const rows = await prisma.mentoringAgreement.findMany({ where: { orgId }, orderBy: [{ version: 'asc' }, { locale: 'asc' }] });
    expect(new Set(rows.map((r) => r.version))).toEqual(new Set(['1', '2']));
    expect(rows.filter((r) => r.version === '2' && r.isAuthoritative).map((r) => r.locale)).toEqual(['de']);
    // v1 is untouched and the v1 acceptance still resolves to its exact text.
    expect((await agreementVersionText(orgId, '1', 'en'))?.body).toBe(v1.texts.find((x: { locale: string }) => x.locale === 'en').body);
    // The pairing now owes v2: a v1 acceptance says nothing about v2.
    expect(await agreementStateForRelation(relationId)).toMatchObject({ version: '2', menteeAcceptedAt: null });
    await expect(acceptAgreement({ relationId, userId: menteeId, version: '1' })).rejects.toMatchObject({ code: 'stale_version' });

    // No edit path exists.
    for (const method of ['patch', 'put', 'delete'] as const) {
      const res = await page.request[method]('/api/admin/agreements', { data: { version: '1', body: 'rewritten' } });
      expect(res.status()).toBe(405);
      expect((await res.json()).code).toBe('immutable');
    }
    expect(await prisma.mentoringAgreement.count({ where: { orgId, version: '1', body: 'rewritten' } })).toBe(0);
    // An empty save and a binding language without text are refused.
    expect((await (await page.request.post('/api/admin/agreements', { data: { bodies: {}, authoritativeLocale: 'en' } })).json()).code).toBe('body_required');
    expect((await (await page.request.post('/api/admin/agreements', { data: { bodies: { tr: 'x' }, authoritativeLocale: 'en' } })).json()).code).toBe('authoritative_missing');

    // Another tenant's admin sees their own org's template only.
    await page.context().clearCookies();
    await signInAndSettle(page, other, PW, '/admin');
    const theirs = await (await page.request.get('/api/admin/agreements')).json();
    expect(theirs.versions.map((v: { version: string }) => v.version)).toEqual(['1']);
    expect(theirs.report.relations).toHaveLength(0);
  });
});
