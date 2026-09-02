import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDemoTarget, isSafeDemoTarget } from '../../prisma/demoTarget.mjs';

// prisma/demoTarget.mjs is the ONE definition of "a database it is safe to fill
// with synthetic demo rows" (#2063). Both prisma/seed-demo.mjs (writes) and
// scripts/check-demo-fidelity.mjs (counts) import it, so a regression that made
// it permissive would let a demo seed land on the shared preview or on prod —
// where it would be indistinguishable from real data. The refusals below are
// the part that matters; the acceptances only exist so nobody "fixes" a false
// negative by widening the regex.

test('refuses the shared preview and production databases', () => {
  for (const url of [
    'mysql://user:pw@db.internal:3306/internship_crm',
    'mysql://user:pw@db.internal:3306/internship_crm_preview',
    'mysql://user:pw@crm.ersah.in:3306/internship_crm?connection_limit=5',
  ]) {
    assert.equal(isSafeDemoTarget(url), false, `should refuse ${url}`);
  }
});

test('accepts a local database', () => {
  for (const url of [
    'mysql://root:root@127.0.0.1:3306/internship_test',
    'mysql://u:p@localhost:3306/anything',
    'mysql://u:p@mysql:3306/internship_test',
  ]) {
    assert.equal(isSafeDemoTarget(url), true, `should accept ${url}`);
  }
});

test('accepts a *_demo database reached over the container network', () => {
  assert.equal(isSafeDemoTarget('mysql://u:p@db.internal:3306/internship_demo'), true);
});

test('SEED_DEMO_FORCE only unlocks an internship_pr<N> database', () => {
  const prod = 'mysql://u:p@db.internal:3306/internship_crm';
  const topic = 'mysql://u:p@db.internal:3306/internship_pr1234';
  const prev = process.env.SEED_DEMO_FORCE;
  try {
    process.env.SEED_DEMO_FORCE = '1';
    assert.equal(isSafeDemoTarget(prod), false, 'the flag must not be a blanket bypass');
    assert.equal(isSafeDemoTarget(topic), true);
    delete process.env.SEED_DEMO_FORCE;
    assert.equal(isSafeDemoTarget(topic), false, 'a topic DB still needs the flag');
  } finally {
    if (prev === undefined) delete process.env.SEED_DEMO_FORCE;
    else process.env.SEED_DEMO_FORCE = prev;
  }
});

test('an empty or missing DATABASE_URL is not safe', () => {
  assert.equal(isSafeDemoTarget(''), false);
  assert.equal(isSafeDemoTarget(undefined), false);
  assert.equal(classifyDemoTarget('').safe, false);
});
