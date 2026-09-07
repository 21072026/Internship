// Unit tests for the mentor mentee search/filter rule (#1367).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The two things worth pinning down, because both are invisible in a happy-path
// click-through on English seed data:
//   - the fold: a Turkish/German audience types "Sahin" and "Muller" for
//     "Şahin" and "Müller", and dotless ı has to reach plain i as well, or the
//     search looks broken to exactly the people who use it most;
//   - stage keys are opaque: they are per-tenant rows since #747, so the filter
//     compares whatever key the caller passes and this file names none of the
//     canonical defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_MENTEE_FILTERS,
  filterMenteeRows,
  foldSearchText,
  hasActiveMenteeFilters,
  matchesMenteeQuery,
} from '../../src/lib/menteeFilter.ts';

const row = (over = {}) => ({
  status: 'ACTIVE',
  pipelineStatus: 'stage-a',
  mentee: { fullName: 'Ada Lovelace', email: 'ada@example.com', university: 'Bogazici' },
  ...over,
});

const ROWS = [
  row({ mentee: { fullName: 'Şevval Işık', email: 'sevval@example.com', university: 'İTÜ' } }),
  row({ status: 'COMPLETED', pipelineStatus: 'stage-b', mentee: { fullName: 'Lukas Müller', email: 'lukas@example.com', university: 'TU München' } }),
  row({ pipelineStatus: 'stage-b', mentee: { fullName: 'Ada Lovelace', email: 'ada@example.com', university: 'Bogazici' } }),
];

test('an empty filter set returns the rows untouched', () => {
  assert.equal(filterMenteeRows(ROWS, EMPTY_MENTEE_FILTERS), ROWS);
  assert.equal(hasActiveMenteeFilters(EMPTY_MENTEE_FILTERS), false);
  assert.equal(hasActiveMenteeFilters({ ...EMPTY_MENTEE_FILTERS, search: '   ' }), false);
});

test('accents fold both ways: typing ASCII finds the accented name', () => {
  assert.equal(foldSearchText('Şevval'), 'sevval');
  assert.equal(foldSearchText('  MÜLLER '), 'muller');
  // Turkish dotless ı and dotted İ both reach a plain i.
  assert.equal(foldSearchText('Işık'), 'isik');
  assert.equal(foldSearchText('İTÜ'), 'itu');

  // Matching is one plain substring over the folded field, so a full name typed
  // in ASCII works, but the words cannot be reordered.
  assert.equal(filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, search: 'sevval isik' }).length, 1);
  assert.equal(filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, search: 'isik sevval' }).length, 0);

  assert.deepEqual(
    filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, search: 'Isik' }).map((r) => r.mentee.fullName),
    ['Şevval Işık'],
  );
  assert.deepEqual(
    filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, search: 'muller' }).map((r) => r.mentee.fullName),
    ['Lukas Müller'],
  );
});

test('the query also covers e-mail and university, not just the name', () => {
  assert.deepEqual(
    filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, search: 'lukas@example' }).map((r) => r.mentee.fullName),
    ['Lukas Müller'],
  );
  assert.deepEqual(
    filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, search: 'bogazici' }).map((r) => r.mentee.fullName),
    ['Ada Lovelace'],
  );
});

test('a missing field never matches and never throws', () => {
  const sparse = { mentee: { fullName: 'No Contact Details' } };
  assert.equal(matchesMenteeQuery(sparse, 'example.com'), false);
  assert.equal(matchesMenteeQuery(sparse, 'contact'), true);
  assert.equal(matchesMenteeQuery(sparse, ''), true, 'an empty query matches everything');
});

test('status and stage narrow independently, and combine with the search', () => {
  assert.equal(filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, status: 'COMPLETED' }).length, 1);
  assert.equal(filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, status: 'ACTIVE' }).length, 2);
  // Stage keys are opaque per-tenant strings (#747) — whatever the caller got
  // from useResolvedStages(), compared as-is.
  assert.equal(filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, stage: 'stage-b' }).length, 2);
  assert.equal(
    filterMenteeRows(ROWS, { search: 'ada', status: 'ACTIVE', stage: 'stage-b' }).length,
    1,
  );
  assert.equal(
    filterMenteeRows(ROWS, { search: 'ada', status: 'COMPLETED', stage: 'stage-b' }).length,
    0,
  );
  // A stage nobody is in empties the list rather than falling back to all.
  assert.equal(filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, stage: 'stage-zz' }).length, 0);
});

test('input order is preserved, so the grid keeps its newest-first sort', () => {
  const names = filterMenteeRows(ROWS, { ...EMPTY_MENTEE_FILTERS, stage: 'stage-b' }).map(
    (r) => r.mentee.fullName,
  );
  assert.deepEqual(names, ['Lukas Müller', 'Ada Lovelace']);
});
