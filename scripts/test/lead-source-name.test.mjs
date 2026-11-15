import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACQUISITION_SOURCES,
  SOURCE_NAME_MAX,
  leadSourceName,
  referrerHost,
  typedSourceName,
} from '../../src/lib/leadSourceName.ts';

// Lead-source attribution (#2570): which Source a lead lands on, from its
// affiliate reference, its UTM parameters and its self-reported channel.

test('each of the six acquisition_source values maps to its own channel Source', () => {
  assert.deepEqual([...ACQUISITION_SOURCES], [
    'search_engine',
    'social_media',
    'youtube',
    'referral',
    'advertisement',
    'other',
  ]);
  for (const value of ACQUISITION_SOURCES) {
    assert.deepEqual(leadSourceName({ acquisitionSource: value }), { kind: 'channel', name: `channel:${value}` });
  }
  // Case and padding are not a different channel.
  assert.deepEqual(leadSourceName({ acquisitionSource: '  YouTube ' }), { kind: 'channel', name: 'channel:youtube' });
});

test('an acquisition_source outside the six is unknown, not folded into "other"', () => {
  assert.deepEqual(leadSourceName({ acquisitionSource: 'tv' }), { kind: 'unknown' });
  assert.deepEqual(leadSourceName({ acquisitionSource: '' }), { kind: 'unknown' });
});

test('nothing at all is unknown (no Source row — the report counts it as unsourced)', () => {
  assert.deepEqual(leadSourceName({}), { kind: 'unknown' });
  assert.deepEqual(
    leadSourceName({ reference: '  ', utmSource: '\u0000', utmMedium: 'cpc', acquisitionSource: null }),
    { kind: 'unknown' },
  );
});

test('an affiliate reference wins over a UTM and over the channel, and keeps its case', () => {
  assert.deepEqual(
    leadSourceName({ reference: 'PARTNER-42', utmSource: 'google', utmMedium: 'cpc', acquisitionSource: 'referral' }),
    { kind: 'affiliate', name: 'affiliate:PARTNER-42' },
  );
  assert.deepEqual(leadSourceName({ reference: ' abc ' }), { kind: 'affiliate', name: 'affiliate:abc' });
});

test('utm_source wins over the self-reported channel', () => {
  assert.deepEqual(
    leadSourceName({ utmSource: 'newsletter', acquisitionSource: 'search_engine' }),
    { kind: 'utm', name: 'utm:newsletter/-/-' },
  );
});

test('UTM combinations: medium and campaign are in the name, lower-cased; a missing one is "-"', () => {
  const cases = [
    [{ utmSource: 'Google', utmMedium: 'CPC', utmCampaign: 'Spring-2026' }, 'utm:google/cpc/spring-2026'],
    [{ utmSource: 'google', utmMedium: 'organic' }, 'utm:google/organic/-'],
    [{ utmSource: 'google', utmCampaign: 'spring' }, 'utm:google/-/spring'],
    [{ utmSource: 'linkedin', utmMedium: 'social', utmCampaign: 'autumn-2026' }, 'utm:linkedin/social/autumn-2026'],
  ];
  for (const [input, name] of cases) assert.deepEqual(leadSourceName(input), { kind: 'utm', name });
  // Paid and organic from the same engine are two sources — the budget question.
  assert.notEqual(
    leadSourceName({ utmSource: 'google', utmMedium: 'cpc' }).name,
    leadSourceName({ utmSource: 'google', utmMedium: 'organic' }).name,
  );
});

test('a medium or campaign without utm_source is not a source', () => {
  assert.deepEqual(leadSourceName({ utmMedium: 'cpc', utmCampaign: 'x' }), { kind: 'unknown' });
  assert.deepEqual(
    leadSourceName({ utmMedium: 'cpc', acquisitionSource: 'advertisement' }),
    { kind: 'channel', name: 'channel:advertisement' },
  );
});

