import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #813: org-branded internship certificate / reference letter PDF, generated
// by the mentor/admin from a completed relation, stored as the mentee's
// CERTIFICATE Document, and downloadable only by the mentee, their mentor, or
// an admin.
test('certificate: mentor generates a PDF for a completed internship; mentee downloads it, another mentee is forbidden', async ({ browser }) => {
  const mentorEmail = uniqueEmail('cert-mentor');
  const menteeEmail = uniqueEmail('cert-mentee');
  const otherEmail = uniqueEmail('cert-other');
  const pw = 'CertPass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Cert Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Cert Mentee');
  const other = await seedUser(otherEmail, pw, 'MENTEE', 'Cert Other');
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['React', 'SQL'] } });

  // The completed internship this test issues a certificate for.
  const relation = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'COMPLETED',
      pipelineStatus: 'INTERNSHIP_COMPLETED_490',
      completedAt: new Date(),
    },
  });
  // A still-active relation: the certificate action must stay unavailable.
  const activeRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: other.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });

  const mentorCtx = await browser.newContext();
  const menteeCtx = await browser.newContext();
  const otherCtx = await browser.newContext();
  let docId = '';
  try {
    const mentorPage = await mentorCtx.newPage();
    await signInAndSettle(mentorPage, mentorEmail, pw, '/mentor');

    // Not eligible yet (still ACTIVE, first pipeline stage): the API rejects it
    // even if someone drives it directly, not just the hidden button.
    const blocked = await mentorPage.request.post(`/api/mentorship/${activeRel.id}/certificate`, {
      data: { variant: 'CERTIFICATE', locale: 'en', body: 'Draft.' },
    });
    expect(blocked.status()).toBe(400);

    // UI: the mentee detail page shows the action for the completed relation
    // and generates through the actual form, not just the API.
    await mentorPage.goto(`/mentor/mentees/${relation.id}`);
    const genButton = mentorPage.getByTestId('generate-certificate-button');
    await expect(genButton).toBeVisible({ timeout: 10_000 });
    await genButton.click();
    await expect(mentorPage.getByTestId('certificate-modal')).toBeVisible();
    await mentorPage.getByTestId('certificate-body').fill('Certificate body edited by the mentor for this e2e test.');
    await mentorPage.getByTestId('generate-certificate-submit').click();
    await expect(mentorPage.getByTestId('certificate-generated')).toBeVisible({ timeout: 15_000 });

    const list = await mentorPage.request.get(`/api/documents?userId=${mentee.id}`);
    const docs = (await list.json()).documents as { id: string; type: string }[];
    const cert = docs.find((d) => d.type === 'CERTIFICATE');
    expect(cert).toBeTruthy();
    docId = cert!.id;

    const dl = await mentorPage.request.get(`/api/documents/${docId}`);
    expect(dl.ok()).toBeTruthy();
    expect(dl.headers()['content-type']).toContain('application/pdf');

    // The mentee downloads their own certificate from the portal.
    const menteePage = await menteeCtx.newPage();
    await signInAndSettle(menteePage, menteeEmail, pw, '/portal');
    const selfDl = await menteePage.request.get(`/api/documents/${docId}`);
    expect(selfDl.ok()).toBeTruthy();
    // The documents list moved off the dashboard to /portal/profile (#916).
    await menteePage.goto('/portal/profile');
    await expect(menteePage.getByTestId(`doc-${docId}`)).toBeVisible({ timeout: 10_000 });

    // An unrelated mentee is forbidden.
    const otherPage = await otherCtx.newPage();
    await signInAndSettle(otherPage, otherEmail, pw, '/portal');
    const otherDl = await otherPage.request.get(`/api/documents/${docId}`);
    expect(otherDl.status()).toBe(403);

    // Admin has the same action on their own candidate-detail page (#813:
    // scope is admin + mentor, and the admin's real navigation path is
    // /admin/candidates/[id], not the mentor shell's /mentor/mentees/[id]).
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInAndSettle(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await adminPage.goto(`/admin/candidates/${mentee.id}`);
    await expect(adminPage.getByTestId('generate-certificate-button')).toBeVisible({ timeout: 10_000 });
    await adminCtx.close();
  } finally {
    await mentorCtx.close();
    await menteeCtx.close();
    await otherCtx.close();
    if (docId) await prisma.document.deleteMany({ where: { id: docId } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relation.id, activeRel.id] } } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(otherEmail);
  }
});
