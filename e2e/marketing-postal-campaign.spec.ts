import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';

// Postal campaigns — the outbound acquisition tool (#2697,
// docs/marketing-vertical/postal-campaigns.md).
//
// What this pins, end to end, on a MARKETING tenant:
//   1. an account that objected, or has no address, can be SEEN in the picker
//      with its reason but cannot be added — not through the UI and not
//      through the API;
//   2. an objection outlives the account: delete it, type it in again under the
//      same VAT id, and it is still blocked (the Sperrliste);
//   3. the print view carries the address block and the Art. 14 notice with
//      the campaign's data source;
//   4. "mark as posted" locks the campaign — no edit, no delete;
//   5. the letter's short link lands on the demo form with the campaign as its
//      source, and a request through it is counted in the campaign's results.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'PostCampaign123';

async function cleanupOrg(orgId: string, emails: string[]) {
  await prisma.postCampaign.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.contactSuppression.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.companyInquiry.deleteMany({ where: { orgId } }).catch(() => {});
  const companies = await prisma.company.findMany({ where: { orgId }, select: { id: true } });
  await prisma.activityLog.deleteMany({ where: { targetId: { in: companies.map((c) => c.id) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

test('a postal campaign: eligibility, objection + block list, print, lock, short link and results', async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Post MKT ${stamp}`, slug: `post-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const adminEmail = uniqueEmail('post-admin');
  const menteeEmail = uniqueEmail('post-mentee');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Post Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Post Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id } });

  const vat = `DE${String(Date.now()).slice(-9)}`;
  const ok = await prisma.company.create({
    data: { orgId: org.id, name: `Shop Gut ${stamp}`, contactName: 'Eva Weber', address: 'Hauptstraße 1\n10115 Berlin', country: 'DE' },
  });
  const noAddress = await prisma.company.create({ data: { orgId: org.id, name: `Shop Ohne ${stamp}` } });
  const objecting = await prisma.company.create({
    data: { orgId: org.id, name: `Shop Nein ${stamp}`, vatId: vat, address: 'Ring 2, 20095 Hamburg', country: 'DE', contactEmail: uniqueEmail('nein') },
  });
  const dataSource = `Öffentliches Impressum des Online-Shops (§ 5 DDG), abgerufen ${stamp}`;
  const code = `herbst-${String(Date.now()).slice(-6)}`;

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, adminEmail, PW, '/admin');

    // The owner of one account objected by phone: recorded on the account page.
    await gotoSettled(page, `/admin/companies/${objecting.id}`);
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('contact-permission-objection').click();
    await expect(page.getByTestId('contact-permission-objection-done')).toBeVisible({ timeout: 20_000 });
    const rows = await prisma.contactPermission.findMany({ where: { companyId: objecting.id } });
    expect(rows.map((r) => r.channel).sort()).toEqual(['EMAIL', 'PHONE', 'POST']);
    for (const r of rows) expect([r.revokedVia, !!r.revokedAt]).toEqual(['OBJECTION', true]);
    // An objection is locked like the opt-out link: an admin cannot write over it.
    const regrant = await page.request.put(`/api/admin/companies/${objecting.id}/contact-permission`, {
      data: { action: 'set', channel: 'POST', basis: 'NONE' },
    });
    expect(regrant.status()).toBe(400);
    expect((await regrant.json()).code).toBe('owner_objected');
    expect(await prisma.contactSuppression.count({ where: { orgId: org.id } })).toBeGreaterThan(0);

    // A new campaign through the form.
    await gotoSettled(page, '/admin/acquisition');
    await page.getByTestId('post-campaign-new').click();
    await page.getByTestId('post-campaign-name').fill(`Herbst ${stamp}`);
    await page.getByTestId('post-campaign-code').fill(code);
    await page.getByTestId('post-campaign-data-source').fill(dataSource);
    // The balancing note and the letter come pre-filled with the vertical's
    // built-in default — until the organization saves its own letter (#2927).
    const letter = page.getByTestId('post-campaign-letter');
    await expect(page.getByTestId('post-campaign-letter-source')).toHaveAttribute('data-source', 'builtin', { timeout: 20_000 });
    await expect(letter).toHaveValue(/\{company\}/);
    // The built-in MARKETING letter is a short generic text, not a tenant's own pitch.
    await expect(letter).toHaveValue(/unser Produkt/);
    const ownLetter = `{salutation}\n\nUnser eigener Brief ${stamp} an {company}.\n\n{link}\n\nMit freundlichen Grüßen`;
    await letter.fill(ownLetter);
    await page.getByTestId('post-campaign-letter-save-default').click();
    await expect(page.getByTestId('post-campaign-letter-source')).toHaveAttribute('data-source', 'org', { timeout: 20_000 });
    expect((await prisma.setting.findFirst({ where: { orgId: org.id, key: 'postLetterTemplate' } }))?.value).toBe(ownLetter);
    // The next form starts from the saved letter.
    expect((await (await page.request.get('/api/admin/post-campaigns')).json()).defaults).toMatchObject({ letterBody: ownLetter, letterSource: 'org' });
    await page.getByTestId('post-campaign-create').click();
    await page.waitForURL('**/admin/acquisition/*');
    const campaign = await prisma.postCampaign.findFirstOrThrow({ where: { orgId: org.id, code } });
    await expect(page.getByTestId('post-campaign-short-link')).toHaveText(new RegExp(`/b/${code}$`));

    // The picker shows all three, the two blocked ones with their reason and disabled.
    await page.getByTestId('post-campaign-search').fill(stamp);
    await expect(page.getByTestId(`post-campaign-candidate-${ok.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`post-campaign-reason-${noAddress.id}`)).toBeVisible();
    await expect(page.getByTestId(`post-campaign-candidate-${noAddress.id}`)).toHaveAttribute('data-ineligible', 'no_address');
    await expect(page.getByTestId(`post-campaign-candidate-${objecting.id}`)).toHaveAttribute('data-ineligible', 'objected');
    await expect(page.getByTestId(`post-campaign-candidate-${objecting.id}`).locator('input[type="checkbox"]')).toBeDisabled();

    // The server decides again: the API refuses the objected one whatever the UI did.
    const direct = await page.request.post(`/api/admin/post-campaigns/${campaign.id}/recipients`, {
      data: { companyIds: [objecting.id, noAddress.id] },
    });
    expect(direct.status()).toBe(200);
    const directBody = await direct.json();
    expect(directBody.added).toBe(0);
    expect(Object.fromEntries(directBody.refused.map((r: { companyId: string; reason: string }) => [r.companyId, r.reason]))).toEqual({
      [objecting.id]: 'objected',
      [noAddress.id]: 'no_address',
    });

    await page.getByTestId(`post-campaign-candidate-${ok.id}`).locator('input[type="checkbox"]').check();
    await page.getByTestId('post-campaign-add').click();
    await expect(page.getByTestId(`post-campaign-recipient-${ok.id}`)).toBeVisible({ timeout: 20_000 });

    // The print view: DIN address block and the Art. 14 notice with the data source.
    const print = await page.context().newPage();
    await print.goto(`/print/post-campaign/${campaign.id}`);
    await expect(print.getByTestId('post-letter-address-line')).toHaveText([ok.name, 'z. Hd. Eva Weber', 'Hauptstraße 1', '10115 Berlin']);
    await expect(print.getByTestId('post-letter-body').first()).toContainText('Guten Tag Eva Weber,');
    await expect(print.getByTestId('post-letter-body').first()).toContainText(`/b/${code}`);
    await expect(print.getByTestId('post-letter-body').first()).toContainText(`Unser eigener Brief ${stamp}`);
    await expect(print.getByText(dataSource)).toBeVisible();
    await expect(print.getByText('Widerspruchsrecht (Art. 21 Abs. 2 DSGVO):')).toBeVisible();
    await print.close();

    // Posted: locked for good.
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('post-campaign-mark-sent').click();
    await expect(page.getByTestId('post-campaign-locked')).toBeVisible({ timeout: 20_000 });
    const sent = await prisma.postCampaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id, companyId: ok.id } });
    expect(sent.sentAt).not.toBeNull();
    expect((await page.request.patch(`/api/admin/post-campaigns/${campaign.id}`, { data: { name: 'changed' } })).status()).toBe(409);
    expect((await page.request.delete(`/api/admin/post-campaigns/${campaign.id}`)).status()).toBe(409);
    expect((await page.request.post(`/api/admin/post-campaigns/${campaign.id}/send`)).status()).toBe(409);

    // The objection outlives the account: delete it, type it in again (same VAT).
    await prisma.contactPermission.deleteMany({ where: { companyId: objecting.id } });
    await prisma.company.delete({ where: { id: objecting.id } });
    const again = await prisma.company.create({
      data: { orgId: org.id, name: `Neu angelegt ${stamp}`, vatId: vat, address: 'Neue Straße 5, 80331 München', country: 'DE' },
    });
    const second = await page.request.post('/api/admin/post-campaigns', {
      data: { name: `Zweite ${stamp}`, dataSource, balancingNote: 'Berechtigtes Interesse an Direktwerbung, abgewogen.', letterBody: '{salutation}\n\nText {link}' },
    });
    expect(second.status()).toBe(201);
    const secondId = (await second.json()).id;
    const candidates = await (await page.request.get(`/api/admin/post-campaigns/${secondId}/candidates?q=${encodeURIComponent(stamp)}`)).json();
    const byId = Object.fromEntries(candidates.candidates.map((c: { id: string; ineligible: string | null }) => [c.id, c.ineligible]));
    expect(byId[again.id]).toBe('suppressed');
    // …and the account that just got a letter is in its 90-day cooldown.
    expect(byId[ok.id]).toBe('recently_mailed');

    // The short link: relative redirect to the demo form, attributed to the letter.
    const short = await page.request.get(`/b/${code}`, { maxRedirects: 0 });
    expect(short.status()).toBe(307);
    expect(short.headers()['location']).toBe(`/?utm_source=brief&utm_medium=post&utm_campaign=${code}#demo`);
    expect((await page.request.get('/b/NOT%20A%20CODE', { maxRedirects: 0 })).headers()['location']).toBe('/');

    // A demo request that came through it is counted in the results.
    await prisma.companyInquiry.create({
      data: { orgId: org.id, companyName: 'Antwort GmbH', contactName: 'A', email: uniqueEmail('antwort'), utmSource: 'brief', utmMedium: 'post', utmCampaign: code },
    });
    await gotoSettled(page, `/admin/acquisition/${campaign.id}`);
    await expect(page.getByTestId('post-campaign-inquiries')).toHaveText('1');

    // Back to the built-in letter: the org's row is emptied, the next form starts from the built-in one.
    const reset = await page.request.put('/api/admin/post-campaigns/letter-template', { data: { letterBody: '' } });
    expect(reset.status()).toBe(200);
    expect((await reset.json()).defaults.letterSource).toBe('builtin');
    // A letter too short to be one is refused.
    expect((await page.request.put('/api/admin/post-campaigns/letter-template', { data: { letterBody: 'zu kurz' } })).status()).toBe(400);

    // Not for anyone but an admin.
    await signInAsFreshUser(page, menteeEmail, PW, '/portal');
    expect((await page.request.get('/api/admin/post-campaigns')).status()).toBe(401);
    expect((await page.request.put('/api/admin/post-campaigns/letter-template', { data: { letterBody: '' } })).status()).toBe(401);
  } finally {
    await cleanupOrg(org.id, [adminEmail, menteeEmail]);
  }
});
