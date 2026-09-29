import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanReferrer,
  readInquiryAttribution,
  utmFromSearch,
  UTM_VALUE_MAX,
  REFERRER_MAX,
} from '../../src/lib/inquiryAttribution.ts';

// Where a public demo request came from (#2569): every value is from an
// unauthenticated browser, so the cleaning rules are pinned here.

test('utm values are trimmed, stripped of control characters and capped; empty is absent', () => {
  const a = readInquiryAttribution(
    { utm: { source: '  linkedin ', medium: '\u0000cpc\n', campaign: 'x'.repeat(400), term: '   ', content: 42 } },
    'marketing.example',
  );
  assert.equal(a.utmSource, 'linkedin');
  assert.equal(a.utmMedium, 'cpc');
  assert.equal(a.utmCampaign?.length, UTM_VALUE_MAX);
  assert.equal(a.utmTerm, null);
  assert.equal(a.utmContent, null);
});

test('no body → every column null', () => {
  assert.deepEqual(readInquiryAttribution({}, null), {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    referrer: null,
  });
});

test('the referrer keeps origin + path only — the query string and fragment never reach the row', () => {
  assert.equal(
    cleanReferrer('https://www.google.com/search?q=alice%40example.com#x', 'marketing.example'),
    'https://www.google.com/search',
  );
  assert.equal(cleanReferrer('https://news.example/', null), 'https://news.example');
});

test('a referrer that is not absolute http(s), or is our own host, is dropped', () => {
  for (const bad of ['javascript:alert(1)', 'ftp://x.example/a', '/relative', 'not a url', '', 7, null]) {
    assert.equal(cleanReferrer(bad, null), null, String(bad));
  }
  assert.equal(cleanReferrer('https://Marketing.Example/features', 'marketing.example'), null);
});

test('a very long referrer path is capped', () => {
  const r = cleanReferrer(`https://a.example/${'p'.repeat(2000)}`, null);
  assert.equal(r?.length, REFERRER_MAX);
});

test('utmFromSearch reads only utm_* parameters', () => {
  assert.deepEqual(utmFromSearch('?utm_source=newsletter&utm_campaign=autumn&ref=zzz&utm_medium='), {
    source: 'newsletter',
    campaign: 'autumn',
  });
  assert.deepEqual(utmFromSearch(''), {});
});
