import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { anonymizeUser, hardDeleteUser } from '../src/lib/accountErasure';
import { writeContactPermission } from '../src/lib/contactPermission';
import { runRetentionPrune } from '../src/lib/retentionEntries';
import { defaultOrgId } from '../src/lib/defaultOrg';

/**
 * The two records an erasure KEEPS, and the clock that ends them (#2098).
 *
 *   ContactPermission (UWG § 7 proof)       — 3 years after the end of the erasure's year
 *   AffiliatePartner.payoutDetailsCipher    — 10 years after the end of the year the
 *                                             relationship ended (erasure, termination,
 *                                             last payout — whichever is last)
 *
 * The erasure must START the clock (stamp) and leave the record alone; the
 * nightly sweep must end it only once the period is over. Every date the rule
 * decides is pinned by scripts/test/erasure-retention.test.mjs; this spec proves
 * the stamps are written by both erasure paths and that the sweep's queries
 * take the expired rows and nothing else.
 *
 * Not `@smoke`: erasure and retention are not runtime-critical paths.
 */

const YEAR = 365 * 24 * 60 * 60 * 1000;
const longAgo = () => new Date(Date.now() - 12 * YEAR);

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedCompany(orgId: string, contactEmail: string | null) {
  return prisma.company.create({
    data: { orgId, name: `Retained Co ${crypto.randomBytes(3).toString('hex')}`, contactEmail, contactName: 'Retained Person' },
  });
}

