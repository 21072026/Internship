import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { orgMailIdentity, platformFromIdentity, orgMailWriteFields, mailIdentityDomainError, type OrgMailIdentityRow } from '@/lib/orgMailIdentityRule';

const platform = { name: 'Platform', address: 'platform@example.test' };
const hostProof = new Date('2026-01-01');
const verified: OrgMailIdentityRow = {
  brandName: 'Acme', publicHost: 'mail.acme.test', publicHostVerifiedAt: hostProof,
  mailFromName: 'Acme Team', mailFromAddress: 'hello@mail.acme.test',
  mailReplyTo: 'reply@mail.acme.test', mailDomainVerifiedAt: new Date('2026-01-02'),
};
const schema = z.object(orgMailWriteFields);

test('verified tenant uses its name/address; brandName is the name fallback', { tag: '@smoke' }, () => {
  expect(orgMailIdentity(verified, platform).from).toEqual({ name: 'Acme Team', address: 'hello@mail.acme.test' });
  expect(orgMailIdentity({ ...verified, mailFromName: null }, platform).from.name).toBe('Acme');
  expect(orgMailIdentity(verified, platform).replyTo).toBe('reply@mail.acme.test');
});

test('fields alone, missing proof, stale proof, or a mismatched/invalid address fail closed', { tag: '@smoke' }, () => {
  for (const changes of [
    { mailDomainVerifiedAt: null }, { publicHostVerifiedAt: null }, { publicHost: null },
    { mailDomainVerifiedAt: new Date('2025-01-01') }, { mailFromAddress: 'hello@acme.test' },
    { mailFromAddress: 'Name <hello@mail.acme.test>' }, { mailReplyTo: 'reply@other.test' },
    { mailFromName: 'Injected\r\nBcc: bad@example.test' },
  ]) {
    const identity = orgMailIdentity({ ...verified, ...changes }, platform);
    expect(identity.source).toBe('platform');
    expect(identity.from).toEqual(platform);
    expect(identity.replyTo).toBeUndefined();
  }
  expect(orgMailIdentity(null, platform).from).toEqual(platform);
});

test('write schema accepts only bare addresses and cannot create verification', () => {
  for (const field of ['mailFromAddress', 'mailReplyTo']) {
    for (const value of ['Name <a@mail.acme.test>', 'a@mail.acme.test,b@mail.acme.test', 'a@mail.acme.test\r\n', 'invalid']) {
      expect(schema.safeParse({ [field]: value }).success).toBe(false);
    }
  }
  expect(schema.safeParse({ mailDomainVerifiedAt: hostProof }).success).toBe(false);
  expect(schema.safeParse({ mailDomainVerifiedAt: null }).success).toBe(false);
  expect(schema.parse({ mailFromAddress: ' a@mail.acme.test ' }).mailFromAddress).toBe('a@mail.acme.test');
  expect(mailIdentityDomainError({ mailFromAddress: 'a@other.test' }, verified)).toBe(true);
  expect(mailIdentityDomainError({ mailReplyTo: 'a@other.test' }, verified)).toBe(true);
  expect(mailIdentityDomainError({ mailFromAddress: 'a@mail.acme.test' }, verified)).toBe(false);
  expect(mailIdentityDomainError({ mailFromAddress: 'a@mail.acme.test' }, { ...verified, publicHostVerifiedAt: null })).toBe(true);
  expect(mailIdentityDomainError({ mailFromAddress: null, mailReplyTo: '' }, verified)).toBe(false);
});

test('platform environment fallback and primary/bulk precedence remain exact', () => {
  const env = { SMTP_FROM: 'Primary <p@example.test>', SMTP_USER: 'u@example.test', SMTP_BULK_FROM: 'Bulk <b@example.test>', SMTP_BULK_USER: 'bu@example.test', MAIL_FROM_NAME: 'Env' };
  expect(platformFromIdentity(null, 'primary', env)).toEqual({ name: 'Primary', address: 'p@example.test' });
  expect(platformFromIdentity(null, 'bulk', env)).toEqual({ name: 'Bulk', address: 'b@example.test' });
  expect(platformFromIdentity('Brand', 'bulk', env)).toEqual({ name: 'Brand', address: 'b@example.test' });
  expect(platformFromIdentity(null, 'bulk', { ...env, SMTP_BULK_FROM: '' })).toEqual({ name: 'Primary', address: 'p@example.test' });
  expect(platformFromIdentity(null, 'bulk', { SMTP_USER: 'u', SMTP_BULK_USER: 'bu' })).toEqual({ name: 'Internship CRM', address: 'bu' });
  expect(platformFromIdentity(null, 'primary', {})).toEqual({ name: 'Internship CRM', address: '' });
});
