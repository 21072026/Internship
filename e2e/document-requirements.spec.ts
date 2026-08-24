import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { submitSignInForm } from './helpers/auth';

const password = 'DocumentReq123!';
const pdf = (name: string) => ({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${name}`) });

// These tests re-sign-in mid-test, so the fresh-user guards are mandatory: a
// blanket clearCookies() + unscoped submit click races the old session being
// re-issued and ends up clicking the previous dashboard (see helpers/auth.ts).
async function signIn(page: Page, email: string) {
  await submitSignInForm(page, email, password);
}

test.afterAll(async () => prisma.$disconnect());

test('admin CRUD validates keys, roles, stages and organization boundaries', async ({ page }) => {
  // The guarded sign-ins each spend up to ~20s in capped networkidle waits
  // (the app never goes network-idle, #1081) — triple the budget.
  test.slow();
  const stamp = Date.now();
  const adminEmail = uniqueEmail('req-admin');
  const org = await prisma.organization.create({ data: { name: `Req Org ${stamp}`, slug: `req-org-${stamp}` } });
  const otherOrg = await prisma.organization.create({ data: { name: `Other Req Org ${stamp}`, slug: `other-req-org-${stamp}` } });
  const admin = await seedUser(adminEmail, password, 'ADMIN', 'Requirement Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  let requirementId = '';
  let linkedDocumentId = '';
  try {
    await signIn(page, adminEmail);
    await page.waitForURL((url) => url.pathname.startsWith('/admin'));
    const body = { orgId: org.id, key: 'passport', labels: { en: 'Passport', tr: 'Pasaport', de: 'Reisepass' }, appliesToRole: 'MENTEE', appliesToStage: 'APPLICATION_100', mandatory: true, order: 1, active: true };
    const created = await page.request.post('/api/admin/document-requirements', { data: body });
    expect(created.status()).toBe(201);
    requirementId = (await created.json()).requirement.id;
    const listed = await page.request.get(`/api/admin/document-requirements?orgId=${org.id}`);
    expect(listed.ok()).toBeTruthy();
    expect((await listed.json()).requirements.map((item: { id: string }) => item.id)).toContain(requirementId);
    expect((await page.request.post('/api/admin/document-requirements', { data: body })).status()).toBe(409);
    expect((await page.request.post('/api/admin/document-requirements', { data: { ...body, key: 'bad-role', appliesToRole: 'OWNER' } })).status()).toBe(400);
    expect((await page.request.post('/api/admin/document-requirements', { data: { ...body, key: 'bad-stage', appliesToStage: 'NOT_A_STAGE' } })).status()).toBe(400);
    expect((await page.request.post('/api/admin/document-requirements', { data: { ...body, key: 'bad-labels', labels: { en: 'English only', de: 'Deutsch' } } })).status()).toBe(400);
    expect((await page.request.patch(`/api/admin/document-requirements/${requirementId}`, { data: { orgId: otherOrg.id, active: false } })).status()).toBe(403);
    const disabled = await page.request.patch(`/api/admin/document-requirements/${requirementId}`, { data: { orgId: org.id, active: false, order: 2 } });
    expect(disabled.ok()).toBeTruthy();
    const disabledBody = await disabled.json();
    expect(disabledBody.requirement.active).toBe(false);
    expect(disabledBody.requirement.order).toBe(2);

    const linkedDocument = await prisma.document.create({
      data: { ownerId: admin.id, uploaderId: admin.id, requirementId, type: 'OTHER', title: 'Preserved', filename: 'preserved.pdf', contentType: 'application/pdf', size: 8, data: Buffer.from('%PDF-1.4') },
    });
    linkedDocumentId = linkedDocument.id;
    expect((await page.request.delete(`/api/admin/document-requirements/${requirementId}?orgId=${org.id}`)).ok()).toBeTruthy();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: linkedDocumentId } })).requirementId).toBeNull();

    const fallback = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'fallback-label', labels: { en: 'English fallback', tr: '   ' }, appliesToRole: 'ADMIN' } });
    const ownDocuments = await (await page.request.get(`/api/documents?userId=${admin.id}`)).json();
    expect(ownDocuments.requirements.find((item: { id: string }) => item.id === fallback.id).label).toBe('English fallback');

    const requestedPages: number[] = [];
    await page.route('**/api/admin/organizations', (route) => route.fulfill({ json: { organizations: [{ id: org.id, name: org.name }] } }));
    // Playwright ≥1.57 no longer matches query strings with a `?**` glob —
    // `missing*` is what actually intercepts `/missing?orgId=…`.
    await page.route('**/api/admin/documents/missing*', (route) => {
      const requestedPage = Number(new URL(route.request().url()).searchParams.get('page'));
      requestedPages.push(requestedPage);
      return route.fulfill({ json: { rows: [], eligibleUserCount: 51, page: requestedPage, pageSize: 50, hasNextPage: requestedPage === 1 } });
    });
    await page.goto('/admin/documents');
    const pagination = page.getByTestId('missing-documents-pagination');
    await expect(pagination).toContainText('51 eligible users');
    await pagination.getByRole('button', { name: 'Next' }).click();
    await expect.poll(() => requestedPages.at(-1)).toBe(2);
    await page.getByRole('textbox', { name: 'Search candidates' }).fill('someone');
    await expect.poll(() => requestedPages.at(-1)).toBe(1);
  } finally {
    if (linkedDocumentId) await prisma.document.deleteMany({ where: { id: linkedDocumentId } });
    await prisma.documentRequirement.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } });
    await cleanupByEmail(adminEmail);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } });
  }
});

test('missing state is derived from requirement links and preserves both versioning modes', async ({ page }) => {
  test.slow(); // 4 guarded sign-ins — see the note on the first test.
  const stamp = Date.now();
  const adminEmail = uniqueEmail('req-doc-admin');
  const menteeEmail = uniqueEmail('req-doc-mentee');
  const foreignEmail = uniqueEmail('req-doc-foreign');
  const mentorEmail = uniqueEmail('req-doc-mentor');
  const secondMentorEmail = uniqueEmail('req-doc-mentor-two');
  const secondMenteeEmail = uniqueEmail('req-doc-mentee-two');
  const org = await prisma.organization.create({ data: { name: `Doc State Org ${stamp}`, slug: `doc-state-${stamp}` } });
  const foreignOrg = await prisma.organization.create({ data: { name: `Foreign Doc Org ${stamp}`, slug: `foreign-doc-${stamp}` } });
  const [admin, mentee, foreign, mentor, secondMentor, secondMentee] = await Promise.all([
    seedUser(adminEmail, password, 'ADMIN', 'Doc State Admin'), seedUser(menteeEmail, password, 'MENTEE', 'Own Missing Mentee'),
    seedUser(foreignEmail, password, 'MENTEE', 'Foreign Mentee'), seedUser(mentorEmail, password, 'MENTOR', 'Document Mentor'),
    seedUser(secondMentorEmail, password, 'MENTOR', 'Second Document Mentor'), seedUser(secondMenteeEmail, password, 'MENTEE', 'Second Missing Mentee'),
  ]);
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentee.id, mentor.id, secondMentor.id, secondMentee.id] } }, data: { orgId: org.id } });
  await prisma.user.update({ where: { id: foreign.id }, data: { orgId: foreignOrg.id } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: secondMentor.id, menteeId: mentee.id, pipelineStatus: 'INTERVIEW_PENDING_250' } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: secondMentee.id, pipelineStatus: 'HIRED_660' } });
  const requirement = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'id-card', labels: { en: 'Identity card', tr: 'Kimlik kartı', de: 'Personalausweis' }, appliesToRole: 'MENTEE', appliesToStage: 'APPLICATION_100', order: 1 } });
  const optional = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'optional-photo', labels: { en: 'Photo', tr: 'Fotoğraf', de: 'Foto' }, mandatory: false } });
  const inactive = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'inactive-doc', labels: { en: 'Inactive', tr: 'Pasif', de: 'Inaktiv' }, active: false } });
  // MENTOR-scoped so the foreign mentee (same foreign org) has no applicable
  // requirement — this fixture only feeds the cross-org 400 and empty-card checks.
  const foreignRequirement = await prisma.documentRequirement.create({ data: { orgId: foreignOrg.id, key: 'foreign', labels: { en: 'Foreign', tr: 'Yabancı', de: 'Fremd' }, appliesToRole: 'MENTOR' } });
  const wrongRole = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'mentor-only', labels: { en: 'Mentor only', tr: 'Yalnız mentor', de: 'Nur Mentor' }, appliesToRole: 'MENTOR' } });
  const wrongStage = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'wrong-stage', labels: { en: 'Wrong stage', tr: 'Yanlış aşama', de: 'Falsche Phase' }, appliesToRole: 'MENTEE', appliesToStage: 'EMPLOYED_700' } });
  const anyActiveStage = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'second-active-stage', labels: { en: 'Second active stage', tr: 'İkinci aktif aşama', de: 'Zweite aktive Phase' }, appliesToRole: 'MENTEE', appliesToStage: 'INTERVIEW_PENDING_250', order: 2 } });
  const secondMenteeOnly = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'second-mentee-stage', labels: { en: 'Second mentee document', tr: 'İkinci mentee belgesi', de: 'Dokument des zweiten Mentees' }, appliesToRole: 'MENTEE', appliesToStage: 'HIRED_660', order: 3 } });
  try {
    await signIn(page, adminEmail); await page.waitForURL((url) => url.pathname.startsWith('/admin'));
    const missing = await (await page.request.get(`/api/admin/documents/missing?orgId=${org.id}&stage=APPLICATION_100`)).json();
    expect(missing.rows.find((row: { user: { id: string } }) => row.user.id === mentee.id).missing.map((item: { id: string }) => item.id)).toEqual([requirement.id, anyActiveStage.id]);

    const firstPage = await (await page.request.get(`/api/admin/documents/missing?orgId=${org.id}&page=1&pageSize=1`)).json();
    const secondPage = await (await page.request.get(`/api/admin/documents/missing?orgId=${org.id}&page=2&pageSize=1`)).json();
    expect(firstPage.eligibleUserCount).toBe(2);
    expect(firstPage.hasNextPage).toBe(true);
    expect(secondPage.hasNextPage).toBe(false);
    expect(new Set([...firstPage.rows, ...secondPage.rows].map((row: { user: { id: string } }) => row.user.id))).toEqual(new Set([mentee.id, secondMentee.id]));
    const searched = await (await page.request.get(`/api/admin/documents/missing?orgId=${org.id}&search=${encodeURIComponent(secondMentee.email)}&page=1&pageSize=1`)).json();
    expect(searched.eligibleUserCount).toBe(1);
    expect(searched.rows[0].user.id).toBe(secondMentee.id);

    expect((await page.request.post('/api/documents', { multipart: { file: pdf('inactive-link'), targetUserId: mentee.id, requirementId: inactive.id } })).status()).toBe(400);
    expect((await page.request.post('/api/documents', { multipart: { file: pdf('template-link'), isTemplate: 'true', requirementId: requirement.id } })).status()).toBe(400);

    const legacy1 = await page.request.post('/api/documents', { multipart: { file: pdf('legacy-one'), type: 'OTHER', targetUserId: mentee.id } });
    const legacy2 = await page.request.post('/api/documents', { multipart: { file: pdf('legacy-two'), type: 'OTHER', targetUserId: mentee.id } });
    expect((await legacy1.json()).document.version).toBe(1);
    expect((await legacy2.json()).document.version).toBe(2);
    expect((await (await page.request.get(`/api/admin/documents/missing?orgId=${org.id}`)).json()).rows.some((row: { user: { id: string } }) => row.user.id === mentee.id)).toBe(true);

    const linked1 = await page.request.post('/api/documents', { multipart: { file: pdf('linked-one'), type: 'OTHER', targetUserId: mentee.id, requirementId: requirement.id } });
    const linked2 = await page.request.post('/api/documents', { multipart: { file: pdf('linked-two'), type: 'OTHER', targetUserId: mentee.id, requirementId: requirement.id } });
    const linked2Body = await linked2.json();
    expect((await linked1.json()).document.version).toBe(1);
    expect(linked2Body.document.version).toBe(2);
    const afterLinked = await (await page.request.get(`/api/admin/documents/missing?orgId=${org.id}`)).json();
    const remainingIds = afterLinked.rows.find((row: { user: { id: string } }) => row.user.id === mentee.id).missing.map((item: { id: string }) => item.id);
    expect(remainingIds).not.toContain(requirement.id);
    expect(remainingIds).toContain(anyActiveStage.id);
    expect((await page.request.post('/api/documents', { multipart: { file: pdf('foreign-link'), targetUserId: mentee.id, requirementId: foreignRequirement.id } })).status()).toBe(400);

    const linkedId = linked2Body.document.id;
    await signIn(page, foreignEmail); await page.waitForURL((url) => url.pathname.startsWith('/portal'));
    expect((await page.request.get(`/api/documents/${linkedId}`)).status()).toBe(403);
    expect((await page.request.get(`/api/admin/document-requirements?orgId=${org.id}`)).status()).toBe(401);

    await page.goto('/portal');
    await expect(page.getByTestId('missing-documents-card')).toHaveCount(0);
    await signIn(page, menteeEmail); await page.waitForURL((url) => url.pathname.startsWith('/portal'));
    await expect(page.getByTestId('missing-documents-card')).toContainText('Second active stage');
    await expect(page.getByTestId('missing-documents-card')).not.toContainText('Second mentee document');
    await signIn(page, secondMenteeEmail); await page.waitForURL((url) => url.pathname.startsWith('/portal'));
    await expect(page.getByTestId('missing-documents-card')).toContainText('Second mentee document');
    await expect(page.getByTestId('missing-documents-card')).not.toContainText('Second active stage');
  } finally {
    await prisma.documentRequirementReminder.deleteMany({ where: { requirementId: { in: [requirement.id, optional.id, inactive.id, foreignRequirement.id] } } });
    await prisma.document.deleteMany({ where: { ownerId: mentee.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: { in: [mentee.id, secondMentee.id] } } });
    await prisma.documentRequirement.deleteMany({ where: { orgId: { in: [org.id, foreignOrg.id] } } });
    for (const email of [menteeEmail, secondMenteeEmail, foreignEmail, mentorEmail, secondMentorEmail, adminEmail]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, foreignOrg.id] } } });
  }
});

test('portal warning and weekly reminders are missing-driven and deduped by UTC week', async ({ page }) => {
  test.slow(); // 3 guarded sign-ins — see the note on the first test.
  const stamp = Date.now();
  const menteeEmail = uniqueEmail('req-remind-mentee');
  const mentorEmail = uniqueEmail('req-remind-mentor');
  const optedOutMentorEmail = uniqueEmail('req-remind-optout');
  const inactiveMentorEmail = uniqueEmail('req-remind-inactive');
  const completedMentorEmail = uniqueEmail('req-remind-completed');
  const adminEmail = uniqueEmail('req-remind-admin');
  const emptyEmail = uniqueEmail('req-empty-mentee');
  const org = await prisma.organization.create({ data: { name: `Reminder Org ${stamp}`, slug: `reminder-org-${stamp}` } });
  const emptyOrg = await prisma.organization.create({ data: { name: `Empty Req Org ${stamp}`, slug: `empty-req-${stamp}` } });
  const [mentee, mentor, optedOutMentor, inactiveMentor, completedMentor, admin, emptyMentee] = await Promise.all([
    seedUser(menteeEmail, password, 'MENTEE', 'Reminder Mentee'), seedUser(mentorEmail, password, 'MENTOR', 'Reminder Mentor'),
    seedUser(optedOutMentorEmail, password, 'MENTOR', 'Opted Out Mentor'), seedUser(inactiveMentorEmail, password, 'MENTOR', 'Inactive Mentor'),
    seedUser(completedMentorEmail, password, 'MENTOR', 'Completed Mentor'), seedUser(adminEmail, password, 'ADMIN', 'Reminder Admin'),
    seedUser(emptyEmail, password, 'MENTEE', 'No Requirements Mentee'),
  ]);
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id, preferredLanguage: 'de', emailNotifications: true } });
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId: org.id, preferredLanguage: 'tr', emailNotifications: true } });
  await prisma.user.update({ where: { id: optedOutMentor.id }, data: { orgId: org.id, emailNotifications: true, notificationPrefs: { documents: false } } });
  await prisma.user.update({ where: { id: inactiveMentor.id }, data: { orgId: org.id, isActive: false } });
  await prisma.user.updateMany({ where: { id: { in: [completedMentor.id, admin.id] } }, data: { orgId: org.id } });
  await prisma.user.update({ where: { id: emptyMentee.id }, data: { orgId: emptyOrg.id } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: optedOutMentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: inactiveMentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: completedMentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100', status: 'COMPLETED', completedAt: new Date() } });
  const requirement = await prisma.documentRequirement.create({ data: { orgId: org.id, key: 'residence', labels: { en: 'Residence permit', tr: 'Oturum izni', de: 'Aufenthaltstitel' }, appliesToRole: 'MENTEE' } });
  try {
    await signIn(page, menteeEmail); await page.waitForURL((url) => url.pathname.startsWith('/portal'));
    // The portal renders in the signed-in user's preferred language — this
    // mentee is seeded with `preferredLanguage: 'de'`, so the card shows the
    // German label, not the English one.
    await expect(page.getByTestId('missing-documents-card')).toContainText('Aufenthaltstitel');
    await signIn(page, emptyEmail); await page.waitForURL((url) => url.pathname.startsWith('/portal'));
    await expect(page.getByTestId('missing-documents-card')).toHaveCount(0);

    await prisma.emailLog.deleteMany({ where: { to: { in: [menteeEmail, mentorEmail, optedOutMentorEmail, inactiveMentorEmail, completedMentorEmail] }, category: 'document-reminder' } });
    await signIn(page, adminEmail); await page.waitForURL((url) => url.pathname.startsWith('/admin'));
    expect((await page.request.get('/api/cron?job=missing-documents')).ok()).toBeTruthy();
    expect((await page.request.get('/api/cron?job=missing-documents')).ok()).toBeTruthy();
    expect(await prisma.documentRequirementReminder.count({ where: { requirementId: requirement.id, menteeId: mentee.id } })).toBe(3);
    expect(await prisma.notification.count({ where: { userId: { in: [mentee.id, mentor.id, optedOutMentor.id] }, type: { startsWith: 'missing_document.' } } })).toBe(3);
    expect(await prisma.notification.count({ where: { userId: { in: [inactiveMentor.id, completedMentor.id] }, type: { startsWith: 'missing_document.' } } })).toBe(0);
    expect(await prisma.emailLog.count({ where: { to: { in: [menteeEmail, mentorEmail] }, category: 'document-reminder' } })).toBe(2);
    expect(await prisma.emailLog.count({ where: { to: optedOutMentorEmail, category: 'document-reminder' } })).toBe(0);
    expect((await prisma.emailLog.findFirstOrThrow({ where: { to: menteeEmail, category: 'document-reminder' } })).subject).toContain('Erinnerung an fehlendes Dokument');
    expect((await prisma.emailLog.findFirstOrThrow({ where: { to: mentorEmail, category: 'document-reminder' } })).subject).toContain('Eksik belge hatırlatması');

    await prisma.documentRequirementReminder.updateMany({ where: { requirementId: requirement.id }, data: { weekStart: new Date('2020-01-06T00:00:00.000Z') } });
    expect((await page.request.get('/api/cron?job=missing-documents')).ok()).toBeTruthy();
    expect(await prisma.documentRequirementReminder.count({ where: { requirementId: requirement.id, menteeId: mentee.id } })).toBe(6);
    expect(await prisma.emailLog.count({ where: { to: { in: [menteeEmail, mentorEmail] }, category: 'document-reminder' } })).toBe(4);

    await prisma.document.create({ data: { ownerId: mentee.id, uploaderId: mentee.id, requirementId: requirement.id, type: 'OTHER', title: 'Permit', filename: 'permit.pdf', contentType: 'application/pdf', size: 8, data: Buffer.from('%PDF-1.4') } });
    await prisma.documentRequirementReminder.updateMany({ where: { requirementId: requirement.id, weekStart: { gt: new Date('2021-01-01T00:00:00.000Z') } }, data: { weekStart: new Date('2020-01-13T00:00:00.000Z') } });
    expect((await page.request.get('/api/cron?job=missing-documents')).ok()).toBeTruthy();
    expect(await prisma.documentRequirementReminder.count({ where: { requirementId: requirement.id, menteeId: mentee.id } })).toBe(6);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentee.id, mentor.id] }, type: { startsWith: 'missing_document.' } } });
    await prisma.emailLog.deleteMany({ where: { to: { in: [menteeEmail, mentorEmail, optedOutMentorEmail, inactiveMentorEmail, completedMentorEmail] }, category: 'document-reminder' } });
    await prisma.documentRequirementReminder.deleteMany({ where: { requirementId: requirement.id } });
    await prisma.document.deleteMany({ where: { ownerId: mentee.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await prisma.documentRequirement.deleteMany({ where: { orgId: org.id } });
    for (const email of [menteeEmail, mentorEmail, optedOutMentorEmail, inactiveMentorEmail, completedMentorEmail, adminEmail, emptyEmail]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, emptyOrg.id] } } });
  }
});
