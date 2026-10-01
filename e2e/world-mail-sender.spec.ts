import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { __testable, sendEmail } from '@/services/emailService';
import { appOriginForOrg } from '@/lib/orgLinkOrigin';
import { prisma as appPrisma } from '@/lib/prisma';

// The sender side of "a mail stays in its recipient's world" (docs/worlds.md),
// against the real database: which From name a mail gets when its caller named
// none, and what happens when the recipient's world cannot be read.
//
// Called in THIS process, not over HTTP, for the reason given in
// e2e/email-central-enforcement.spec.ts: the app server runs with SMTP blanked,
// so no From header is ever built where a request could observe it.

const { recipientSenderName } = __testable;

const STAMP = `${Date.now()}-${Math.round(performance.now())}`;
const BRAND = `Acme Sales ${STAMP}`;
const PW = 'WorldSender123!';

let marketingOrgId = '';
let internshipOrgId = '';
const marketingEmail = uniqueEmail('world-sender-mkt');
const internshipEmail = uniqueEmail('world-sender-int');
let marketingUserId = '';
let internshipUserId = '';

test.beforeAll(async () => {
  const mkt = await prisma.organization.create({
    data: { name: `World Sender MKT ${STAMP}`, slug: `world-sender-mkt-${STAMP}`, vertical: 'MARKETING', brandName: BRAND },
  });
  const int = await prisma.organization.create({
    data: { name: `World Sender INT ${STAMP}`, slug: `world-sender-int-${STAMP}`, vertical: 'INTERNSHIP', brandName: `Intern Brand ${STAMP}` },
  });
  marketingOrgId = mkt.id;
  internshipOrgId = int.id;
  marketingUserId = (await seedUser(marketingEmail, PW, 'MENTEE', 'World Sender Lead', mkt.id)).id;
  internshipUserId = (await seedUser(internshipEmail, PW, 'MENTEE', 'World Sender Mentee', int.id)).id;
});

test.afterAll(async () => {
  await cleanupByEmail(marketingEmail);
  await cleanupByEmail(internshipEmail);
  await prisma.organization.deleteMany({ where: { id: { in: [marketingOrgId, internshipOrgId] } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

/**
 * Makes every Organization read of the app's client fail for the duration of
 * `run` — the database error the fail-loud paths exist for. Restored exactly,
 * so no later test inherits it.
 */
async function withOrgReadsFailing(run: () => Promise<void>) {
  const delegate = appPrisma.organization as unknown as Record<string, unknown>;
  const original = delegate.findUnique;
  delegate.findUnique = () => Promise.reject(new Error('simulated organization read failure'));
  try {
    await run();
  } finally {
    delegate.findUnique = original;
  }
}

test.describe('the From name a caller left unset', () => {
  test('a MARKETING recipient is named after their own org', async () => {
    expect(await recipientSenderName(undefined, marketingUserId)).toBe(BRAND);
    expect(await recipientSenderName(marketingOrgId, undefined)).toBe(BRAND);
  });

  test('the default world keeps the configured name — even a branded INTERNSHIP tenant', async () => {
    // null = "use MAIL_FROM_NAME", byte-for-byte what the default world always
    // got; the tenant's brandName above must NOT leak into the sender here.
    expect(await recipientSenderName(undefined, internshipUserId)).toBeNull();
    expect(await recipientSenderName(internshipOrgId, undefined)).toBeNull();
    // An explicit null org is the default org — an answer, not a lookup.
    expect(await recipientSenderName(null, marketingUserId)).toBeNull();
  });

  test('an org the preference read already learned is used without reading the user again', async () => {
    // The user id names nobody: a user read would find no row and answer null.
    const ghost = 'no-such-user-id';
    expect(await recipientSenderName(undefined, ghost, { orgId: marketingOrgId, vertical: 'MARKETING' })).toBe(BRAND);
    // And the known INTERNSHIP world wins over a MARKETING user id — nothing re-read it.
    expect(await recipientSenderName(undefined, marketingUserId, { orgId: internshipOrgId, vertical: 'INTERNSHIP' })).toBeNull();
  });

  test('a lookup that fails yields false — the caller sends from a bare address', async () => {
    await withOrgReadsFailing(async () => {
      expect(await recipientSenderName(marketingOrgId, undefined)).toBe(false);
    });
  });
});

test.describe('a recipient world that cannot be read', () => {
  test('appOriginForOrg throws instead of answering the internship origin', async () => {
    await withOrgReadsFailing(async () => {
      await expect(appOriginForOrg(marketingOrgId)).rejects.toThrow('simulated organization read failure');
    });
    // The control: with the read working it answers, so the throw above is the failure's.
    await expect(appOriginForOrg(marketingOrgId)).resolves.toMatch(/^https?:\/\//);
  });

  test('gated mail is not sent from the wrong host: the send throws and the log says FAILED', async () => {
    // SMTP must look configured, or sendEmail stops at "SMTP not configured"
    // before the footer origin is resolved. Nothing can go out: the origin read
    // throws first, and the address is on a reserved, unroutable TLD.
    const saved = process.env.SMTP_USER;
    process.env.SMTP_USER = 'world-sender-test';
    const to = `world-sender-${STAMP}@example.invalid`;
    const subject = `World sender origin ${STAMP}`;
    try {
      await withOrgReadsFailing(async () => {
        await expect(
          sendEmail({
            to,
            subject,
            html: '<p>announcement</p>',
            category: 'announcement',
            userId: marketingUserId,
            orgId: marketingOrgId,
          }),
        ).rejects.toThrow('simulated organization read failure');
      });
      const row = await prisma.emailLog.findFirst({ where: { to, subject }, orderBy: { createdAt: 'desc' } });
      expect(row?.status).toBe('FAILED');
      expect(row?.error).toContain('Recipient origin unresolved');
    } finally {
      if (saved === undefined) delete process.env.SMTP_USER;
      else process.env.SMTP_USER = saved;
      await prisma.emailLog.deleteMany({ where: { to } });
    }
  });
});
