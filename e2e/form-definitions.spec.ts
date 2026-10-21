import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { latestFormAnswers, liveFormDefinition, saveFormResponses } from '../src/lib/forms/definitions';

// The admin-form write boundary (#1800). Its own org.
//   • a free-text field cannot be made matchable (400, at the write);
//   • a published version is not edited in place — the edit is version 2;
//   • re-typing a published key is a 409; answers keyed by fieldKey resolve
//     across versions, and an archived field's answer stays readable;
//   • another tenant's admin cannot read the form.

const PW = 'FormDefs123!';

test.describe('form definitions', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('fd-admin');
  const other = uniqueEmail('fd-other');
  const mentee = uniqueEmail('fd-mentee');
  let orgId = '';
  let otherOrgId = '';
  let menteeId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `FD Org ${stamp}`, slug: `fd-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `FD Other ${stamp}`, slug: `fd-o-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `FD Admin ${stamp}`, orgId);
    await seedUser(other, PW, 'ADMIN', `FD Other ${stamp}`, otherOrgId);
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `FD Mentee ${stamp}`, orgId)).id;
  });

  test.afterAll(async () => {
    await prisma.formDefinition.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    for (const email of [admin, other, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('versions, locks, matchable and answers across versions', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const track = { key: 'track', type: 'SELECT', labels: { en: 'Track', tr: 'Alan', de: 'Bereich' }, required: true, matchable: true, options: [{ value: 'web', labels: { en: 'Web', tr: 'Web', de: 'Web' } }, { value: 'data', labels: { en: 'Data', tr: 'Veri', de: 'Daten' } }] };
    const bio = { key: 'about', type: 'LONG_TEXT', labels: { en: 'About you', tr: 'Hakkında', de: 'Über dich' } };
    const base = { key: `mentee_reg_${stamp}`, audience: 'MENTEE', surface: 'REGISTRATION', title: { en: 'Registration' } };

    // Free text can never feed matching — refused at the write, not in a UI.
    const refused = await page.request.post('/api/admin/forms', { data: { ...base, fields: [track, { ...bio, matchable: true }] } });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).code).toBe('not_matchable');

    const created = await page.request.post('/api/admin/forms', { data: { ...base, fields: [track, bio] } });
    expect(created.status()).toBe(201);
    const v1 = (await created.json()).form;
    expect(v1.version).toBe(1);
    // A draft is edited in place.
    const draftEdit = await page.request.put(`/api/admin/forms/${v1.id}`, { data: { fields: [track, { ...bio, labels: { en: 'Tell us about you', tr: 'Kendinden bahset', de: 'Erzähl von dir' } }] } });
    expect(draftEdit.status()).toBe(200);
    expect((await page.request.post(`/api/admin/forms/${v1.id}/publish`)).status()).toBe(200);
    expect((await page.request.post(`/api/admin/forms/${v1.id}/publish`)).status()).toBe(409);

    // An answer to v1.
    const live1 = await liveFormDefinition(orgId, base.key);
    await saveFormResponses(menteeId, live1!, { track: 'data', about: 'Hello' });
    await expect(saveFormResponses(menteeId, live1!, { track: 'mobile' })).rejects.toMatchObject({ code: 'invalid_answers' });

    // Re-typing a published key is a 409; re-keying an existing field id is a 409.
    const v1Fields = (await (await page.request.get(`/api/admin/forms/${v1.id}`)).json()).form.fields as { id: string; key: string }[];
    const trackId = v1Fields.find((f) => f.key === 'track')!.id;
    const retyped = await page.request.put(`/api/admin/forms/${v1.id}`, { data: { fields: [{ ...track, type: 'MULTI_SELECT' }] } });
    expect([retyped.status(), (await retyped.json()).code]).toEqual([409, 'field_type_locked']);
    const rekeyed = await page.request.put(`/api/admin/forms/${v1.id}`, { data: { fields: [{ ...track, id: trackId, key: 'track_renamed' }] } });
    expect([rekeyed.status(), (await rekeyed.json()).code]).toEqual([409, 'field_key_locked']);

    // Editing the published version creates version 2 — `about` dropped (carried archived).
    const v2res = await page.request.put(`/api/admin/forms/${v1.id}`, { data: { fields: [track, { key: 'city', type: 'TEXT', labels: { en: 'City', tr: 'Şehir', de: 'Stadt' } }] } });
    expect(v2res.status()).toBe(201);
    const v2 = (await v2res.json()).form;
    expect(v2.version).toBe(2);
    expect(v2.publishedAt).toBeNull();
    expect(v2.fields.find((f: { key: string }) => f.key === 'about').archivedAt).not.toBeNull();
    // A second edit of v1 while v2 is a draft forks nothing.
    expect((await (await page.request.put(`/api/admin/forms/${v1.id}`, { data: { fields: [track] } })).json()).code).toBe('draft_exists');
    expect((await page.request.post(`/api/admin/forms/${v2.id}/publish`)).status()).toBe(200);
    const versions = await prisma.formDefinition.findMany({ where: { orgId, key: base.key }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => [v.version, !!v.publishedAt, !!v.archivedAt])).toEqual([[1, true, true], [2, true, false]]);

    // Answers keyed by fieldKey still resolve under v2 — the archived field's too.
    const answers = await latestFormAnswers(menteeId, orgId, base.key);
    expect(answers.get('track')).toBe('data');
    expect(answers.get('about')).toBe('Hello');
    // v2 no longer asks `about`.
    const live2 = await liveFormDefinition(orgId, base.key);
    await expect(saveFormResponses(menteeId, live2!, { track: 'web', about: 'x' })).rejects.toMatchObject({ code: 'invalid_answers' });
    await saveFormResponses(menteeId, live2!, { track: 'web', city: 'Köln' });
    expect((await latestFormAnswers(menteeId, orgId, base.key)).get('track')).toBe('web');

    // Another tenant's admin sees nothing.
    await page.context().clearCookies();
    await signInAndSettle(page, other, PW, '/admin');
    expect((await page.request.get(`/api/admin/forms/${v2.id}`)).status()).toBe(404);
    expect((await page.request.post(`/api/admin/forms/${v2.id}/publish`)).status()).toBe(404);
    expect(((await (await page.request.get('/api/admin/forms')).json()).forms as unknown[]).length).toBe(0);
  });
});
