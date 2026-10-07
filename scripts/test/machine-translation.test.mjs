// Machine-translation assist (#2055): only empty locales are filled, a filled
// one is never overwritten, machine locales are marked until edited/confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { emptyLocales, pickSource, mergeMachine, normalizeMachineList, afterEdit } = await import('../../src/lib/machineTranslation.ts');

test('the empty locales are the only ones a fill may write', () => {
  assert.deepEqual(emptyLocales({ en: 'Hi', tr: '  ' }), ['tr', 'de']);
  assert.deepEqual(emptyLocales({ en: 'a', tr: 'b', de: 'c' }), []);
});

test('the source is the writer’s own locale, then the default, then any filled one', () => {
  assert.deepEqual(pickSource({ en: 'Hello', de: 'Hallo' }, 'de'), { locale: 'de', text: 'Hallo' });
  assert.deepEqual(pickSource({ en: ' Hello ', de: 'Hallo' }, 'tr'), { locale: 'en', text: 'Hello' });
  assert.deepEqual(pickSource({ tr: 'Merhaba' }, null), { locale: 'tr', text: 'Merhaba' });
  assert.equal(pickSource({}, 'en'), null);
});

test('a machine translation fills empty locales only — a human translation is never overwritten, on any run', () => {
  const human = { en: 'Update your CV', de: 'Lebenslauf aktualisieren (von Hand)' };
  const first = mergeMachine(human, { tr: 'CV’ni güncelle', de: 'MACHINE OVERWRITE', en: 'MACHINE' }, []);
  assert.deepEqual(first.map, { en: 'Update your CV', de: 'Lebenslauf aktualisieren (von Hand)', tr: 'CV’ni güncelle' });
  assert.deepEqual(first.machineTranslated, ['tr']);
  // Re-run: everything is filled, nothing changes, the mark stays.
  const again = mergeMachine(first.map, { tr: 'something else', de: 'x' }, first.machineTranslated);
  assert.deepEqual(again, first);
});

test('the stored mark is reduced to known, filled locales', () => {
  assert.deepEqual(normalizeMachineList(['de', 'xx', 'tr', 'tr'], { de: 'Hallo', tr: '' }), ['de']);
  assert.deepEqual(normalizeMachineList('de', { de: 'Hallo' }), []);
  assert.deepEqual(normalizeMachineList(null, {}), []);
});

test('editing a machine locale makes it the admin’s; untouched ones stay marked', () => {
  const prev = { en: 'Hi', tr: 'Selam', de: 'Hallo' };
  assert.deepEqual(afterEdit(prev, { ...prev, tr: 'Merhaba' }, ['tr', 'de']), ['de']);
  assert.deepEqual(afterEdit(prev, { ...prev, de: '' }, ['de']), []);
  assert.deepEqual(afterEdit(prev, { ...prev, en: 'Hello' }, ['tr']), ['tr']);
});
