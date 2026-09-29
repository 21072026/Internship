import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePublicInquiryTarget, normalizePublicHost } from '../../src/lib/publicHostRule.ts';
import { normalizeHost } from '../../prisma/set-public-host.mjs';

// Which tenant a sessionless public form writes into (#2569). The rule is the
// security-relevant part — a marketing host must never fall back to the
// internship tenant — so it is pinned here, without a database.

const MKT = { id: 'org_mkt', vertical: 'MARKETING' };
const INT = { id: 'org_int', vertical: 'INTERNSHIP' };

test('a mapped host writes into exactly the mapped org', () => {
  assert.deepEqual(decidePublicInquiryTarget({ hostVertical: 'MARKETING', mapped: MKT, defaultOrgId: 'org_default' }), {
    open: true,
    orgId: 'org_mkt',
    vertical: 'MARKETING',
    via: 'mapping',
  });
  assert.deepEqual(decidePublicInquiryTarget({ hostVertical: 'INTERNSHIP', mapped: INT, defaultOrgId: 'org_default' }), {
    open: true,
    orgId: 'org_int',
    vertical: 'INTERNSHIP',
    via: 'mapping',
  });
});

test('an unmapped MARKETING host is closed — never the default (internship) org', () => {
  const t = decidePublicInquiryTarget({ hostVertical: 'MARKETING', mapped: null, defaultOrgId: 'org_default' });
  assert.equal(t.open, false);
  assert.equal(t.reason, 'unmapped_marketing_host');
  assert.equal('orgId' in t, false);
});

test('an unmapped INTERNSHIP host keeps the historical default org', () => {
  assert.deepEqual(decidePublicInquiryTarget({ hostVertical: 'INTERNSHIP', mapped: null, defaultOrgId: 'org_default' }), {
    open: true,
    orgId: 'org_default',
    vertical: 'INTERNSHIP',
    via: 'default',
  });
});

test('a mapping to the other product closes the form in both directions', () => {
  for (const [hostVertical, mapped] of [['MARKETING', INT], ['INTERNSHIP', MKT]]) {
    const t = decidePublicInquiryTarget({ hostVertical, mapped, defaultOrgId: 'org_default' });
    assert.equal(t.open, false, `${hostVertical} → ${mapped.vertical}`);
    assert.equal(t.reason, 'vertical_mismatch');
  }
});

// The operator script mirrors normalizePublicHost in plain ESM; one corpus runs
// through both so they cannot drift.
const CORPUS = [
  ['marketing.bcsit-gmbh.de', 'marketing.bcsit-gmbh.de'],
  ['  Marketing.BCSIT-GmbH.de ', 'marketing.bcsit-gmbh.de'],
  ['localhost', 'localhost'],
  ['pr12.interncrm.com', 'pr12.interncrm.com'],
  ['https://marketing.bcsit-gmbh.de', null],
  ['marketing.bcsit-gmbh.de:443', null],
  ['marketing.bcsit-gmbh.de/', null],
  ['*.bcsit-gmbh.de', null],
  ['marketing.bcsit-gmbh.de.', null],
  ['-bad.example', null],
  ['a b.example', null],
  ['', null],
  [null, null],
  [42, null],
  ['x'.repeat(254), null],
];

test('normalizePublicHost: a bare lowercase hostname, anything else refused', () => {
  for (const [input, expected] of CORPUS) assert.equal(normalizePublicHost(input), expected, String(input));
});

test('prisma/set-public-host.mjs normalizes exactly like the app', () => {
  for (const [input] of CORPUS) assert.equal(normalizeHost(input), normalizePublicHost(input), String(input));
});
