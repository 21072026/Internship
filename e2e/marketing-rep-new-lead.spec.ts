import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { SALES_LEAD_CREATE, SALES_LEAD_CREATE_PATH, type SalesLeadCaller } from './fixtures/authz-matrix';
// Static import, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// A sales rep types in their own lead (#2958) — POST /api/sales/leads, the
// rep's door into the admin form's create-only writer (#2562).
//
// What this spec pins:
//   1. who may use it (the probe table in e2e/fixtures/authz-matrix.ts), and
//      that whoever may is ALWAYS the owner, in their own org — a colleague's
//      `ownerId` or another org's `orgId` in the body changes nothing;
//   2. the admin path's dedupe answers the rep too (same VAT, same contact,
//      staff address), without handing out the id of a colleague's record;
//   3. creating a lead mails nobody, and the activity log names the rep;
//   4. the form on /sales places the lead on the rep's own board.

test.describe.configure({ mode: 'serial' });

const PW = 'RepOwnLead123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

const orgIds: string[] = [];
const emails: string[] = [];
const ids: Record<string, string> = {};
const callerEmail: Partial<Record<SalesLeadCaller, string>> = {};

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Rep Lead ${label} ${STAMP}`, slug: `rep-lead-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId: org.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  return org.id;
}

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY', orgId: string, extra: { companyId?: string } = {}) {
  const email = uniqueEmail(`rep-lead-${label}-${STAMP}`);
  emails.push(email);
  const user = await seedUser(email, PW, role, `Rep Lead ${label} ${STAMP}`, orgId);
  if (extra.companyId) await prisma.user.update({ where: { id: user.id }, data: { companyId: extra.companyId } });
  return { id: user.id, email };
}

let n = 0;
/** A fresh, synthetic lead body. */
function lead(overrides: Record<string, unknown> = {}) {
  n += 1;
  return {
    name: `Acme Sales ${n} ${STAMP}`,
    country: 'DE',
    vatId: `DE${String(100000000 + Math.floor(Math.random() * 899999999))}`,
    contactName: `Casey Contact ${n}`,
    contactEmail: `casey-${n}-${STAMP}@acme.example.test`,
    ...overrides,
  };
}

/** An API-only session for `email`, on the marketing host when `marketing`. */
async function jar(
  playwright: { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } },
  baseURL: string | undefined,
  email: string | null,
  marketing: boolean,
) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: marketing ? asHost(MARKETING_HOST) : {} });
  if (email) {
    const res = await signInViaApi(ctx, email, PW, { ...(marketing ? { host: MARKETING_HOST } : {}), headers: freshIp(`rep-lead-${email}`) });
    expect(res.error, `sign-in ${email}`).toBeNull();
  }
  return ctx;
}

/** Mail jobs queued for this address since `since` (the queue stores only its hash). */
async function mailJobsFor(address: string, since: Date) {
  const rcpt = crypto.createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
  const rows = await prisma.job.findMany({ where: { name: 'email.send', createdAt: { gte: since } }, select: { payload: true } });
  return rows.filter((r) => (r.payload as { rcpt?: string } | null)?.rcpt === rcpt).length;
}

test.beforeAll(async () => {
  const orgA = await marketingOrg('a');
  const orgB = await marketingOrg('b');
  const internship = await prisma.organization.create({
    data: { name: `Rep Lead INT ${STAMP}`, slug: `rep-lead-int-${STAMP}`, vertical: 'INTERNSHIP' },
  });
  orgIds.push(internship.id);
  ids.orgA = orgA;
  ids.orgB = orgB;

  const rep = await person('rep', 'MENTOR', orgA);
  const colleague = await person('colleague', 'MENTOR', orgA);
  const foreignRep = await person('foreign', 'MENTOR', orgB);
  const admin = await person('admin', 'ADMIN', orgA);
  const mentee = await person('mentee', 'MENTEE', orgA);
  const account = await prisma.company.create({ data: { orgId: orgA, name: `Login Co ${STAMP}` } });
  ids.loginCompany = account.id;
  const companyLogin = await person('company', 'COMPANY', orgA, { companyId: account.id });
  const intMentor = await person('int-mentor', 'MENTOR', internship.id);
  const intAdmin = await person('int-admin', 'ADMIN', internship.id);

  Object.assign(ids, { rep: rep.id, colleague: colleague.id, foreignRep: foreignRep.id, admin: admin.id });
  Object.assign(callerEmail, {
    marketingMentor: rep.email,
    marketingAdmin: admin.email,
    marketingMentee: mentee.email,
    marketingCompany: companyLogin.email,
    internshipMentor: intMentor.email,
    internshipAdmin: intAdmin.email,
  });
  ids.repEmail = rep.email;
  ids.colleagueEmail = colleague.email;
  ids.foreignRepEmail = foreignRep.email;
});

