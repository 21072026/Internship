import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';

// The mentee's own completion certificate in the portal + LinkedIn's official
// "add to profile" link (src/components/PortalCertificateCard.tsx,
// src/lib/certificateLinkedIn.ts). Generating stays mentor/admin-only (#813);
// downloading is GET /api/documents/[id], which answers the owner and staff —
// never another mentee.

const PW = 'PortalCert123';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee sees their issued certificate, downloads it and gets a LinkedIn add-to-profile link; another mentee is refused', async ({ browser }) => {
  // Three sign-ins (mentee, mentor, other mentee) on a cold dev server.
  test.setTimeout(120_000);
  const mentorEmail = uniqueEmail('pcert-mentor');
  const menteeEmail = uniqueEmail('pcert-mentee');
  const otherEmail = uniqueEmail('pcert-other');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'PCert Mentor');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'PCert Mentee');
  const other = await seedUser(otherEmail, PW, 'MENTEE', 'PCert Other');

  const relation = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'COMPLETED',
      pipelineStatus: 'INTERNSHIP_COMPLETED_490',
      completedAt: new Date(),
    },
  });
  // Still at the first stage: no certificate card at all.
  const otherRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: other.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });
  // A "certificate" the other mentee uploaded themselves must never surface as
  // an issued one (it would be a self-issued claim on LinkedIn).
  const selfUpload = await prisma.document.create({
    data: {
      ownerId: other.id, uploaderId: other.id, type: 'CERTIFICATE',
      title: 'Internship Completion Certificate — PCert Other', filename: 'self.pdf',
      contentType: 'application/pdf', size: 4, version: 1, data: Buffer.from('%PDF'),
    },
  });
  // A certificate genuinely issued to the mentee, but for an EARLIER programme
  // (generated before this relation started): it must not be presented as this
  // relation's certificate — the card stays pending until this one is issued.
  await prisma.document.create({
    data: {
      ownerId: mentee.id, uploaderId: mentor.id, type: 'CERTIFICATE',
      title: 'Internship Completion Certificate — PCert Mentee', filename: 'earlier.pdf',
      contentType: 'application/pdf', size: 4, version: 1, data: Buffer.from('%PDF'),
      createdAt: new Date(relation.startDate.getTime() - 400 * 24 * 3600 * 1000),
    },
  });

  const mentorCtx = await browser.newContext();
  const menteeCtx = await browser.newContext();
  const otherCtx = await browser.newContext();
  try {
    const menteePage = await menteeCtx.newPage();
    await signInAndSettle(menteePage, menteeEmail, PW, '/portal');

    // Eligible but not issued yet: the card says so, and offers nothing to click.
    await gotoSettled(menteePage, '/portal/journey');
    const card = menteePage.getByTestId('portal-certificate-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(menteePage.getByTestId('portal-certificate-pending')).toBeVisible();
    await expect(menteePage.getByTestId('portal-certificate-download')).toHaveCount(0);
    await expect(menteePage.getByTestId('portal-certificate-linkedin')).toHaveCount(0);

    // The mentee cannot issue their own certificate (#813, unchanged).
    const selfIssue = await menteePage.request.post(`/api/mentorship/${relation.id}/certificate`, {
      data: { variant: 'CERTIFICATE', locale: 'en', body: 'Self-issued.' },
    });
    expect(selfIssue.status()).toBe(403);

    // The mentor issues it through the existing route.
    const mentorPage = await mentorCtx.newPage();
    await signInAndSettle(mentorPage, mentorEmail, PW, '/mentor');
    const gen = await mentorPage.request.post(`/api/mentorship/${relation.id}/certificate`, {
      data: { variant: 'CERTIFICATE', locale: 'en', body: 'Completed the programme.' },
    });
    expect(gen.status()).toBe(201);
    const docId = (await gen.json()).document.id as string;
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: docId }, select: { createdAt: true } });

    await gotoSettled(menteePage, '/portal/journey');
    await expect(menteePage.getByTestId('portal-certificate-name')).toHaveText('Internship Completion Certificate');
    const issuer = (await menteePage.getByTestId('portal-certificate-issuer').innerText()).trim();
    expect(issuer.length).toBeGreaterThan(0);

    // Twenty-five newer self-uploaded "certificates" must not crowd the issued
    // one out of the card (the issued-only conditions live in the query).
    await prisma.document.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        ownerId: mentee.id, uploaderId: mentee.id, type: 'CERTIFICATE' as const,
        title: `Internship Completion Certificate — self ${i}`, filename: `self-${i}.pdf`,
        contentType: 'application/pdf', size: 4, version: 1, data: Buffer.from('%PDF'),
      })),
    });
    await gotoSettled(menteePage, '/portal/journey');
    await expect(menteePage.getByTestId('portal-certificate-download')).toHaveAttribute('href', `/api/documents/${docId}`);

    // Download: the existing document route, the mentee's own PDF.
    const download = menteePage.getByTestId('portal-certificate-download');
    await expect(download).toHaveAttribute('href', `/api/documents/${docId}`);
    const dl = await menteePage.request.get(`/api/documents/${docId}`);
    expect(dl.ok()).toBeTruthy();
    expect(dl.headers()['content-type']).toContain('application/pdf');

    // LinkedIn: official endpoint, encoded values, issue month from the
    // document, new tab without opener/referrer, and no public certificate URL.
    const li = menteePage.getByTestId('portal-certificate-linkedin');
    await expect(li).toHaveAttribute('target', '_blank');
    const rel = (await li.getAttribute('rel')) ?? '';
    expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    const url = new URL((await li.getAttribute('href'))!);
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/profile/add');
    expect(url.searchParams.get('startTask')).toBe('CERTIFICATION_NAME');
    expect(url.searchParams.get('name')).toBe('Internship Completion Certificate');
    expect(url.searchParams.get('organizationName')).toBe(issuer);
    expect(url.searchParams.get('issueYear')).toBe(String(doc.createdAt.getUTCFullYear()));
    expect(url.searchParams.get('issueMonth')).toBe(String(doc.createdAt.getUTCMonth() + 1));
    expect(url.searchParams.has('certUrl')).toBe(false);
    expect(url.searchParams.has('certId')).toBe(false);
    await expect(li).toHaveAccessibleName(/LinkedIn/);

    // Mobile width: the card fits without a horizontal scroll.
    await menteePage.setViewportSize({ width: 375, height: 800 });
    await expect(li).toBeVisible();
    const overflow = await menteePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // Dark mode: the card's text stays light on the dark card.
    await menteePage.evaluate(() => document.documentElement.classList.add('dark'));
    const nameColor = await menteePage.getByTestId('portal-certificate-name').evaluate((el) => getComputedStyle(el).color);
    const [r, g, b] = (nameColor.match(/\d+/g) ?? []).map(Number);
    expect((r + g + b) / 3).toBeGreaterThan(150);

    // Negative: another mentee gets 403 for this certificate, and their own
    // portal shows no card (first-stage relation; their self-uploaded file
    // does not count as issued).
    const otherPage = await otherCtx.newPage();
    await signInAndSettle(otherPage, otherEmail, PW, '/portal');
    const otherDl = await otherPage.request.get(`/api/documents/${docId}`);
    expect(otherDl.status()).toBe(403);
    const otherGen = await otherPage.request.post(`/api/mentorship/${relation.id}/certificate`, {
      data: { variant: 'CERTIFICATE', locale: 'en', body: 'Not mine.' },
    });
    expect(otherGen.status()).toBe(403);
    await gotoSettled(otherPage, '/portal/journey');
    await expect(otherPage.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(otherPage.getByTestId('portal-certificate-card')).toHaveCount(0);

    // Even at an eligible stage, a self-upload is not an issued certificate.
    await prisma.mentorshipRelation.update({ where: { id: otherRel.id }, data: { pipelineStatus: 'INTERNSHIP_COMPLETED_490' } });
    await gotoSettled(otherPage, '/portal/journey');
    await expect(otherPage.getByTestId('portal-certificate-pending')).toBeVisible({ timeout: 15_000 });
    await expect(otherPage.getByTestId('portal-certificate-linkedin')).toHaveCount(0);
  } finally {
    await mentorCtx.close();
    await menteeCtx.close();
    await otherCtx.close();
    await prisma.document.deleteMany({ where: { ownerId: { in: [mentee.id, other.id] } } });
    await prisma.document.deleteMany({ where: { id: selfUpload.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relation.id, otherRel.id] } } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(otherEmail);
  }
});

test('a MARKETING tenant never reaches the certificate card (mentorship capability)', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `PCert MKT ${stamp}`, slug: `pcert-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const email = uniqueEmail('pcert-mkt');
  const mentorEmail = uniqueEmail('pcert-mkt-mentor');
  const user = await seedUser(email, PW, 'MENTEE', 'PCert Mkt', { orgId: org.id });
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'PCert Mkt Mentor', { orgId: org.id });
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id, menteeId: user.id, orgId: org.id,
      status: 'COMPLETED', pipelineStatus: 'INTERNSHIP_COMPLETED_490', completedAt: new Date(),
    },
  });
  await prisma.document.create({
    data: {
      ownerId: user.id, uploaderId: mentor.id, type: 'CERTIFICATE',
      title: 'Internship Completion Certificate — PCert Mkt', filename: 'c.pdf',
      contentType: 'application/pdf', size: 4, version: 1, data: Buffer.from('%PDF'),
    },
  });
  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
    await page.goto('/portal/journey');
    await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
    await expect(page.getByTestId('portal-certificate-card')).toHaveCount(0);
  } finally {
    await prisma.document.deleteMany({ where: { ownerId: user.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(email);
    await cleanupByEmail(mentorEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
