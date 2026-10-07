// Thread catch-up / suggested reply (#2048) — transcript, language, tones. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, languageName, replyLocale, REPLY_TONES } from '../../src/lib/threadAiRules.ts';

const T0 = Date.UTC(2026, 9, 1, 9, 0);
const msg = (i, sender, body) => ({ id: `m${i}`, senderId: sender, body, createdAt: new Date(T0 + i * 60_000) });
const names = { a: 'Ada', b: 'Ben' };

test('oldest first, named, dated, and an attachment-only line is kept', () => {
  const newestFirst = [msg(2, 'a', ''), msg(1, 'b', 'Sure,\n  Friday works'), msg(0, 'a', 'Can we meet?')];
  assert.equal(
    buildTranscript(newestFirst, (id) => names[id]),
    '2026-10-01 09:00 · Ada: Can we meet?\n2026-10-01 09:01 · Ben: Sure, Friday works\n2026-10-01 09:02 · Ada: [attachment]',
  );
});

test('over budget, the newest lines survive and the oldest go', () => {
  const newestFirst = Array.from({ length: 50 }, (_, i) => msg(49 - i, 'a', `line ${49 - i} ${'x'.repeat(40)}`));
  const out = buildTranscript(newestFirst, (id) => names[id], 300);
  assert.ok(out.length <= 300, String(out.length));
  assert.ok(out.endsWith(`line 49 ${'x'.repeat(40)}`));
  assert.ok(!out.includes('line 0 '));
});

test('a single line longer than the budget is cut, not dropped', () => {
  assert.equal(buildTranscript([msg(0, 'a', 'y'.repeat(500))], (id) => names[id], 100).length, 100);
});

test('the reply is written in the one recipient’s language, else the author’s', () => {
  assert.equal(replyLocale([{ preferredLanguage: 'de' }], 'tr'), 'de');
  assert.equal(replyLocale([{ preferredLanguage: null }], 'tr'), 'tr');
  assert.equal(replyLocale([{ preferredLanguage: 'de' }, { preferredLanguage: 'en' }], 'tr'), 'tr');
  assert.equal(languageName('de'), 'German');
  assert.equal(languageName('tr-TR'), 'Turkish');
  assert.equal(languageName('xx'), 'English');
});

test('three tones, no more', () => {
  assert.deepEqual([...REPLY_TONES], ['brief', 'warm', 'formal']);
});