test('a "/" inside a value cannot fake a segment; control characters and whitespace runs are cleaned', () => {
  assert.deepEqual(
    leadSourceName({ utmSource: 'google/cpc', utmCampaign: 'a\n  b' }),
    { kind: 'utm', name: 'utm:google-cpc/-/a b' },
  );
});

test('every generated name fits SOURCE_NAME_MAX', () => {
  const long = 'x'.repeat(500);
  for (const input of [
    { reference: long },
    { utmSource: long, utmMedium: long, utmCampaign: long },
    { acquisitionSource: long },
  ]) {
    const r = leadSourceName(input);
    if (r.kind !== 'unknown') assert.ok(r.name.length <= SOURCE_NAME_MAX, `${r.name.length} > ${SOURCE_NAME_MAX}`);
  }
});

test('a typed source is kept as written, cleaned and capped; blank is null', () => {
  assert.equal(typedSourceName('  Messe  Berlin '), 'Messe Berlin');
  assert.equal(typedSourceName('Partner/Uni'), 'Partner/Uni');
  assert.equal(typedSourceName('   '), null);
  assert.equal(typedSourceName(undefined), null);
  assert.equal(typedSourceName('y'.repeat(300)).length, SOURCE_NAME_MAX);
});

// #2578: the referrer is a source too, between the UTM and the vendor.
// THE PRIORITY: affiliate > utm_source > ref:<host> > vendor > acquisition_source > unknown.
const SERVED = ['crm.example', 'marketing.example'];

test('a referrer without utm_source becomes ref:<host> — host only, lower-cased, no port, path or query', () => {
  assert.deepEqual(
    leadSourceName({ referrer: 'https://Blog.Partner.example:8443/posts/why-crm', servedHosts: SERVED }),
    { kind: 'referrer', name: 'ref:blog.partner.example' },
  );
  // Two pages of one site are one Source.
  assert.equal(
    leadSourceName({ referrer: 'https://news.example/a', servedHosts: SERVED }).name,
    leadSourceName({ referrer: 'https://news.example/b', servedHosts: SERVED }).name,
  );
  assert.equal(referrerHost('https://news.example./x?q=1#f'), 'news.example');
});

test('utm_source keeps the UTM Source when a referrer is there too', () => {
  assert.deepEqual(
    leadSourceName({ utmSource: 'newsletter', utmMedium: 'email', referrer: 'https://mail.example/', servedHosts: SERVED }),
    { kind: 'utm', name: 'utm:newsletter/email/-' },
  );
});

test('an affiliate code beats both the UTM and the referrer', () => {
  assert.deepEqual(
    leadSourceName({ reference: 'PARTNER-7', utmSource: 'google', referrer: 'https://news.example/', servedHosts: SERVED }),
    { kind: 'affiliate', name: 'affiliate:PARTNER-7' },
  );
});

test('a referrer beats the vendor and the self-reported channel', () => {
  assert.deepEqual(
    leadSourceName({ referrer: 'https://news.example/', vendor: { name: 'klaviyo', detail: 'form' }, acquisitionSource: 'other' }),
    { kind: 'referrer', name: 'ref:news.example' },
  );
});

test('a referrer on one of our served hosts, an empty or an unparseable one is not a source', () => {
  for (const referrer of ['https://MARKETING.example/pricing', 'https://crm.example', '', '   ', 'not a url', 'ftp://files.example/x', null]) {
    assert.deepEqual(leadSourceName({ referrer, servedHosts: SERVED }), { kind: 'unknown' }, String(referrer));
  }
  // …and falls through to what is left, rather than stopping there.
  assert.deepEqual(
    leadSourceName({ referrer: 'https://crm.example/', acquisitionSource: 'youtube', servedHosts: SERVED }),
    { kind: 'channel', name: 'channel:youtube' },
  );
});

test('the ref: name stays within SOURCE_NAME_MAX', () => {
  const long = `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example/`;
  const r = leadSourceName({ referrer: long });
  assert.equal(r.kind, 'referrer');
  assert.ok(r.name.length <= SOURCE_NAME_MAX);
});
