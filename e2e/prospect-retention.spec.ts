import crypto from 'crypto';
import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

// Prospect retention (MKT-4): the accounts past the 24 months every letter
// promises are LISTED for an admin, and their contact data is erased only by
// that admin's click — the Company row stays, the letter snapshots keep
// nothing of the person, and the account leaves the list.
//
// Not listed: a recently contacted prospect, an old customer (ever signed), an
// old prospect with a confirmed double opt-in, and another org's prospect.
// Another org's id on the erase route is a 404 and writes nothing.
//
// Synthetic data only; untagged (feature spec, the scheduled suite runs it).

const PW = 'ProspectRetention123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 3 * 365 * DAY);
const RECENT = new Date(Date.now() - 30 * DAY);

const emails: string[] = [];
const orgIds: string[] = [];

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Prospect ${label} ${STAMP}`, slug: `prospect-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  return org.id;
}

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) {
  const email = uniqueEmail(`prospect-${label}-${STAMP}`).toLowerCase();
  emails.push(email);
  const user = await seedUser(email, PW, role, `Prospect ${label}`, orgId);
  return user;
}

/** An account with a lead row and a funnel record whose last interaction was `at`. */
async function account(orgId: string, ownerId: string, label: string, at: Date, stage = 'NEW_LEAD') {
  const company = await prisma.company.create({
    data: {
      orgId,
      name: `Acme ${label} ${STAMP}`,
      contactName: `Casey ${label}`,
      contactEmail: `casey.${label}.${STAMP}@acme.example`,
      contactPhone: '+49 30 0000000',
      contactPosition: 'Owner',
    },
  });
  const lead = await person(`lead-${label}`, 'MENTEE', orgId);
  await prisma.user.update({ where: { id: lead.id }, data: { companyId: company.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: lead.id, companyId: company.id, pipelineStatus: stage },
  });
  await prisma.interactionLog.create({ data: { relationId: relation.id, type: 'Call', date: at, notes: 'synthetic' } });
  return company;
}

