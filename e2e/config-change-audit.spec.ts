import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { testCertificate } from './support/x509.mjs';

// An SSO change leaves a redacted before/after diff (#1699): the PATCH raises
// `org.config.changed`, the job worker delivers it to the config-audit
// subscriber, and the subscriber writes the AuditLog row the tenant's audit
// drain reads. The issuer is there with both values; the certificate is there
// only as "changed", with fingerprints — never itself.

const PASSWORD = 'ConfigAuditPass123!';
const emails: string[] = [];
const orgIds: string[] = [];

function stamp() {
  return `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.domainEvent.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const email of emails) await cleanupByEmail(email);
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test('an SSO change is audited with the issuer diff and without the certificate', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(90_000);
  const s = stamp();
  const home = await prisma.organization.create({ data: { name: `Config Ops ${s}`, slug: `config-ops-${s}` } });
  orgIds.push(home.id);
  const email = uniqueEmail('config-audit-operator');
  emails.push(email);
  const user = await seedUser(email, PASSWORD, 'ADMIN', 'Config Audit Operator', home.id);
  await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });

  const oldCert = testCertificate(365, 'config-audit-old');
  const newCert = testCertificate(365, 'config-audit-new');
  const tenant = await prisma.organization.create({
    data: {
      name: `Config Tenant ${s}`,
      slug: `config-tenant-${s}`,
      plan: 'ENTERPRISE',
      ssoIssuer: 'https://idp.example.test/old',
      ssoEntryPoint: 'https://idp.example.test/sso',
      ssoCertificate: oldCert,
    },
  });
  orgIds.push(tenant.id);

  await signInAndSettle(page, email, PASSWORD, '/admin');
  const res = await page.request.patch('/api/admin/organizations', {
    data: { id: tenant.id, ssoIssuer: 'https://idp.example.test/new', ssoCertificate: newCert },
  });
  expect(res.status()).toBe(200);

  // Delivered by the in-process job worker (5 s tick).
  let row: { actorId: string; targetId: string | null; detail: string | null } | null = null;
  await expect
    .poll(
      async () => {
        row = await prisma.auditLog.findFirst({ where: { orgId: tenant.id, action: 'org.config.changed' } });
        return Boolean(row);
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  const audit = row!;
  expect(audit.actorId).toBe(user.id);
  expect(audit.targetId).toBe(tenant.id);
  const detail = JSON.parse(audit.detail!);
  const byField = Object.fromEntries(
    (detail.changes as { field: string; fromFingerprint?: string | null; toFingerprint?: string | null }[]).map((c) => [c.field, c]),
  );
  expect(byField.ssoIssuer).toEqual({ field: 'ssoIssuer', from: 'https://idp.example.test/old', to: 'https://idp.example.test/new' });
  expect(byField.ssoCertificate).toMatchObject({ field: 'ssoCertificate', from: '[redacted]', to: '[redacted]', redacted: true });
  expect(byField.ssoCertificate.fromFingerprint).not.toBe(byField.ssoCertificate.toFingerprint);

  // The certificate is nowhere: not in the audit row, not in the event row.
  const certBody = (c: string) => c.split('\n').filter((l) => !l.startsWith('-----')).join('').slice(0, 40);
  const event = await prisma.domainEvent.findFirst({ where: { orgId: tenant.id, name: 'org.config.changed' } });
  for (const text of [audit.detail!, JSON.stringify(event?.payload)]) {
    expect(text).not.toContain(certBody(oldCert));
    expect(text).not.toContain(certBody(newCert));
  }

  // The operational feed keeps its field-names-only, warning-level entry.
  const activity = await prisma.activityLog.findFirst({ where: { orgId: tenant.id, action: 'org.updated' } });
  expect(activity?.detail).toContain('ssoIssuer');
});
