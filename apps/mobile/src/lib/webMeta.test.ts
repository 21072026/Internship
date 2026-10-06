import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssColorToHex, isDarkColor, pageTitle, parsePageMeta } from './webMeta.ts';
import { menuIcon, menuItems } from './menu.ts';

test('page title loses the product suffix the site template adds', () => {
  assert.equal(pageTitle('Calendar · Internship CRM', 'Internship CRM'), 'Calendar');
  assert.equal(pageTitle('Internship CRM', 'Internship CRM'), '');
  // The site's default title is not a page name: keep the menu label instead.
  assert.equal(pageTitle('Internship CRM — mentoring from first contact to first job', 'Internship CRM'), '');
  assert.equal(pageTitle('Board · SaleVali', 'SaleVali'), 'Board');
});

test('page colours: rgb → hex, transparent → none, dark detection', () => {
  assert.equal(cssColorToHex('rgb(3, 7, 18)'), '#030712');
  assert.equal(cssColorToHex('rgba(255, 255, 255, 1)'), '#ffffff');
  assert.equal(cssColorToHex('rgba(0, 0, 0, 0)'), null);
  assert.equal(cssColorToHex(undefined), null);
  assert.equal(isDarkColor('#030712'), true);
  assert.equal(isDarkColor('#f9fafb'), false);
});

test('only well-formed meta reports are accepted', () => {
  assert.deepEqual(parsePageMeta(JSON.stringify({ type: 'meta', title: 'X', dark: true, bg: 'rgb(17, 24, 39)' })), {
    title: 'X', dark: true, bg: '#111827',
  });
  assert.equal(parsePageMeta('not json'), null);
  assert.equal(parsePageMeta(JSON.stringify({ type: 'other', title: 'X' })), null);
});

test('the native menu skips what is already a tab and anything that is not a path', () => {
  const items = menuItems([
    { key: 'dashboard', href: '/portal', label: 'Dashboard' },
    { key: 'messages', href: '/messages', label: 'Messages' },
    { key: 'todos', href: '/todos', label: 'To-dos' },
    { key: 'x', href: 'https://evil.example', label: 'X' },
  ]);
  assert.deepEqual(items.map((i) => i.href), ['/portal']);
  assert.equal(menuIcon('dashboard'), 'grid');
  assert.equal(menuIcon('somethingNew'), 'ellipse-outline');
});

test('every web sidebar key has an icon in the app', async () => {
  const { readFileSync } = await import('node:fs');
  const web = readFileSync(new URL('../../../../src/lib/navLinks.ts', import.meta.url), 'utf8');
  const keys = [...web.matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 20);
  const missing = keys.filter((k) => menuIcon(k) === 'ellipse-outline');
  assert.deepEqual(missing, [], `add an Ionicons glyph in src/lib/menu.ts for: ${missing.join(', ')}`);
});