test.afterAll(async () => {
  await prisma.postCampaign.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.companyInquiry.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.contactPermission.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.companyContact.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('an old prospect is listed and erased by hand; fresh, customer, DOI and foreign accounts are not', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const orgA = await marketingOrg('a');
  const orgB = await marketingOrg('b');
  const admin = await person('admin', 'ADMIN', orgA);
  await prisma.user.update({ where: { id: admin.id }, data: { adminLevel: 'ORG_ADMIN' } });
  const rep = await person('rep', 'MENTOR', orgA);
  const repB = await person('rep-b', 'MENTOR', orgB);

  const old = await account(orgA, rep.id, 'old', OLD);
  const fresh = await account(orgA, rep.id, 'fresh', RECENT);
  const customer = await account(orgA, rep.id, 'customer', OLD, 'DEAL_LOST');
  const customerRelation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: customer.id } });
  await prisma.statusChange.create({
    data: { relationId: customerRelation.id, fromStatus: 'TRIAL_ACTIVE', toStatus: 'DEAL_WON', createdAt: OLD },
  });
  const doi = await account(orgA, rep.id, 'doi', OLD);
  await prisma.contactPermission.create({
    data: {
      orgId: orgA, companyId: doi.id, channel: 'EMAIL', basis: 'DOI_CONFIRMED', source: 'DOI_LINK',
      address: doi.contactEmail, requestedAt: OLD, confirmedAt: OLD,
    },
  });
  const foreign = await account(orgB, repB.id, 'foreign', OLD);

  // The old prospect's other traces: the enquiry it came through and a letter.
  const inquiry = await prisma.companyInquiry.create({
    data: {
      orgId: orgA, companyName: old.name, contactName: 'Casey old', email: old.contactEmail!,
      phone: '+49 30 1111111', message: 'synthetic', note: 'synthetic note',
      convertedCompanyId: old.id, convertedAt: OLD, createdAt: OLD,
    },
  });
  const campaign = await prisma.postCampaign.create({
    data: {
      orgId: orgA, name: `Spring ${STAMP}`, dataSource: 'synthetic', balancingNote: 'synthetic',
      letterBody: 'synthetic', code: `spring-${STAMP}`.toLowerCase().slice(0, 60), status: 'SENT', sentAt: OLD,
    },
  });
  const letter = await prisma.postCampaignRecipient.create({
    data: {
      orgId: orgA, campaignId: campaign.id, companyId: old.id, recipientName: 'Casey old',
      addressBlock: 'Casey old\nExample Street 1\n10115 Berlin', sentAt: OLD,
    },
  });

  const ctx: APIRequestContext = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  expect((await signInViaApi(ctx, admin.email, PW, { host: MARKETING_HOST })).ok).toBe(true);

  // --- the list: only the old prospect, name + date only ---
  const listRes = await ctx.get('/api/admin/retention/prospects');
  expect(listRes.status()).toBe(200);
  const list = (await listRes.json()) as { applies: boolean; total: number; items: { id: string; name: string; lastContactAt: string }[] };
  expect(list.applies).toBe(true);
  const ids = list.items.map((r) => r.id);
  expect(ids).toContain(old.id);
  for (const notListed of [fresh.id, customer.id, doi.id, foreign.id]) expect(ids).not.toContain(notListed);
  const row = list.items.find((r) => r.id === old.id)!;
  expect(Object.keys(row).sort()).toEqual(['id', 'lastContactAt', 'name']);
  expect(row.name).toBe(old.name);

  // --- another org's id: 404, nothing written ---
  expect((await ctx.post(`/api/admin/retention/prospects/${foreign.id}/erase`)).status()).toBe(404);
  expect((await prisma.company.findUniqueOrThrow({ where: { id: foreign.id } })).contactEmail).toBe(foreign.contactEmail);
  // A customer of this org cannot be pointed at by id either.
  const refused = await ctx.post(`/api/admin/retention/prospects/${customer.id}/erase`);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).reason).toBe('customer');
  expect((await prisma.company.findUniqueOrThrow({ where: { id: customer.id } })).contactName).toBe('Casey customer');

  // --- the page: the row is there, and the click erases it ---
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, admin.email, PW, '/admin');
  await gotoSettled(page, '/admin/retention');
  const panel = page.getByTestId('prospect-retention');
  await expect(panel.getByTestId(`prospect-retention-row-${old.id}`)).toBeVisible();
  await expect(panel.getByTestId(`prospect-retention-row-${fresh.id}`)).toHaveCount(0);
  page.once('dialog', (d) => void d.accept());
  await panel.getByTestId(`prospect-retention-erase-${old.id}`).click();
  await expect(panel.getByTestId(`prospect-retention-row-${old.id}`)).toHaveCount(0);

  // --- what the erasure did ---
  const after = await prisma.company.findUnique({ where: { id: old.id } });
  expect(after, 'the Company row stays').not.toBeNull();
  expect(after!.name).toBe(old.name);
  expect([after!.contactEmail, after!.contactName, after!.contactPhone, after!.contactPosition]).toEqual([null, null, null, null]);
  const inq = await prisma.companyInquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
  expect(inq.contactName).not.toBe('Casey old');
  expect(inq.email).not.toBe(old.contactEmail);
  expect([inq.phone, inq.message, inq.note]).toEqual([null, null, null]);
  const snap = await prisma.postCampaignRecipient.findUniqueOrThrow({ where: { id: letter.id } });
  expect(snap.recipientName).toBeNull();
  expect(snap.addressBlock).toBe('[erased]');
  expect(snap.sentAt?.getTime()).toBe(OLD.getTime());
  const audit = await prisma.auditLog.findFirst({ where: { orgId: orgA, action: 'prospect.contact_erased', targetId: old.id } });
  expect(audit?.actorId).toBe(admin.id);

  // The other accounts are untouched.
  expect((await prisma.company.findUniqueOrThrow({ where: { id: fresh.id } })).contactEmail).toBe(fresh.contactEmail);
  expect((await prisma.company.findUniqueOrThrow({ where: { id: doi.id } })).contactEmail).toBe(doi.contactEmail);

  // And the account is off the list for good.
  const again = (await (await ctx.get('/api/admin/retention/prospects')).json()) as { items: { id: string }[] };
  expect(again.items.map((r) => r.id)).not.toContain(old.id);
  expect((await ctx.post(`/api/admin/retention/prospects/${old.id}/erase`)).status()).toBe(409);
  await ctx.dispose();
});
