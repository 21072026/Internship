// Unit tests for the vertical-aware brand name fallback (#2355 follow-up).
//
// A non-INTERNSHIP vertical is a different product; when its tenant has set no
// white-label brandName, the wordmark must fall back to the ORG'S OWN NAME, not
// to "Internship CRM" — otherwise a marketing tenant is greeted as the internship
// product (the exact bug reported after the marketing-host cutover).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBranding, DEFAULT_BRANDING } from '../../src/lib/branding.ts';

test('a set brandName always wins, fallbackName ignored', () => {
  assert.equal(resolveBranding({ brandName: 'SaleVali' }, 'IgnoreMe').name, 'SaleVali');
});

test('no brandName + a fallbackName uses the fallback (the org name), not the product default', () => {
  assert.equal(resolveBranding(null, 'SaleVali').name, 'SaleVali');
  assert.equal(resolveBranding({ brandName: null }, 'SaleVali').name, 'SaleVali');
  assert.equal(resolveBranding({ brandName: '   ' }, 'SaleVali').name, 'SaleVali');
});

test('no brandName + no fallbackName keeps the product default (INTERNSHIP path)', () => {
  assert.equal(resolveBranding(null).name, DEFAULT_BRANDING.name);
  assert.equal(resolveBranding({ brandName: null }, null).name, DEFAULT_BRANDING.name);
  assert.equal(resolveBranding(null, '  ').name, DEFAULT_BRANDING.name);
});
