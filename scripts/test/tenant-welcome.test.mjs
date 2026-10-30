// The tenant welcome page's pure rules (#1664): when a welcome exists, and how
// the tenant's body becomes plain-text paragraphs.
// Run: node --test --experimental-strip-types scripts/test/tenant-welcome.test.mjs (part of test:unit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasWelcome, welcomeParagraphs } from '../../src/lib/tenantWelcomeRule.ts';

test('a welcome exists only when the title has content', () => {
  assert.equal(hasWelcome({ welcomeTitle: 'Welcome to Acme mentoring' }), true);
  assert.equal(hasWelcome({ welcomeTitle: '   ' }), false);
  assert.equal(hasWelcome({ welcomeTitle: null }), false);
  assert.equal(hasWelcome(null), false);
});

test('blank lines split paragraphs, single newlines stay line breaks', () => {
  assert.deepEqual(welcomeParagraphs('First line\nsecond line\n\nNew paragraph'), [['First line', 'second line'], ['New paragraph']]);
  assert.deepEqual(welcomeParagraphs('A\r\n\r\nB'), [['A'], ['B']]);
  assert.deepEqual(welcomeParagraphs('\n\n  \nOnly\n\n\n\n'), [['Only']]);
  assert.deepEqual(welcomeParagraphs(''), []);
  assert.deepEqual(welcomeParagraphs(null), []);
});

test('markup is kept as text for React to escape, never interpreted', () => {
  assert.deepEqual(welcomeParagraphs('<script>alert(1)</script>'), [['<script>alert(1)</script>']]);
});
