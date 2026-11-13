// A stored upload's name goes into Content-Disposition (src/lib/download.ts).
// The value must be a byte string a real Headers object accepts, whatever the
// name holds: a Turkish CV name ("ş" = U+015F) used to 500 the download once
// Next 15.5.29 stopped smoothing non-Latin-1 header values over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// download.ts imports its sibling extensionless ('./transliterate'), like the
// app does; this hook resolves that to the .ts file under plain node.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { contentDisposition, downloadHeaders } = await import('../../src/lib/download.ts');

const NAMES = [
  'özgeçmiş.pdf',
  'öz"geçmiş\r\nX-Injected: 1.pdf',
  'Lebenslauf Müller – final.docx',
  'резюме.pdf',
  '履歴書.pdf',
  "it's (final) *v2*.pdf",
  '',
  ';;;',
  'a\uff02b.pdf', // fullwidth quotation mark: NFKD folds it to a real "
  'report\uff3c.pdf', // fullwidth reverse solidus: folds to \\
  'ışık.pdf',
  // 99 letters then an emoji: a UTF-16 cut at 100 would split the pair.
  `${'a'.repeat(99)}\u{1F600}tail.pdf`,
];

for (const name of NAMES) {
  test(`header-safe for ${JSON.stringify(name)}`, () => {
    const h = downloadHeaders({ filename: name, contentType: 'application/pdf', size: 1 });
    // The very thing that threw: a real Headers / Response accepts the value.
    assert.doesNotThrow(() => new Headers(h));
    assert.doesNotThrow(() => new Response('x', { headers: h }));
    const cd = h['Content-Disposition'];
    assert.doesNotMatch(cd, /[\r\n]/);
    // The plain fallback is printable ASCII only.
    const plain = /filename="([^"]*)"/.exec(cd)?.[1];
    assert.ok(plain, cd);
    assert.match(plain, /^[\x20-\x7e]+$/);
    // filename* is a valid RFC 5987 ext-value (attr-char or %XX only).
    const ext = /filename\*=UTF-8''(.*)$/.exec(cd)?.[1];
    assert.ok(ext !== undefined, cd);
    assert.match(ext, /^(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-F]{2})+$/);
    // The whole value is exactly disposition + the two parameters: nothing in
    // the fallback may close the quoted-string early or add a parameter.
    assert.match(cd, /^(attachment|inline); filename="[^"\\]*"; filename\*=UTF-8''[^;\s]+$/);
  });
}

test('the original name survives through filename*', () => {
  const cd = contentDisposition('özgeçmiş.pdf');
  assert.equal(decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(cd)[1]), 'özgeçmiş.pdf');
  assert.match(cd, /^attachment; filename="ozgecmis\.pdf";/);
});

test('header-splitting and quote characters never reach the value', () => {
  const cd = contentDisposition('a"b\r\nX-Injected: 1.pdf', 'inline');
  assert.match(cd, /^inline; /);
  assert.doesNotMatch(cd, /"a"/);
  assert.equal(decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(cd)[1]), 'abX-Injected: 1.pdf');
});

test('the Turkish dotless ı is transliterated, not replaced', () => {
  assert.match(contentDisposition('ışık.pdf'), /^attachment; filename="isik\.pdf";/);
});

test('a name longer than the cap is cut by code point, never mid-emoji', () => {
  const cd = contentDisposition(`${'a'.repeat(99)}\u{1F600}tail.pdf`);
  const ext = decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(cd)[1]);
  assert.equal(Array.from(ext).length, 100);
  assert.ok(ext.endsWith('\u{1F600}'));
});
