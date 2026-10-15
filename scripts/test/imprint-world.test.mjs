// Unit tests for operatorIdentity's world choice (#2697): the marketing product
// may have its own provider (another company than the internship operator), read from the
// MARKETING_OPERATOR_* set; without that set every host keeps the deployment's
// OPERATOR_* identity, which is what each host showed before.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { operatorIdentity } = await import('../../src/lib/imprint.ts');

const BASE = { OPERATOR_NAME: 'Jane Doe', OPERATOR_EMAIL: 'jane@example.com', OPERATOR_ADDRESS: 'A 1|12345 B' };
const MKT = {
  MARKETING_OPERATOR_NAME: 'Acme Sales GmbH',
  MARKETING_OPERATOR_EMAIL: 'info@acme.example',
  MARKETING_OPERATOR_ADDRESS: 'Weg 2|54321 C',
  MARKETING_OPERATOR_REGISTER: 'Amtsgericht X HRB 1',
};

test('the internship world reads OPERATOR_* and ignores the marketing set', () => {
  const op = operatorIdentity({ ...BASE, ...MKT }, 'INTERNSHIP');
  assert.equal(op.name, 'Jane Doe');
  assert.deepEqual(op.address, ['A 1', '12345 B']);
  assert.equal(operatorIdentity({ ...BASE, ...MKT }).name, 'Jane Doe', 'the default world is internship');
});

test('the marketing world reads its own complete set', () => {
  const op = operatorIdentity({ ...BASE, ...MKT }, 'MARKETING');
  assert.equal(op.name, 'Acme Sales GmbH');
  assert.equal(op.email, 'info@acme.example');
  assert.deepEqual(op.address, ['Weg 2', '54321 C']);
  assert.equal(op.register, 'Amtsgericht X HRB 1');
});

test('without a complete marketing set, the marketing world falls back whole — never a mix', () => {
  const op = operatorIdentity({ ...BASE, MARKETING_OPERATOR_NAME: 'Acme Sales GmbH' }, 'MARKETING');
  assert.equal(op.name, 'Jane Doe');
  assert.equal(op.email, 'jane@example.com');
  assert.equal(operatorIdentity({}, 'MARKETING'), null);
});