test.afterAll(async () => {
  const companies = await prisma.company.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const leads = await prisma.user.findMany({
    where: { orgId: { in: orgIds }, OR: [{ companyId: { in: companyIds } }, { menteeRelations: { some: {} } }] },
    select: { id: true },
  }).catch(() => [] as Array<{ id: string }>);
  await prisma.statusChange.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.user.updateMany({ where: { orgId: { in: orgIds } }, data: { companyId: null } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.contactPermission.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { targetId: { in: companyIds } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.source.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('who may create their own lead, and that it is always theirs, in their own org', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.slow();
  for (const probe of SALES_LEAD_CREATE) {
    const email = probe.caller === 'anonymous' ? null : callerEmail[probe.caller]!;
    const marketing = probe.caller.startsWith('marketing');
    const ctx = await jar(playwright, baseURL, email, marketing);
    try {
      const body = lead();
      const since = new Date(Date.now() - 1000);
      // A colleague as owner and another org as the target: both must be ignored.
      const res = await ctx.post(SALES_LEAD_CREATE_PATH, { data: { ...body, ownerId: ids.colleague, orgId: ids.orgB } });
      const label = `${probe.caller} (${probe.why}) → ${res.status()}`;
      expect(res.status(), label).toBe(probe.expect);
      const json = await res.json().catch(() => ({}));
      if (probe.code) expect(json.code, label).toBe(probe.code);

      const company = await prisma.company.findFirst({ where: { name: body.name } });
      if (probe.expect !== 201) {
        expect(company, `${label}: nothing written`).toBeNull();
        continue;
      }
      const selfId = probe.caller === 'marketingAdmin' ? ids.admin : ids.rep;
      expect(company?.orgId, label).toBe(ids.orgA);
      const relation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: company!.id } });
      expect(relation.mentorId, `${label}: the caller owns it`).toBe(selfId);
      expect(relation.orgId).toBe(ids.orgA);
      expect(json.relationId).toBe(relation.id);
      expect(json.ownerId).toBe(selfId);
      // The activity log names the caller, as a hand-typed (manual) lead.
      const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'marketing.account.created', targetId: company!.id } });
      expect(log.actorId).toBe(selfId);
      expect(log.detail ?? '').toMatch(/^manual /);
      // No mail to the contact address, nor to the lead's stand-in.
      const leadUser = await prisma.user.findUniqueOrThrow({ where: { id: relation.menteeId }, select: { email: true } });
      expect(await mailJobsFor(body.contactEmail, since)).toBe(0);
      expect(await mailJobsFor(leadUser.email, since)).toBe(0);
    } finally {
      await ctx.dispose();
    }
  }
  // Nothing at all landed in the other org through those bodies.
  expect(await prisma.company.count({ where: { orgId: ids.orgB } })).toBe(0);
  expect(await prisma.mentorshipRelation.count({ where: { mentorId: ids.colleague } })).toBe(0);
});

