// The CompanyNeed -> Requisition converter's twin rule (#1875).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAdoptableTwin, legacyDescription, mapCompanyNeedToRequisition } from '../requisition-backfill-lib.mjs';

const need = { id: 'n-new', companyId: 'c1', position: 'Backend intern', count: 2, period: 'Summer', company: { orgId: 'o1' } };
const twin = { id: 'r1', companyId: 'c1', title: 'Backend intern', description: legacyDescription('Summer'), legacyCompanyNeedId: 'n-old' };

test('a converted row whose source need was recreated adopts the new need', () => {
  assert.equal(findAdoptableTwin(need, [twin], new Set(['n-new']))?.id, 'r1');
});

test('a twin whose source need still exists is a separate need — never adopted', () => {
  assert.equal(findAdoptableTwin(need, [twin], new Set(['n-new', 'n-old'])), null);
});

test('company, title and period must all match', () => {
  const live = new Set(['n-new']);
  assert.equal(findAdoptableTwin({ ...need, companyId: 'c2' }, [twin], live), null);
  assert.equal(findAdoptableTwin({ ...need, position: 'Frontend intern' }, [twin], live), null);
  assert.equal(findAdoptableTwin({ ...need, period: 'Winter' }, [twin], live), null);
});

test('one twin absorbs at most one need per run', () => {
  assert.equal(findAdoptableTwin(need, [twin], new Set(['n-new']), new Set(['r1'])), null);
});

test('the mapping writes the same description the twin rule compares', () => {
  assert.equal(mapCompanyNeedToRequisition(need).description, legacyDescription('Summer'));
});
