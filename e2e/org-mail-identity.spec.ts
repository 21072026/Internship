import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { prisma as appPrisma } from '@/lib/prisma';
import { prepareEmail, transmit, failoverEnvelope, transportFor, type PreparedEmail } from '@/services/emailService';
import { resolveMailIdentity } from '@/lib/orgMailIdentity';
import { encodeEnvelope, decodeEnvelope, type Envelope } from '@/lib/mailWorkerRule';
import { platformFromIdentity } from '@/lib/orgMailIdentityRule';

const tag = `${Date.now()}`;
const domain = `mail-${tag}.example.test`;
const email = uniqueEmail('mail-identity-admin');
const password = 'Identity1670Test!';
let orgId = '';
let userId = '';
const proof = new Date('2026-01-02');
const envKeys = ['SMTP_USER', 'SMTP_FROM', 'SMTP_BULK_FROM'];
const saved = new Map(envKeys.map(key => [key, process.env[key]]));

test.beforeAll(async () => {
  process.env.SMTP_USER = 'synthetic@example.test';
  process.env.SMTP_FROM = 'Platform <platform@example.test>';
  process.env.SMTP_BULK_FROM = 'Bulk <bulk@example.test>';
  orgId = (await prisma.organization.create({ data: {
    name: `Mail identity ${tag}`, slug: `mail-identity-${tag}`, brandName: 'Tenant Brand',
    publicHost: domain, publicHostVerifiedAt: new Date('2026-01-01'),
    mailFromAddress: `hello@${domain}`, mailFromName: 'Tenant Team',
    mailReplyTo: `reply@${domain}`, mailDomainVerifiedAt: proof,
  } })).id;
  userId = (await seedUser(email, password, 'ADMIN', 'Identity Admin', orgId)).id;
});
test.beforeEach(async () => {
  await prisma.organization.update({ where: { id: orgId }, data: { mailDomainVerifiedAt: proof, mailFromName: 'Tenant Team', mailReplyTo: `reply@${domain}` } });
});
test.afterAll(async () => {
  for (const key of envKeys) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await cleanupByEmail(email);
  await prisma.emailLog.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});
async function prepare(replyTo?: string, category = 'test'): Promise<PreparedEmail> {
  const result = await prepareEmail({ to: 'recipient@example.test', subject: 'Synthetic identity test', html: '<p>Test</p>', orgId, replyTo, category });
  expect(result.status).toBe('READY');
  if (result.status !== 'READY') throw new Error('Expected prepared mail');
  return result.prepared;
}
async function recorded(prepared: PreparedEmail) {
  const messages: unknown[] = [];
  await transmit(prepared, { via: { sendMail: async message => { messages.push(message); return { envelope: { from: '', to: [] }, messageId: 'synthetic-recording-only' }; } } });
  expect(messages).toHaveLength(1);
  return messages[0] as PreparedEmail['message'];
}

test('verified prepare and final transport use tenant identity; explicit replyTo wins', async () => {
  const prepared = await prepare();
  expect(prepared.message.from).toEqual({ name: 'Tenant Team', address: `hello@${domain}` });
  expect((await recorded(prepared)).replyTo).toBe(`reply@${domain}`);
  const explicit = await prepare('caller@outside.example.test');
  expect((await recorded(explicit)).replyTo).toBe('caller@outside.example.test');
  await prisma.organization.update({ where: { id: orgId }, data: { mailFromName: null, mailReplyTo: null } });
  const fallback = await prepare();
  expect(fallback.message.from).toEqual({ name: 'Tenant Brand', address: `hello@${domain}` });
  expect((await recorded(fallback)).replyTo).toBeUndefined();
});

test('revocation invalidates a serialized queued/approved identity before transport', async () => {
  const prepared = await prepare();
  const explicit = await prepare('caller@outside.example.test');
  const serialized = decodeEnvelope(encodeEnvelope(prepared as unknown as Envelope)) as unknown as PreparedEmail;
  expect(serialized.mailIdentity).toEqual(prepared.mailIdentity);
  await prisma.organization.update({ where: { id: orgId }, data: { mailDomainVerifiedAt: null } });
  expect((await recorded(serialized)).from).toEqual(platformFromIdentity());
  expect((await recorded(serialized)).replyTo).toBeUndefined();
  expect((await recorded(explicit)).replyTo).toBe('caller@outside.example.test');
  expect((await prepare()).message.from).toEqual(platformFromIdentity());
});

