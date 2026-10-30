import { test, expect } from '@playwright/test';
import { diffFields, missingLocales, proxyWarnings, type BuilderField } from '@/lib/forms/builderRule';

// #1802 — what the form builder tells an admin: missing languages (a publish
// refusal), protected-characteristic proxies (a warning, never a block) and
// what a draft changes against the live version. Browserless.

const L = (en: string) => ({ en, tr: `${en}-tr`, de: `${en}-de` });
const field = (over: Partial<BuilderField> = {}): BuilderField => ({ key: 'track', type: 'SELECT', labels: L('Track'), options: [{ value: 'web', labels: L('Web') }], ...over });

test('a live field must read in every language — label, options and help text', { tag: '@smoke' }, async () => {
  expect(missingLocales([field()])).toEqual([]);
  expect(missingLocales([field({ labels: { en: 'Track' } })])).toEqual([{ key: 'track', locales: ['tr', 'de'] }]);
  expect(missingLocales([field({ options: [{ value: 'web', labels: { en: 'Web', tr: 'Web' } }] })])).toEqual([{ key: 'track', locales: ['de'] }]);
  // Help text is optional — but once written, it is written in every language.
  expect(missingLocales([field({ helpText: { en: 'Pick one' } })])).toEqual([{ key: 'track', locales: ['tr', 'de'] }]);
  expect(missingLocales([field({ labels: { en: ' ', tr: 'x', de: 'y' } })])).toEqual([{ key: 'track', locales: ['en'] }]);
  // An archived field is no longer asked: nothing to translate.
  expect(missingLocales([field({ labels: { en: 'Old' }, archived: true })])).toEqual([]);
});

test('protected-characteristic proxies are flagged by key or by label, in EN/TR/DE', { tag: '@smoke' }, async () => {
  expect(proxyWarnings({ key: 'birth_date', labels: L('When were you born') })).toEqual(['age']);
  expect(proxyWarnings({ key: 'q1', labels: { tr: 'Cinsiyetiniz' } })).toEqual(['gender']);
  expect(proxyWarnings({ key: 'q2', labels: { de: 'Familienstand' } })).toEqual(['marital']);
  expect(proxyWarnings({ key: 'q3', labels: { en: 'Do you have a DISABILITY?' } })).toEqual(['disability']);
  expect(proxyWarnings({ key: 'religion', labels: null })).toEqual(['religion']);
  expect(proxyWarnings({ key: 'nationality', labels: { tr: 'Uyruğunuz' } })).toEqual(['nationality']);
  // Whole words only, unless the term is a prefix: no false alarm on these.
  expect(proxyWarnings({ key: 'agenda', labels: { en: 'Alternative track for the agency' } })).toEqual([]);
  expect(proxyWarnings({ key: 'track', labels: L('Preferred track') })).toEqual([]);
});

test('the publish diff names added, removed and changed fields', { tag: '@smoke' }, async () => {
  const live = [field(), field({ key: 'city', type: 'TEXT', options: null, labels: L('City') })];
  expect(diffFields(null, live)).toEqual([{ key: 'track', change: 'added' }, { key: 'city', change: 'added' }]);
  const draft = [
    field({ key: 'city', type: 'TEXT', options: null, labels: L('Your city'), required: true }),
    field({ key: 'level', type: 'SCALE', options: null, labels: L('Level') }),
  ];
  expect(diffFields(live, draft)).toEqual([
    { key: 'city', change: 'changed', props: ['labels', 'required', 'order'] },
    { key: 'level', change: 'added' },
    { key: 'track', change: 'removed' },
  ]);
  // An archived carry-over reads as removed, never as changed.
  expect(diffFields(live, [...draft, field({ archived: true })]).find((c) => c.key === 'track')).toEqual({ key: 'track', change: 'removed' });
});
