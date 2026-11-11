// Unit tests for the tenant export policy (src/lib/orgExportPolicy.ts, #1584),
// run against the REAL schema (Prisma's DMMF), so a new credential-looking
// column, or a model the walk cannot reach, fails here and not in a customer's
// downloaded file.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createRequire } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { undecidedSecretFields, staleEntries, planWalk, isModelOmitted, OMITTED_FIELDS } = await import('../../src/lib/orgExportPolicy.ts');
const { Prisma } = createRequire(import.meta.url)('@prisma/client');
const models = Prisma.dmmf.datamodel.models;

const walkModels = models.map((m) => ({
  name: m.name,
  hasOrgId: m.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar'),
  parents: m.fields
    .filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0)
    .map((f) => ({ model: f.type, fields: f.relationFromFields ?? [], references: f.relationToFields ?? [] })),
}));

test('every credential-looking column of the schema is decided', () => {
  assert.deepEqual(undecidedSecretFields(models), []);
});

test('no policy line names a column or model the schema no longer has', () => {
  assert.deepEqual(staleEntries(models), []);
});

test('the credentials the issue names are omitted', () => {
  for (const k of ['User.password', 'User.twoFactorSecret', 'ApiKey.hashedKey', 'Webhook.secret', 'Organization.ssoCertificate', 'Organization.ssoSpKey']) {
    assert.ok(k in OMITTED_FIELDS, k);
  }
  for (const m of ['PasswordResetToken', 'TrustedDevice', 'SessionRefreshGrant', 'LoginLinkToken', 'TwoFactorRecoveryCode']) {
    assert.ok(isModelOmitted(m), m);
  }
});

test('the walk reaches the tenant’s child rows that carry no orgId', () => {
  const plan = planWalk(walkModels);
  const names = new Set(plan.map((p) => p.model));
  for (const m of ['User', 'MentorshipRelation', 'Company', 'Offer', 'InteractionLog', 'Message', 'Goal', 'Evaluation', 'StatusChange', 'Notification', 'UserTag', 'InterviewPanelMember', 'MessageAttachment']) {
    assert.ok(names.has(m), `${m} is exported`);
  }
  assert.ok(!names.has('Organization'), 'the org row is written once, on its own');
  for (const p of plan) assert.ok(!isModelOmitted(p.model), `${p.model} is omitted and must not be walked`);
  // A child comes after every parent it is reached through.
  const pos = new Map(plan.map((p, i) => [p.model, i]));
  for (const p of plan) for (const v of p.via) assert.ok(pos.get(v.parent) < pos.get(p.model), `${v.parent} before ${p.model}`);
});