test('identity does not select a channel and tenant From survives primary/bulk failover', async () => {
  // The existing transport selector reads bulk configuration at module load.
  // CI normally disables it. Configure the existing transport test seam only;
  // every transmission below still uses the injected recording transport.
  const { resetMailTransportsForTests } = await import('@/services/emailService');
  const oldHost = process.env.SMTP_BULK_HOST;
  const oldUser = process.env.SMTP_BULK_USER;
  process.env.SMTP_BULK_HOST = '127.0.0.1';
  process.env.SMTP_BULK_USER = 'synthetic@example.test';
  resetMailTransportsForTests();
  try {
    const digestChannel = transportFor('activity-digest');
    const digest = await prepare(undefined, 'activity-digest');
    expect(digest.transport).toBe(digestChannel);
    const primary = await prepare();
    expect(primary.transport).toBe('primary');
    const bulk = failoverEnvelope(primary);
    expect(bulk?.transport).toBe('bulk');
    expect((await recorded(bulk!)).from).toEqual(primary.message.from);
    await prisma.organization.update({ where: { id: orgId }, data: { mailDomainVerifiedAt: null } });
    expect((await recorded(bulk!)).from).toEqual({ name: 'Platform', address: 'bulk@example.test' });
    expect((await prepare(undefined, 'activity-digest')).transport).toBe(digestChannel);
  } finally {
    resetMailTransportsForTests();
    if (oldHost === undefined) delete process.env.SMTP_BULK_HOST; else process.env.SMTP_BULK_HOST = oldHost;
    if (oldUser === undefined) delete process.env.SMTP_BULK_USER; else process.env.SMTP_BULK_USER = oldUser;
  }
});

test('transactional mail resolves the recipient organization when only userId is supplied', async () => {
  const result = await prepareEmail({ to: email, userId, category: 'test', subject: 'Synthetic recipient identity', html: '<p>Test</p>' });
  expect(result.status).toBe('READY');
  if (result.status !== 'READY') throw new Error('Expected prepared mail');
  expect(result.prepared.orgId).toBe(orgId);
  expect((await recorded(result.prepared)).from).toEqual({ name: 'Tenant Team', address: `hello@${domain}` });
});

test('missing organization or failed lookup cannot authorize a tenant sender', async () => {
  expect((await resolveMailIdentity('missing-org')).source).toBe('platform');
  const delegate = appPrisma.organization as unknown as Record<string, unknown>;
  const original = delegate.findUnique;
  delegate.findUnique = () => Promise.reject(new Error('synthetic read failure'));
  try { expect((await resolveMailIdentity(orgId)).source).toBe('platform'); }
  finally { delegate.findUnique = original; }
});

test('organization PATCH rejects mismatched domains, embedded names and client verification; health is scoped', async ({ request }) => {
  expect((await request.patch('/api/admin/organizations', { data: { id: orgId, mailFromAddress: `hello@${domain}` } })).status()).toBe(401);
  expect((await signInViaApi(request, email, password)).ok).toBe(true);
  for (const data of [
    { mailFromAddress: 'bad@other.example.test' }, { mailReplyTo: 'bad@other.example.test' },
    { mailFromAddress: `Name <hello@${domain}>` }, { mailFromAddress: `hello@${domain}\r\n` },
    { mailDomainVerifiedAt: proof.toISOString() },
  ]) expect((await request.patch('/api/admin/organizations', { data: { id: orgId, ...data } })).status()).toBe(400);
  expect((await request.patch('/api/admin/organizations', { data: { id: orgId, mailFromAddress: `updated@${domain}` } })).status()).toBe(200);
  const health = await request.get('/api/admin/email-health');
  expect(health.status()).toBe(200);
  expect((await health.json()).tenantIdentity).toMatchObject({ active: true, source: 'tenant', verifiedDomain: domain });
  expect((await request.patch('/api/admin/organizations', { data: { id: 'another-org', mailFromAddress: `hello@${domain}` } })).status()).toBe(403);
});
