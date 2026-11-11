// Unit tests for the tenant hard-delete rule (src/lib/orgDeletionRule.ts, #1584):
// the four locks, and the deletion plan run against the REAL schema (Prisma's
// DMMF) — a cycle of required links or a multi-column link into the tenant
// fails here, in CI, not on a customer's tenant.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const R = await import('../../src/lib/orgDeletionRule.ts');
const { Prisma } = createRequire(import.meta.url)('@prisma/client');

const models = Prisma.dmmf.datamodel.models.map((m) => ({
  name: m.name,
  hasOrgId: m.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar'),
  links: m.fields
    .filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0)
    .map((f) => ({
      model: f.type,
      fields: f.relationFromFields,
      references: f.relationToFields,
      required: f.relationFromFields.every((fn) => m.fields.find((x) => x.name === fn)?.isRequired === true),
    })),
}));

const org = (over = {}) => ({ id: 'o1', slug: 'acme', archivedAt: new Date('2026-10-01'), deletionRequestedAt: null, ...over });

test('the switch is OFF unless the deployment says 1/true', () => {
  assert.equal(R.hardDeleteEnabled({}), false);
  assert.equal(R.hardDeleteEnabled({ TENANT_HARD_DELETE_ENABLED: '0' }), false);
  assert.equal(R.hardDeleteEnabled({ TENANT_HARD_DELETE_ENABLED: 'yes' }), false);
  assert.equal(R.hardDeleteEnabled({ TENANT_HARD_DELETE_ENABLED: '1' }), true);
  assert.equal(R.hardDeleteEnabled({ TENANT_HARD_DELETE_ENABLED: 'true' }), true);
});

test('the wait defaults to 72h and is never under 24h', () => {
  assert.equal(R.waitHours({}), 72);
  assert.equal(R.waitHours({ TENANT_HARD_DELETE_WAIT_HOURS: '1' }), 24);
  assert.equal(R.waitHours({ TENANT_HARD_DELETE_WAIT_HOURS: '100' }), 100);
  assert.equal(R.waitHours({ TENANT_HARD_DELETE_WAIT_HOURS: 'x' }), 72);
});

test('stage 1: switch, default/own org, archived, exact slug, once', () => {
  const ok = { enabled: true, actorOrgId: 'op', confirmSlug: 'acme' };
  assert.deepEqual(R.requestDecision(org(), ok), { ok: true });
  assert.equal(R.requestDecision(org(), { ...ok, enabled: false }).code, 'hard_delete_disabled');
  assert.equal(R.requestDecision(org({ slug: 'default' }), { ...ok, confirmSlug: 'default' }).code, 'default_org');
  assert.equal(R.requestDecision(org(), { ...ok, actorOrgId: 'o1' }).code, 'own_org');
  assert.equal(R.requestDecision(org({ archivedAt: null }), ok).code, 'not_archived');
  assert.equal(R.requestDecision(org(), { ...ok, confirmSlug: 'acme2' }).code, 'slug_mismatch');
  assert.equal(R.requestDecision(org({ deletionRequestedAt: new Date() }), ok).code, 'already_requested');
});

test('stage 2: requested, waited, exported after the request', () => {
  const requested = new Date('2026-10-01T00:00:00Z');
  const base = { enabled: true, actorOrgId: 'op', confirmSlug: 'acme', waitHours: 72, exportedSinceRequest: true };
  const o = org({ deletionRequestedAt: requested });
  assert.equal(R.executeDecision(org(), { ...base, now: new Date('2026-11-01') }).code, 'not_requested');
  assert.equal(R.executeDecision(o, { ...base, now: new Date('2026-10-03T23:59:00Z') }).code, 'waiting_period');
  assert.equal(R.executeDecision(o, { ...base, now: new Date('2026-10-04T00:00:00Z'), exportedSinceRequest: false }).code, 'export_required');
  assert.deepEqual(R.executeDecision(o, { ...base, now: new Date('2026-10-04T00:00:00Z') }), { ok: true });
  assert.equal(R.executeDecision(o, { ...base, enabled: false, now: new Date('2027-01-01') }).code, 'hard_delete_disabled');
  assert.equal(R.eligibleAt(o, 72).toISOString(), '2026-10-04T00:00:00.000Z');
});

test('the plan on the real schema: no cycle, nothing unhandled, children before parents', () => {
  const plan = R.planDeletion(models);
  assert.deepEqual(plan.unhandled, []);
  const names = plan.deletes.map((d) => d.model);
  for (const m of ['User', 'MentorshipRelation', 'Company', 'InteractionLog', 'Message', 'Notification', 'AuditLog', 'PasswordResetToken', 'TrustedDevice', 'SsoLoginGrant']) {
    assert.ok(names.includes(m), `${m} is deleted`);
  }
  assert.ok(!names.includes('Organization'), 'the org row goes last, on its own');
  const pos = new Map(names.map((n, i) => [n, i]));
  const byName = new Map(models.map((m) => [m.name, m]));
  for (const n of names) {
    for (const l of byName.get(n).links) {
      if (l.required && pos.has(l.model) && l.model !== n) assert.ok(pos.get(n) < pos.get(l.model), `${n} before its parent ${l.model}`);
    }
  }
  // The ownership column is never nulled — that would orphan the row instead of deleting it.
  for (const n of plan.nullify) assert.ok(!(n.field === 'orgId' && n.parent === 'Organization'), `${n.model}.orgId must not be nulled`);
  // Every model with an orgId is deleted by its orgId.
  for (const m of models) if (m.hasOrgId && m.name !== 'Organization') assert.equal(plan.deletes.find((d) => d.model === m.name)?.where, 'org', m.name);
});

test('a cycle of required links is a plan error, not a guess', () => {
  const cyc = [
    { name: 'A', hasOrgId: true, links: [{ model: 'B', fields: ['bId'], references: ['id'], required: true }] },
    { name: 'B', hasOrgId: true, links: [{ model: 'A', fields: ['aId'], references: ['id'], required: true }] },
  ];
  assert.throws(() => R.planDeletion(cyc, []), /cycle/);
});
