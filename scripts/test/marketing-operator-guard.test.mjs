// The marketing operator guard (#2578): a postal campaign is printed and posted
// only when the marketing world names its OWN sender — name, e-mail and postal
// address under MARKETING_OPERATOR_*. The imprint page may fall back to the core
// OPERATOR_* set; a letter may not (outreach-compliance.md § 6).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketingOperatorConfigured, operatorIdentity } from '../../src/lib/imprint.ts';
import { marketingOperatorWarning } from '../../prisma/check-marketing-orgs.mjs';

const FULL = {
  MARKETING_OPERATOR_NAME: 'Example Operator GmbH',
  MARKETING_OPERATOR_EMAIL: 'operator@example.test',
  MARKETING_OPERATOR_ADDRESS: 'Musterstraße 1|10115 Berlin',
};
const CORE = { OPERATOR_NAME: 'Core Operator', OPERATOR_EMAIL: 'core@example.test', OPERATOR_ADDRESS: 'Kernweg 2|20095 Hamburg' };

test('the full MARKETING set is configured', () => {
  assert.equal(marketingOperatorConfigured(FULL), true);
});

for (const key of Object.keys(FULL)) {
  test(`${key} missing → not configured`, () => {
    const env = { ...FULL };
    delete env[key];
    assert.equal(marketingOperatorConfigured(env), false);
  });
  test(`${key} blank → not configured`, () => {
    assert.equal(marketingOperatorConfigured({ ...FULL, [key]: '   ' }), false);
  });
}

test('an address of separators only is no address', () => {
  assert.equal(marketingOperatorConfigured({ ...FULL, MARKETING_OPERATOR_ADDRESS: ' | | ' }), false);
});

test('the core set alone never counts — the imprint may fall back, a letter may not', () => {
  assert.equal(marketingOperatorConfigured(CORE), false);
  assert.equal(marketingOperatorConfigured({}), false);
  // …even though the imprint page still shows the core identity on the marketing host.
  assert.equal(operatorIdentity(CORE, 'MARKETING')?.name, 'Core Operator');
});

test('a MARKETING set with the same values as the core set is configured', () => {
  const same = {
    ...CORE,
    MARKETING_OPERATOR_NAME: CORE.OPERATOR_NAME,
    MARKETING_OPERATOR_EMAIL: CORE.OPERATOR_EMAIL,
    MARKETING_OPERATOR_ADDRESS: CORE.OPERATOR_ADDRESS,
  };
  assert.equal(marketingOperatorConfigured(same), true);
});

// The deploy-time readiness line (prisma/check-marketing-orgs.mjs) is a plain-ESM
// mirror of the guard: it must warn exactly when the guard would refuse, and only
// on a deployment that serves the marketing product at all.
test('the deploy readiness WARNING mirrors the guard, and only where the marketing product is served', () => {
  const HOSTS = { MARKETING_HOSTS: 'crm.example.test' };
  const cases = [
    FULL,
    {},
    CORE,
    { ...FULL, MARKETING_OPERATOR_NAME: '' },
    { ...FULL, MARKETING_OPERATOR_EMAIL: '  ' },
    { ...FULL, MARKETING_OPERATOR_ADDRESS: undefined },
    { ...FULL, MARKETING_OPERATOR_ADDRESS: ' | ' },
  ];
  for (const env of cases) {
    const warning = marketingOperatorWarning({ ...HOSTS, ...env });
    assert.equal(warning === null, marketingOperatorConfigured(env), JSON.stringify(env));
    if (warning) assert.match(warning, /^WARNING marketing operator: /);
    // No marketing host → no line, whatever the operator set says.
    assert.equal(marketingOperatorWarning(env), null);
    assert.equal(marketingOperatorWarning({ ...env, MARKETING_HOSTS: '  ' }), null);
  }
  assert.match(marketingOperatorWarning({ ...HOSTS, ...FULL, MARKETING_OPERATOR_ADDRESS: '' }), /MARKETING_OPERATOR_ADDRESS not set/);
});