test("duplicates are refused with the admin path's rules, without pointing at a colleague's record", { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.slow();
  const rep = await jar(playwright, baseURL, ids.repEmail, true);
  const colleague = await jar(playwright, baseURL, ids.colleagueEmail, true);
  const foreign = await jar(playwright, baseURL, ids.foreignRepEmail, true);
  try {
    // The colleague's account and lead.
    const theirs = lead();
    expect((await colleague.post(SALES_LEAD_CREATE_PATH, { data: theirs })).status()).toBe(201);
    const theirCompany = await prisma.company.findFirstOrThrow({ where: { orgId: ids.orgA, name: theirs.name } });

    // Same VAT id, another name: "already exists", and no id of the colleague's.
    const sameVat = await rep.post(SALES_LEAD_CREATE_PATH, { data: lead({ vatId: theirs.vatId }) });
    expect(sameVat.status()).toBe(409);
    const sameVatBody = await sameVat.json();
    expect(sameVatBody).toEqual({ code: 'account_exists', mine: false });
    expect(JSON.stringify(sameVatBody)).not.toContain(theirCompany.id);

    // Same contact on another account: already on the board, again no id.
    const sameContact = await rep.post(SALES_LEAD_CREATE_PATH, { data: lead({ contactEmail: theirs.contactEmail }) });
    expect(sameContact.status()).toBe(409);
    const sameContactBody = await sameContact.json();
    expect(['contact_in_funnel', 'already_mentored']).toContain(sameContactBody.code);
    expect(sameContactBody.relationId).toBeUndefined();
    expect(sameContactBody.leadId).toBeUndefined();

    // A team member's address is never a lead.
    const staff = await rep.post(SALES_LEAD_CREATE_PATH, { data: lead({ contactEmail: ids.colleagueEmail.toUpperCase() }) });
    expect(staff.status()).toBe(409);
    expect((await staff.json()).code).toBe('contact_is_user');

    // The rep's own duplicate does come back with the way to it.
    const mine = lead();
    const first = await rep.post(SALES_LEAD_CREATE_PATH, { data: mine });
    expect(first.status()).toBe(201);
    const again = await rep.post(SALES_LEAD_CREATE_PATH, { data: { ...mine, name: `${mine.name} Renamed` } });
    expect(again.status()).toBe(409);
    const myCompany = await prisma.company.findFirstOrThrow({ where: { orgId: ids.orgA, name: mine.name } });
    expect(await again.json()).toEqual({ code: 'account_exists', mine: true, companyId: myCompany.id });

    // Exactly one account per VAT id in the org; the colleague's book untouched.
    expect(await prisma.company.count({ where: { orgId: ids.orgA, vatId: theirs.vatId } })).toBe(1);
    expect(await prisma.mentorshipRelation.count({ where: { companyId: theirCompany.id } })).toBe(1);

    // Another org's rep, the same VAT id: a separate tenant, so a new account
    // there — the match key never reaches across the boundary.
    const elsewhere = await foreign.post(SALES_LEAD_CREATE_PATH, { data: lead({ vatId: theirs.vatId }) });
    expect(elsewhere.status()).toBe(201);
    const foreignCompany = await prisma.company.findFirstOrThrow({ where: { orgId: ids.orgB, vatId: theirs.vatId } });
    const foreignRelation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: foreignCompany.id } });
    expect(foreignRelation.mentorId).toBe(ids.foreignRep);
    expect(foreignRelation.orgId).toBe(ids.orgB);
  } finally {
    await rep.dispose();
    await colleague.dispose();
    await foreign.dispose();
  }
});

test('the rep creates a lead from the /sales form and finds it on their own pages', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, ids.repEmail, PW, '/sales');

  const body = lead();
  await page.getByTestId('new-lead-button').click();
  const dialog = page.getByTestId('new-lead-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('new-lead-owner-hint')).toBeVisible();
  await dialog.locator('#new-lead-name').fill(body.name);
  await dialog.locator('#new-lead-country').fill(body.country);
  await dialog.locator('#new-lead-vat').fill(body.vatId);
  await dialog.locator('#new-lead-contact-name').fill(body.contactName);
  await dialog.locator('#new-lead-contact-email').fill(body.contactEmail);
  await dialog.getByTestId('new-lead-submit').click();
  await expect(dialog.getByTestId('new-lead-created')).toBeVisible({ timeout: 20_000 });

  const company = await prisma.company.findFirstOrThrow({ where: { orgId: ids.orgA, name: body.name } });
  const relation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: company.id } });
  expect(relation.mentorId).toBe(ids.rep);
  await expect(dialog.getByTestId('new-lead-open-lead')).toHaveAttribute('href', `/sales/leads/${relation.id}`);

  // The dashboard behind the dialog was refreshed with the new record.
  await page.getByRole('button', { name: /cancel/i }).click();
  await expect(page.getByTestId('sales-records')).toContainText(body.contactName, { timeout: 20_000 });

  await gotoSettled(page, '/sales/accounts');
  await expect(page.getByTestId('sales-accounts-table')).toContainText(body.name);
  await gotoSettled(page, `/sales/leads/${relation.id}`);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(body.contactName);
});
