// Unit tests for the plan capacity gates (#547/#1796/#2273): active
// mentorships and projects per org, and the two 403 payloads a refused add
// returns. Capacity, not billing — src/lib/metering.ts owns usage.
//
// Prisma is the in-memory fake from ./fake-prisma.mjs (#1598).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakePrisma } from './fake-prisma.mjs';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const db = installFakePrisma();
const {
  checkActiveRelationLimit,
  checkActiveRelationLimitForMentee,
  checkProjectLimit,
  planLimitError,
  projectLimitError,
} = await import('../../src/lib/planGate.ts');

beforeEach(() => db.reset());
const onPlan = (plan) => {
  db.handlers['organization.findUnique'] = () => (plan === undefined ? null : { plan });
};

test('no org, an unknown org, or an unrecognised plan fails OPEN and reads nothing more', async () => {
  assert.deepEqual(await checkActiveRelationLimit(null), { allowed: true, plan: null, limit: null, usage: 0 });
  assert.equal(db.calls.length, 0);
  onPlan(undefined);
  assert.equal((await checkActiveRelationLimit('org-x')).allowed, true);
  onPlan('LEGACY_GOLD');
  assert.deepEqual(await checkActiveRelationLimit('org-x'), { allowed: true, plan: null, limit: null, usage: 0 });
  assert.equal(db.calls.filter((c) => c.op === 'count').length, 0);
});

test('an unlimited plan never counts', async () => {
  onPlan('ENTERPRISE');
  assert.deepEqual(await checkActiveRelationLimit('org-e'), { allowed: true, plan: 'ENTERPRISE', limit: null, usage: 0 });
  assert.deepEqual(await checkProjectLimit('org-e'), { allowed: true, plan: 'ENTERPRISE', limit: null, usage: 0 });
  assert.equal(db.calls.filter((c) => c.op === 'count').length, 0);
});

test('FREE: 25 active mentorships — the 25th fits, the 26th does not, and a batch is judged whole', async () => {
  onPlan('FREE');
  db.handlers['mentorshipRelation.count'] = () => 24;
  assert.deepEqual(await checkActiveRelationLimit('org-f'), { allowed: true, plan: 'FREE', limit: 25, usage: 24 });
  assert.equal((await checkActiveRelationLimit('org-f', 2)).allowed, false, 'a 2-pair publish must not half-fit');
  db.handlers['mentorshipRelation.count'] = () => 25;
  assert.equal((await checkActiveRelationLimit('org-f')).allowed, false);
  const count = db.calls.find((c) => c.model === 'mentorshipRelation' && c.op === 'count');
  assert.equal(count.args.where.orgId, 'org-f');
});

test('the mentee path resolves the org from the mentee', async () => {
  db.handlers['user.findUnique'] = () => ({ orgId: 'org-m' });
  onPlan('PRO');
  db.handlers['mentorshipRelation.count'] = () => 10;
  assert.deepEqual(await checkActiveRelationLimitForMentee('u1'), { allowed: true, plan: 'PRO', limit: 200, usage: 10, orgId: 'org-m' });
  db.handlers['user.findUnique'] = () => null;
  assert.deepEqual(await checkActiveRelationLimitForMentee('ghost'), { allowed: true, plan: null, limit: null, usage: 0, orgId: null });
});

test('projects: FREE allows 3 — the fourth is refused', async () => {
  onPlan('FREE');
  db.handlers['project.count'] = () => 2;
  assert.deepEqual(await checkProjectLimit('org-f'), { allowed: true, plan: 'FREE', limit: 3, usage: 2 });
  db.handlers['project.count'] = () => 3;
  assert.equal((await checkProjectLimit('org-f')).allowed, false);
  assert.deepEqual(await checkProjectLimit(undefined), { allowed: true, plan: null, limit: null, usage: 0 });
});

test('the two refusals carry DIFFERENT codes, so a project refusal never reads as "too many mentees"', () => {
  const gate = { allowed: false, plan: 'FREE', limit: 25, usage: 25 };
  const rel = planLimitError(gate);
  assert.equal(rel.code, 'plan_limit_reached');
  assert.deepEqual({ limit: rel.limit, usage: rel.usage, plan: rel.plan }, { limit: 25, usage: 25, plan: 'FREE' });
  assert.match(rel.error, /25\/25 active mentorships on the FREE plan/);
  const proj = projectLimitError({ ...gate, limit: 3, usage: 3 });
  assert.equal(proj.code, 'project_limit_reached');
  assert.match(proj.error, /3\/3 projects on the FREE plan/);
});
