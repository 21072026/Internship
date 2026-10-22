import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
// Static imports, not `await import()` inside a test: Playwright resolves the
// `@/…` path alias when it transforms the spec's import graph (see
// e2e/erasure-company-contact.spec.ts).
import { anonymizeUser, hardDeleteUser } from '../src/lib/accountErasure';
import { createMarketingAccountsBatch, resolveImportOwner } from '../src/lib/marketingImportStore';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { profileEmailHash } from '../src/lib/externalProfileErasure';

/**
 * Erasing a lead that lives on a generated stand-in address clears the REAL
 * person on its account (#3136).
 *
 * The marketing import, the account events and the pull connector create the
 * lead `User` on `…@import.local` and put the merchant's real name, mailbox and
 * line on `Company.contact*`. The account-side scrub used to match on the lead's
 * own address only, so erasing the lead left every bit of the real identity on
 * the account. What this pins, through the import's own writer:
 *
 *   1. anonymise AND hard delete each clear the contact columns of the account
 *      the lead was imported onto (and tombstone a connector link that knows
 *      the real address — the #2986 behaviour, now reached for a stand-in lead);
 *   2. an account the lead is LINKED to whose contact is someone else is left
 *      exactly as it was — being linked is never enough;
 *   3. another lead's account in the same tenant is untouched.
 *
 * `@smoke`: a privacy boundary (CLAUDE.md — the security guards are in the
 * smoke set). The decision rule itself is unit-tested in
 * scripts/test/company-contact-erasure.test.mjs.
 */

test.describe.configure({ mode: 'serial' });

const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const repEmail = uniqueEmail(`sil-rep-${STAMP}`);
const contact = (who: string) => `sil-${who}-${STAMP}@example.com`;

let orgId = '';
const accounts: Record<string, { companyId: string; leadId: string }> = {};

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Stand-in Erasure ${STAMP}`, slug: `stand-in-erasure-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING')!;
  const stages = templateStagePayload(preset).stages;
  await prisma.pipelineStage.createMany({ data: stages.map((s) => ({ ...s, orgId })) });
  const first = [...stages].sort((a, b) => a.order - b.order)[0].key;
  await seedUser(repEmail, 'StandIn123!', 'MENTOR', `SIL Rep ${STAMP}`, orgId);

  // The import's own writer (the batch entry the pull connector uses; the
  // file import is the same planner and writer behind an org lease).
  const row = (who: string, contactName: string) => ({
    name: `SIL ${who} ${STAMP}`,
    country: 'DE',
    city: 'Kiel',
    stage: first,
    contactName,
    contactEmail: contact(who),
    contactPhone: `+49 431 ${who.length}000`,
  });
  const report = await createMarketingAccountsBatch({
    owner: await resolveImportOwner(repEmail),
    rows: [row('anon', 'Ida Anon'), row('hard', 'Hans Hard'), row('keep', 'Kim Keep')],
  });
  expect(report.counts.CREATE, JSON.stringify(report.rows)).toBe(3);

  for (const who of ['anon', 'hard', 'keep']) {
    const company = await prisma.company.findFirstOrThrow({ where: { orgId, name: `SIL ${who} ${STAMP}` } });
    const relation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: company.id } });
    accounts[who] = { companyId: company.id, leadId: relation.menteeId };
  }
});

test.afterAll(async () => {
  await prisma.externalProfileLink.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await cleanupByEmail(repEmail);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

async function expectContactCleared(companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  expect(company, 'the account itself stays').not.toBeNull();
  expect(company).toMatchObject({ contactEmail: null, contactName: null, contactPhone: null, contactPosition: null });
}

async function expectContact(companyId: string, email: string, name: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  expect(company?.contactEmail).toBe(email);
  expect(company?.contactName).toBe(name);
  expect(company?.contactPhone).not.toBeNull();
}

test('the imported lead carries a stand-in, and the real contact is on its account', { tag: '@smoke' }, async () => {
  const lead = await prisma.user.findUniqueOrThrow({ where: { id: accounts.anon.leadId } });
  expect(lead.email.endsWith('@import.local')).toBe(true);
  await expectContact(accounts.anon.companyId, contact('anon'), 'Ida Anon');
});

test('anonymising a stand-in lead clears its account contact, never another person’s', { tag: '@smoke' }, async () => {
  const { leadId, companyId } = accounts.anon;
  // An account the lead is linked to (its own companyId) whose contact is
  // SOMEONE ELSE: the relation still points at the imported account.
  const elsewhere = await prisma.company.create({
    data: {
      orgId,
      name: `SIL elsewhere ${STAMP}`,
      contactEmail: contact('other'),
      contactName: 'Otto Other',
      contactPhone: '+49 431 1',
    },
  });
  await prisma.user.update({ where: { id: leadId }, data: { companyId: elsewhere.id } });
  // A connector link that knows the real address but not the lead.
  const link = await prisma.externalProfileLink.create({
    data: {
      orgId,
      provider: 'test',
      externalId: `sil-${STAMP}`,
      companyId,
      emailHash: profileEmailHash(contact('anon')),
    },
  });

  await anonymizeUser(leadId);

  await expectContactCleared(companyId);
  await expectContact(elsewhere.id, contact('other'), 'Otto Other');
  await expectContact(accounts.keep.companyId, contact('keep'), 'Kim Keep');
  const tomb = await prisma.externalProfileLink.findUniqueOrThrow({ where: { id: link.id } });
  expect(tomb.erasedAt).not.toBeNull();
  expect(tomb.emailHash).toBeNull();
  expect(tomb.companyId).toBeNull();
});

test('hard-deleting a stand-in lead clears its account contact too', { tag: '@smoke' }, async () => {
  const { leadId, companyId } = accounts.hard;
  await hardDeleteUser(leadId);
  expect(await prisma.user.findUnique({ where: { id: leadId } })).toBeNull();
  await expectContactCleared(companyId);
  await expectContact(accounts.keep.companyId, contact('keep'), 'Kim Keep');
});