test('an erased contact’s UWG § 7 proof is kept, then deleted three years after the erasure year', async () => {
  const orgId = await defaultOrgId();
  const email = uniqueEmail('erase-proof');
  const person = await seedUser(email, 'x', 'MENTEE', 'Retained Person', orgId);
  const company = await seedCompany(orgId, email);
  const other = await seedCompany(orgId, uniqueEmail('erase-proof-other'));
  try {
    const proof = await prisma.contactPermission.create({
      data: {
        orgId, companyId: company.id, channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3', source: 'ADMIN',
        address: email, reason: 'Bought the annual plan in 2025',
      },
    });
    const phone = await prisma.contactPermission.create({
      data: { orgId, companyId: company.id, channel: 'PHONE', basis: 'NONE', source: 'ADMIN', reason: 'phone proof' },
    });
    const notTheirs = await prisma.contactPermission.create({
      data: { orgId, companyId: other.id, channel: 'POST', basis: 'NONE', source: 'ADMIN' },
    });

    await anonymizeUser(person.id);

    // Kept, with its proof — and the clock started, on both of their rows only.
    const kept = await prisma.contactPermission.findUnique({ where: { id: proof.id } });
    expect(kept?.reason).toBe('Bought the annual plan in 2025');
    expect(kept?.subjectErasedAt).not.toBeNull();
    expect((await prisma.contactPermission.findUnique({ where: { id: phone.id } }))?.subjectErasedAt).not.toBeNull();
    expect((await prisma.contactPermission.findUnique({ where: { id: notTheirs.id } }))?.subjectErasedAt).toBeNull();

    // A second erasure run does not restart the clock.
    const first = kept!.subjectErasedAt!;
    await anonymizeUser(person.id);
    expect((await prisma.contactPermission.findUnique({ where: { id: proof.id } }))?.subjectErasedAt?.getTime()).toBe(first.getTime());

    // Inside the period: the sweep leaves it.
    await runRetentionPrune();
    expect(await prisma.contactPermission.findUnique({ where: { id: proof.id } })).not.toBeNull();

    // A new basis written for a company is a new proof about whoever the
    // contact is now — an erased person's clock does not carry over to it.
    const reused = await prisma.contactPermission.create({
      data: {
        orgId, companyId: other.id, channel: 'EMAIL', basis: 'NONE', source: 'ADMIN',
        address: 'erased-earlier@example.test', subjectErasedAt: longAgo(),
      },
    });
    await writeContactPermission({
      writer: 'admin', orgId, companyId: other.id, channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3',
      address: 'new-contact@example.test', reason: 'new contact, new proof',
    });
    expect((await prisma.contactPermission.findUnique({ where: { id: reused.id } }))?.subjectErasedAt).toBeNull();

    // Past the period: the whole row goes — a basis without its proof would
    // still read as a permission.
    await prisma.contactPermission.update({ where: { id: proof.id }, data: { subjectErasedAt: longAgo() } });
    await runRetentionPrune();
    expect(await prisma.contactPermission.findUnique({ where: { id: proof.id } })).toBeNull();
    expect(await prisma.contactPermission.findUnique({ where: { id: phone.id } })).not.toBeNull();
    expect(await prisma.contactPermission.findUnique({ where: { id: notTheirs.id } })).not.toBeNull();
  } finally {
    await prisma.company.deleteMany({ where: { id: { in: [company.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: person.id } });
  }
});

test('an erased affiliate partner’s payout details are kept, then cleared ten years after the relationship ended', async () => {
  const orgId = await defaultOrgId();
  const suffix = crypto.randomBytes(4).toString('hex');
  const anonymised = await seedUser(uniqueEmail('erase-aff-a'), 'x', 'AFFILIATE', 'Affiliate A', orgId);
  const deleted = await seedUser(uniqueEmail('erase-aff-d'), 'x', 'AFFILIATE', 'Affiliate D', orgId);
  const partner = (userId: string, code: string) =>
    prisma.affiliatePartner.create({
      data: { orgId, userId, code: `${code}-${suffix}`, displayName: code, payoutDetailsCipher: `sealed-${code}` },
    });
  const a = await partner(anonymised.id, 'ret-a');
  const d = await partner(deleted.id, 'ret-d');
  try {
    await anonymizeUser(anonymised.id);
    await hardDeleteUser(deleted.id);

    // Both erasure paths start the clock and keep the details. The hard delete
    // stamps before the user row goes and SetNulls the link.
    for (const id of [a.id, d.id]) {
      const row = await prisma.affiliatePartner.findUnique({ where: { id } });
      expect(row?.accountErasedAt).not.toBeNull();
      expect(row?.payoutDetailsCipher).toMatch(/^sealed-/);
    }
    expect((await prisma.affiliatePartner.findUnique({ where: { id: d.id } }))?.userId).toBeNull();

    // Erased long ago — but A was paid recently, so A's period has not even
    // started running out; D's has.
    await prisma.affiliatePartner.updateMany({ where: { id: { in: [a.id, d.id] } }, data: { accountErasedAt: longAgo() } });
    const payout = await prisma.affiliatePayout.create({
      data: { orgId, partnerId: a.id, amountMinor: 1234, currency: 'XTS', paidAt: new Date() },
    });
    await runRetentionPrune();
    expect((await prisma.affiliatePartner.findUnique({ where: { id: a.id } }))?.payoutDetailsCipher).toBe('sealed-ret-a');
    const cleared = await prisma.affiliatePartner.findUnique({ where: { id: d.id } });
    // The partner row stays (its payouts are the bookings); only the IBAN goes.
    expect(cleared).not.toBeNull();
    expect(cleared?.payoutDetailsCipher).toBeNull();

    // A termination taking effect recently holds it just the same.
    await prisma.affiliatePayout.update({ where: { id: payout.id }, data: { paidAt: longAgo() } });
    await prisma.affiliatePartner.update({ where: { id: a.id }, data: { noticeEffectiveAt: new Date() } });
    await runRetentionPrune();
    expect((await prisma.affiliatePartner.findUnique({ where: { id: a.id } }))?.payoutDetailsCipher).toBe('sealed-ret-a');

    // Every end of the relationship in the past: cleared.
    await prisma.affiliatePartner.update({ where: { id: a.id }, data: { noticeEffectiveAt: longAgo() } });
    await runRetentionPrune();
    expect((await prisma.affiliatePartner.findUnique({ where: { id: a.id } }))?.payoutDetailsCipher).toBeNull();
  } finally {
    await prisma.affiliatePayout.deleteMany({ where: { partnerId: { in: [a.id, d.id] } } });
    await prisma.affiliatePartner.deleteMany({ where: { id: { in: [a.id, d.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [anonymised.id, deleted.id] } } });
  }
});
