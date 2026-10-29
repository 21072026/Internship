import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { OFFER_COMPENSATION_FIELDS, OFFER_LETTER_FIELDS } from '../src/lib/offers';

// The offer letter (#1857): an org template, a snapshot frozen on send, a PDF
// only ADMIN and the offer's own mentee may fetch, and a click-to-accept record.
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('offer letter: template → send freezes the snapshot → mentee reads, downloads and accepts; COMPANY and another mentee get 403', { tag: '@smoke' }, async ({ page }) => {
  // Three sign-ins and a PDF render: more than the default minute on a cold dev server.
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
  const pw = 'OfferLetterPass123!';
  const emails = {
    admin: uniqueEmail('ol-admin'),
    mentor: uniqueEmail('ol-mentor'),
    mentee: uniqueEmail('ol-mentee'),
    other: uniqueEmail('ol-other'),
    company: uniqueEmail('ol-company'),
  };
  const org = await prisma.organization.create({ data: { name: `Letter Org ${stamp}`, slug: `letter-${stamp}` } });
  const admin = await seedUser(emails.admin, pw, 'ADMIN', 'Letter Admin', org.id);
  const mentor = await seedUser(emails.mentor, pw, 'MENTOR', 'Letter Mentor', org.id);
  // A Turkish name: the PDF's standard fonts cannot draw ş/ğ/İ, and the
  // download must still succeed.
  const mentee = await seedUser(emails.mentee, pw, 'MENTEE', 'Ayşe Yağmur İnce', org.id);
  await prisma.user.update({ where: { id: mentee.id }, data: { preferredLanguage: 'tr' } });
  await seedUser(emails.other, pw, 'MENTEE', 'Other Mentee', org.id);
  const company = await prisma.company.create({ data: { name: `Acme Sales ${stamp}`, orgId: org.id } });
  await prisma.user.create({
    data: { email: emails.company, password: await bcrypt.hash(pw, 10), role: 'COMPANY', fullName: 'Company Reader', companyId: company.id, orgId: org.id, skills: [] },
  });
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, orgId: org.id } });
  const offer = await prisma.offer.create({
    data: {
      orgId: org.id,
      relationId: relation.id,
      companyId: company.id,
      status: 'DRAFT',
      position: 'Backend Stajyeri',
      startDate: new Date('2027-03-01T00:00:00Z'),
      currency: 'EUR',
      baseAmountMinor: 240_000,
      basePeriod: 'MONTHLY',
      createdById: admin.id,
    },
  });

  try {
    // The org's own Turkish template, with an unknown tag that must stay literal.
    await signInAndSettle(page, emails.admin, pw, '/admin');
    const put = await page.request.put('/api/admin/offer-templates', {
      data: { locale: 'tr', bodyMarkdown: `# Özel teklif ${stamp}\n\nSayın {{candidateName}}, {{position}} · {{compensation}} · {{salary}}` },
    });
    expect(put.status()).toBe(200);

    // A draft is a live preview for ADMIN.
    const draft = await page.request.get(`/api/offers/${offer.id}/letter?format=json`);
    expect(draft.status()).toBe(200);
    expect((await draft.json()).frozen).toBe(false);

    // Sending freezes the letter in the candidate's language.
    const send = await page.request.patch(`/api/offers/${offer.id}`, { data: { action: 'send' } });
    expect(send.status()).toBe(200);
    const sent = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(sent.letterLocale).toBe('tr');
    expect(sent.letterSnapshot).toContain(`Özel teklif ${stamp}`);
    expect(sent.letterSnapshot).toContain('Sayın Ayşe Yağmur İnce, Backend Stajyeri');
    expect(sent.letterSnapshot).toContain('2.400,00');
    expect(sent.letterSnapshot).toContain('{{salary}}');

    // A later template edit does not touch what was sent.
    await page.request.put('/api/admin/offer-templates', { data: { locale: 'tr', bodyMarkdown: 'Tamamen başka bir metin {{position}}' } });
    const frozen = await (await page.request.get(`/api/offers/${offer.id}/letter?format=json`)).json();
    expect(frozen.frozen).toBe(true);
    expect(frozen.markdown).toBe(sent.letterSnapshot);

    // COMPANY: may read its offer, never the letter or its text.
    await signInAsFreshUser(page, emails.company, pw, '/company');
    expect((await page.request.get(`/api/offers/${offer.id}/letter`)).status()).toBe(403);
    expect((await page.request.get(`/api/offers/${offer.id}/letter?format=json`)).status()).toBe(403);
    const companyView = await (await page.request.get(`/api/offers/${offer.id}`)).json();
    for (const f of [...OFFER_COMPENSATION_FIELDS, ...OFFER_LETTER_FIELDS, 'acceptedIp', 'acceptedUserAgent']) {
      expect(companyView.offer).not.toHaveProperty(f);
    }

    // Another mentee of the same org: 403.
    await signInAsFreshUser(page, emails.other, pw, '/portal');
    expect((await page.request.get(`/api/offers/${offer.id}/letter`)).status()).toBe(403);

    // The candidate: reads the letter on the card, downloads the PDF, accepts.
    await signInAsFreshUser(page, emails.mentee, pw, '/portal');
    const pdf = await page.request.get(`/api/offers/${offer.id}/letter`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

    await page.goto('/portal');
    await expect(page.getByTestId('offer-card')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('offer-letter-toggle').click();
    await expect(page.getByTestId('offer-letter-text')).toContainText(`Özel teklif ${stamp}`);
    await expect(page.getByTestId('offer-letter-record-notice')).toContainText('nitelikli elektronik imza değildir');

    const accept = await page.request.patch(`/api/offers/${offer.id}`, { data: { action: 'accept' } });
    expect(accept.status()).toBe(200);
    const accepted = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.decidedAt).not.toBeNull();
    expect(accepted.acceptedIp).toBeTruthy();
    expect(accepted.acceptedUserAgent).toBeTruthy();
    expect(accepted.letterSnapshot).toBe(sent.letterSnapshot);
    // The record is ADMIN-only: the mentee's own read does not echo it back.
    const menteeView = await (await page.request.get(`/api/offers/${offer.id}`)).json();
    expect(menteeView.offer.letterSnapshot).toBe(sent.letterSnapshot);
    expect(menteeView.offer).not.toHaveProperty('acceptedIp');
  } finally {
    await prisma.auditLog.deleteMany({ where: { targetId: offer.id } });
    await prisma.offer.deleteMany({ where: { id: offer.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await prisma.offerTemplate.deleteMany({ where: { orgId: org.id } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.company.deleteMany({ where: { id: company.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
