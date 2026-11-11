// `z.email()` / `z.url()` / `z.iso.datetime()` accept exactly what the
// deprecated `z.string().email()` / `.url()` / `.datetime()` accepted (#3568).
//
// Part 3 of the zod 4 cleanup rewrote 83 schemas from the deprecated method
// form to the top-level constructor, and ONLY where the format check came first
// (`z.string().email(`). A chain such as `z.string().trim().email()` was left
// alone on purpose: the constructor runs its format check before any later
// `.trim()`, so `z.email().trim()` refuses ' a@b.co ' that the old chain
// accepted, and `.min().email()` reports its issues in a different order.
// Nor was a call with its own message (`z.string().email('Invalid email')`):
// the constructor applies that message to a non-string input too, where the
// old chain answered with the string type error. The last two tests pin both
// differences, so nobody "finishes" the migration by hand.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const EMAILS = ['a@b.co', 'a.b+c@x.example', 'user@localhost', 'a@b', '"q"@x.com', 'a..b@x.com', 'ä@x.de', 'a@ä.de',
  'a@b.c', 'a@-x.com', 'x@[1.2.3.4]', 'A@B.COM', ' a@b.co', 'a@b.co ', 'a@b_c.com', 'a@sub.b.co.uk', '', 5, null];
const URLS = ['https://x.example', 'http://localhost:3000/a?b#c', 'ftp://x', 'mailto:a@b', 'javascript:alert(1)',
  'x.example', 'https://', 'http://ä.de', '//x.com', 'https://user:pw@x.com', 'file:///etc/passwd', '', 5];
const DATETIMES = ['2026-11-11T10:00:00Z', '2026-11-11T10:00:00.123Z', '2026-11-11T10:00:00+02:00', '2026-11-11T10:00Z',
  '2026-11-11', '2026-11-11T10:00:00', '2026-13-01T00:00:00Z', '2026-11-11 10:00:00Z', '2026-11-11T24:00:00Z', 5];

function same(name, legacy, current, inputs) {
  for (const x of inputs) {
    const a = legacy.safeParse(x);
    const b = current.safeParse(x);
    assert.equal(b.success, a.success, `${name}: ${JSON.stringify(x)}`);
    if (!a.success) {
      assert.deepEqual(b.error.issues.map((i) => [i.code, i.message]), a.error.issues.map((i) => [i.code, i.message]), `${name}: ${JSON.stringify(x)}`);
    }
  }
}

test('z.email() accepts and refuses what z.string().email() did', () => {
  same('email', z.string().email(), z.email(), EMAILS);
});

test('z.url() accepts and refuses what z.string().url() did', () => {
  same('url', z.string().url(), z.url(), URLS);
});

test('z.iso.datetime() accepts and refuses what z.string().datetime() did', () => {
  same('datetime', z.string().datetime(), z.iso.datetime(), DATETIMES);
  same('datetime offset', z.string().datetime({ offset: true }), z.iso.datetime({ offset: true }), DATETIMES);
});

test('a format check after .trim() is NOT the constructor form — those chains stay as they are', () => {
  assert.equal(z.string().trim().email().safeParse(' a@b.co ').success, true);
  assert.equal(z.email().trim().safeParse(' a@b.co ').success, false);
});

test('a custom message on the constructor also covers the type error — those calls stay as they are', () => {
  assert.notEqual(z.string().email('Invalid email').safeParse(5).error.issues[0].message, 'Invalid email');
  assert.equal(z.email('Invalid email').safeParse(5).error.issues[0].message, 'Invalid email');
});
