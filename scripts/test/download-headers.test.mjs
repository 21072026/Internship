// A stored upload's name goes into Content-Disposition (src/lib/download.ts).
// The value must be a byte string a real Headers object accepts, whatever the
// name holds: a Turkish CV name ("ş" = U+015F) used to 500 the download once
// Next 15.5.29 stopped smoothing non-Latin-1 header values over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDisposition, downloadHeaders } from '../../src/lib/download.ts';

const NAMES = [
  'özgeçmiş.pdf',
  'öz"geçmiş\r\nX-Injected: 1.pdf',
  'Lebenslauf Müller – final.docx',
  'резюме.pdf',
  '履歴書.pdf',
  "it's (final) *v2*.pdf",
  '',
  ';;;',
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
