import { test, expect } from '@playwright/test';
import { checkFieldEdit, editTarget, latestAnswersByKey, liveVersion } from '@/lib/forms/definitionRule';

// The admin-form versioning rule (#1800) — no browser, no database. A free-text
// field is never matchable; a published key keeps its type; an edit of a
// published version is version N+1; an answer resolves across versions.

test('a free-text field can never be matchable; a published key keeps its type', { tag: '@smoke' }, async () => {
  const none = new Map<string, string>();
  expect(checkFieldEdit([{ key: 'bio', type: 'LONG_TEXT', matchable: true }], none, new Map())).toEqual({ code: 'not_matchable', key: 'bio' });
  expect(checkFieldEdit([{ key: 'city', type: 'TEXT', matchable: true }], none, new Map())).toEqual({ code: 'not_matchable', key: 'city' });
  expect(checkFieldEdit([{ key: 'level', type: 'SCALE', matchable: true }], none, new Map())).toBeNull();
  expect(checkFieldEdit([{ key: 'a', type: 'TEXT' }, { key: 'a', type: 'TEXT' }], none, new Map())?.code).toBe('duplicate_key');
  expect(checkFieldEdit([{ key: 'a', type: 'WHATEVER' }], none, new Map())?.code).toBe('invalid_type');
  const locked = new Map([['track', 'SELECT']]);
  expect(checkFieldEdit([{ key: 'track', type: 'MULTI_SELECT' }], locked, new Map())).toEqual({ code: 'field_type_locked', key: 'track' });
  expect(checkFieldEdit([{ key: 'track', type: 'SELECT' }], locked, new Map())).toBeNull();
  const current = new Map([['f1', { key: 'track', type: 'SELECT' }]]);
  expect(checkFieldEdit([{ id: 'f1', key: 'track_v2', type: 'SELECT' }], locked, current)).toEqual({ code: 'field_key_locked', key: 'track_v2' });
});

test('a published version is edited as N+1; one live version; answers resolve across versions', async () => {
  expect(editTarget({ version: 2, publishedAt: null }, 2)).toEqual({ inPlace: true });
  expect(editTarget({ version: 2, publishedAt: new Date() }, 2)).toEqual({ inPlace: false, version: 3 });
  const now = new Date();
  expect(liveVersion([{ version: 1, publishedAt: now, archivedAt: now }, { version: 2, publishedAt: now, archivedAt: null }, { version: 3, publishedAt: null, archivedAt: null }])?.version).toBe(2);
  expect(liveVersion([{ version: 1, publishedAt: null, archivedAt: null }])).toBeNull();
  const latest = latestAnswersByKey([
    { fieldKey: 'track', updatedAt: new Date('2026-01-01'), v: 'old' },
    { fieldKey: 'track', updatedAt: new Date('2026-02-01'), v: 'new' },
    { fieldKey: 'city', updatedAt: new Date('2026-01-05'), v: 'x' },
  ]);
  expect(latest.get('track')?.v).toBe('new');
  expect(latest.get('city')?.v).toBe('x');
});
