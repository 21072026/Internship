// Unit tests for renderNotification (#921) — pure node, no browser/page.
// Playwright resolves the tsconfig @/ paths, which node --test cannot.
import { test, expect } from '@playwright/test';
import { renderNotification } from '@/lib/notificationText';
import { getDictionary } from '@/i18n/dictionaries';

const en = getDictionary('en');
const tr = getDictionary('tr');
const de = getDictionary('de');

test.describe('renderNotification', () => {
  test('known type renders the localized template with params', { tag: '@smoke' }, () => {
    const n = { type: 'message.new', params: { from: 'Aylin' } };
    expect(renderNotification(n, en, 'en')).toBe('New message from Aylin.');
    expect(renderNotification(n, tr, 'tr')).toContain('Aylin');
    expect(renderNotification(n, de, 'de')).toContain('Aylin');
    expect(renderNotification(n, tr, 'tr')).not.toBe(renderNotification(n, en, 'en'));
  });

  test('legacy row: stored text wins even when a template exists', { tag: '@smoke' }, () => {
    const n = { type: 'message.new', text: 'Old stored sentence.', params: { from: 'X' } };
    expect(renderNotification(n, tr, 'tr')).toBe('Old stored sentence.');
  });

  test('unknown type without text falls back to the neutral string', { tag: '@smoke' }, () => {
    const n = { type: 'something.unknown', params: {} };
    expect(renderNotification(n, en, 'en')).toBe(en.notifications.generic);
    expect(renderNotification(n, tr, 'tr')).toBe(tr.notifications.generic);
  });

  test('missing or malformed params never crash', () => {
    expect(typeof renderNotification({ type: 'message.new' }, en, 'en')).toBe('string');
    expect(typeof renderNotification({ type: 'message.new', params: 'garbage' }, en, 'en')).toBe('string');
    expect(typeof renderNotification({ type: 'message.new', params: [1, 2] }, en, 'en')).toBe('string');
  });

  test('stage change resolves built-in stage keys to localized labels', { tag: '@smoke' }, () => {
    const n = { type: 'stage.changed', params: { from: 'APPLICATION_100', to: 'INTERVIEW_PENDING_250' } };
    const outTr = renderNotification(n, tr, 'tr');
    expect(outTr).toContain('100 · İlk temas');
    expect(outTr).toContain('250 · Görüşülecek');
    expect(renderNotification(n, en, 'en')).toContain('100 · First contact');
  });

  test('stage change keeps tenant labels for custom stage keys', () => {
    const n = {
      type: 'stage.changed',
      params: { from: 'CUSTOM_1', to: 'CUSTOM_2', fromLabel: 'Özel Aşama', toLabel: 'Sözleşme' },
    };
    const out = renderNotification(n, en, 'en');
    expect(out).toContain('Özel Aşama');
    expect(out).toContain('Sözleşme');
  });

  test('every locale has a template for every event key (parity beyond check:i18n)', () => {
    const keys = Object.keys(en.notifications.events);
    for (const dict of [tr, de]) {
      for (const key of keys) {
        expect(dict.notifications.events[key as keyof typeof dict.notifications.events], key).toBeTruthy();
      }
    }
  });
});
