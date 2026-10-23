// Unit tests for the Klaviyo pull connector's pure rules (docs/integrations/klaviyo.md):
// the wire format we send, the profile → lead mapping, the cursor and the
// backoff. Run: node --test --experimental-strip-types scripts/test/klaviyo-rule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KLAVIYO_ATTRIBUTES_MAX,
  KLAVIYO_MAX_ATTEMPTS,
  KLAVIYO_REQUIRED_SCOPES,
  isEnvKeyRef,
  resolveKlaviyoRevision,
  retryDelayMs,
  KLAVIYO_ERROR_RETRY_QUERIES,
  KLAVIYO_PROPERTY_LIMIT,
  KLAVIYO_REVISION,
  KLAVIYO_SINCE_OVERLAP_MS,
  afterPage,
  beginQuery,
  boundedAttributes,
  checkKlaviyoKey,
  consentSummary,
  disambiguatedAccountName,
  errorCodeForStatus,
  isDue,
  keyLast4,
  klaviyoHeaders,
  mapProfile,
  nextAttemptDelayMs,
  nextPageCursor,
  profileEmail,
  profileInfo,
  profilesPath,
  restartQuery,
  retryAfterMs,
  vendorDetail,
} from '../../src/lib/klaviyoRule.ts';
import { leadSourceName } from '../../src/lib/leadSourceName.ts';
import { register } from 'node:module';

// marketingImport.ts imports `./importPreview` extensionless — the same
// resolver hook scripts/test/marketing-import.test.mjs installs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { manualAccountsTable } = await import('../../src/lib/marketingImport.ts');

const MIN = 60 * 1000;

test('a private key is accepted; the public site id and junk are refused before any request', () => {
  assert.deepEqual(checkKlaviyoKey('  pk_abcdef0123456789abcdef  '), { ok: true, key: 'pk_abcdef0123456789abcdef' });
  assert.deepEqual(checkKlaviyoKey('AbC123'), { ok: false, code: 'public_key' });
  assert.deepEqual(checkKlaviyoKey(''), { ok: false, code: 'empty' });
  assert.deepEqual(checkKlaviyoKey(undefined), { ok: false, code: 'empty' });
  assert.deepEqual(checkKlaviyoKey('sk_live_whatever'), { ok: false, code: 'malformed' });
  assert.equal(keyLast4('pk_abcdef0123456789wxyz'), 'wxyz');
});

test('every request carries the private-key header and the pinned revision', () => {
  const h = klaviyoHeaders('pk_test1234567890');
  assert.equal(h.Authorization, 'Klaviyo-API-Key pk_test1234567890');
  assert.equal(h.revision, KLAVIYO_REVISION);
  assert.match(KLAVIYO_REVISION, /^\d{4}-\d{2}-\d{2}$/);
});

test('the revision: a GA date from the environment, else the default; never a beta one', () => {
  assert.equal(KLAVIYO_REVISION, '2026-10-15');
  assert.deepEqual(resolveKlaviyoRevision(undefined), { revision: KLAVIYO_REVISION, ok: true });
  assert.deepEqual(resolveKlaviyoRevision(' 2026-07-15 '), { revision: '2026-07-15', ok: true });
  assert.deepEqual(resolveKlaviyoRevision('2026-10-15.pre'), { revision: KLAVIYO_REVISION, ok: false });
  assert.deepEqual(resolveKlaviyoRevision('2024-10-15'), { revision: KLAVIYO_REVISION, ok: false });
  assert.deepEqual(resolveKlaviyoRevision('2026-13-45'), { revision: KLAVIYO_REVISION, ok: false });
  assert.equal(klaviyoHeaders('pk_test1234567890', '2026-07-15').revision, '2026-07-15');
});

test('scopes: read-only, one per resource, and never a write scope', () => {
  assert.ok(KLAVIYO_REQUIRED_SCOPES.includes('profiles:read'));
  for (const s of ['lists', 'segments', 'metrics', 'events', 'campaigns', 'flows']) assert.ok(KLAVIYO_REQUIRED_SCOPES.includes(`${s}:read`));
  assert.ok(KLAVIYO_REQUIRED_SCOPES.every((s) => s.endsWith(':read')));
});

test('retry: a short Retry-After is waited out, a long one is the run\'s; 5xx doubles with jitter; 4xx never retries', () => {
  const mid = () => 0.5;
  assert.equal(retryDelayMs(1, { status: 429, retryAfterMs: 2000 }, mid), 2000);
  assert.equal(retryDelayMs(1, { status: 429, retryAfterMs: 0 }, mid), 250);
  assert.equal(retryDelayMs(1, { status: 429, retryAfterMs: 60_000 }, mid), null);
  assert.equal(retryDelayMs(1, { status: 429, retryAfterMs: null }, mid), 1000);
  assert.equal(retryDelayMs(2, { status: 429, retryAfterMs: null }, mid), null);
  assert.deepEqual([1, 2, 3].map((n) => retryDelayMs(n, { status: 502 }, mid)), [1000, 2000, 4000]);
  assert.equal(retryDelayMs(1, { status: 502 }, () => 0), 750);
  assert.equal(retryDelayMs(1, { status: 502 }, () => 1), 1250);
  assert.equal(retryDelayMs(KLAVIYO_MAX_ATTEMPTS, { status: 502 }, mid), null);
  assert.equal(retryDelayMs(1, {}, mid), 1000); // network
  for (const status of [400, 401, 403, 404]) assert.equal(retryDelayMs(1, { status }, mid), null);
});

test('an environment key is referenced by its fingerprint, never sealed', () => {
  assert.equal(isEnvKeyRef('env:0123abcd'), true);
  assert.equal(isEnvKeyRef('v1.abc.def.ghi'), false);
  assert.equal(isEnvKeyRef(null), false);
});

test('the profiles query: page size 100, sorted by updated, subscriptions, updated filter, cursor', () => {
  const first = new URL(`https://x.test${profilesPath({ since: null })}`);
  assert.equal(first.pathname, '/api/profiles');
  assert.equal(first.searchParams.get('page[size]'), '100');
  assert.equal(first.searchParams.get('sort'), 'updated');
  assert.equal(first.searchParams.get('additional-fields[profile]'), 'subscriptions');
  assert.equal(first.searchParams.get('filter'), null, 'the first import reads everything');
  const next = new URL(`https://x.test${profilesPath({ since: new Date('2026-10-01T10:00:00.123Z'), cursor: 'abc', pageSize: 500 })}`);
  assert.equal(next.searchParams.get('filter'), 'greater-than(updated,2026-10-01T10:00:00Z)');
  assert.equal(next.searchParams.get('page[cursor]'), 'abc');
  assert.equal(next.searchParams.get('page[size]'), '100', 'never above the provider maximum');
});

test('only the page cursor of links.next is kept — never the link itself', () => {
  assert.equal(nextPageCursor({ links: { next: 'https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=bmV4dA&sort=updated' } }), 'bmV4dA');
  assert.equal(nextPageCursor({ links: { next: null } }), null);
  assert.equal(nextPageCursor({}), null);
  assert.equal(nextPageCursor(null), null);
});

test('statuses map to codes; Retry-After is read in seconds or as a date', () => {
  assert.equal(errorCodeForStatus(401), 'unauthorized');
  assert.equal(errorCodeForStatus(403), 'forbidden');
  assert.equal(errorCodeForStatus(429), 'rate_limited');
  assert.equal(errorCodeForStatus(400), 'bad_request');
  assert.equal(errorCodeForStatus(503), 'upstream_error');
  assert.equal(retryAfterMs('7'), 7000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('soon'), null);
  const now = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(retryAfterMs('Tue, 20 Oct 2026 10:00:30 GMT', now), 30_000);
});

test('backoff: next tick, then doubling, capped at six hours; a longer Retry-After wins', () => {
  assert.equal(nextAttemptDelayMs(1), 15 * MIN);
  assert.equal(nextAttemptDelayMs(2), 30 * MIN);
  assert.equal(nextAttemptDelayMs(3), 60 * MIN);
  assert.equal(nextAttemptDelayMs(20), 6 * 60 * MIN);
  assert.equal(nextAttemptDelayMs(1, 40 * MIN), 40 * MIN);
  assert.equal(nextAttemptDelayMs(1, 5000), 15 * MIN);
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(isDue(null, now), true);
  assert.equal(isDue(new Date('2026-10-20T09:59:00Z'), now), true);
  assert.equal(isDue(new Date('2026-10-20T10:01:00Z'), now), false);
});

test('cursor: a query walks pages by the provider cursor and the next query starts before this one began', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  const open = beginQuery({ since: null, queryStartedAt: null, pageCursor: null }, now);
  assert.deepEqual(open, { since: null, queryStartedAt: now, pageCursor: null });
  // An open query continues where it stopped, it does not restart.
  assert.equal(beginQuery({ ...open, pageCursor: 'p2' }, new Date('2026-10-20T11:00:00Z')).pageCursor, 'p2');
  const mid = afterPage(open, 'p2');
  assert.equal(mid.queryDone, false);
  assert.equal(mid.cursor.pageCursor, 'p2');
  const done = afterPage(mid.cursor, null);
  assert.equal(done.queryDone, true);
  assert.equal(done.cursor.pageCursor, null);
  assert.equal(done.cursor.queryStartedAt, null);
  assert.equal(done.cursor.since?.getTime(), now.getTime() - KLAVIYO_SINCE_OVERLAP_MS);
  // A stale cursor restarts the open query from its own since — nothing skipped.
  assert.deepEqual(restartQuery({ since: now, queryStartedAt: now, pageCursor: 'stale' }), { since: now, queryStartedAt: now, pageCursor: null });
});

test('cursor: a row that errored is read again by the next query, but a permanent failure does not pin the cursor', () => {
  const t0 = new Date('2026-10-20T10:00:00Z');
  const failedAt = new Date('2026-10-19T08:00:00Z');
  const open = beginQuery({ since: new Date('2026-10-19T00:00:00Z'), queryStartedAt: null, pageCursor: null }, t0);
  // Page 1 had an error; page 2 (the last) none — the floor survives the page.
  const p1 = afterPage(open, 'p2', failedAt);
  assert.equal(p1.cursor.errorFloor?.getTime(), failedAt.getTime());
  // The floor is kept across a stale-cursor restart and an interrupted run.
  assert.equal(restartQuery(p1.cursor).errorFloor?.getTime(), failedAt.getTime());
  assert.equal(beginQuery(p1.cursor, new Date('2026-10-20T10:20:00Z')).errorFloor?.getTime(), failedAt.getTime());
  const closed = afterPage(p1.cursor, null, null);
  assert.equal(closed.queryDone, true);
  // Strictly greater-than on the provider side: start one second before the failed row.
  assert.equal(closed.cursor.since?.getTime(), failedAt.getTime() - 1000);
  assert.equal(closed.cursor.errorFloor, null);
  assert.equal(closed.cursor.errorHolds, 1);

  // The same row keeps failing: held KLAVIYO_ERROR_RETRY_QUERIES times, then released.
  let cursor = closed.cursor;
  for (let i = 1; i < KLAVIYO_ERROR_RETRY_QUERIES; i++) {
    const q = beginQuery(cursor, new Date(t0.getTime() + i * 15 * MIN));
    cursor = afterPage(q, null, failedAt).cursor;
    assert.equal(cursor.since?.getTime(), failedAt.getTime() - 1000);
  }
  assert.equal(cursor.errorHolds, KLAVIYO_ERROR_RETRY_QUERIES);
  const lastStart = new Date(t0.getTime() + 60 * MIN);
  const released = afterPage(beginQuery(cursor, lastStart), null, failedAt).cursor;
  assert.equal(released.since?.getTime(), lastStart.getTime() - KLAVIYO_SINCE_OVERLAP_MS);
  assert.equal(released.errorHolds, 0);

  // A clean query resets the count.
  const clean = afterPage(beginQuery(closed.cursor, lastStart), null, null).cursor;
  assert.equal(clean.errorHolds, 0);
  assert.equal(clean.since?.getTime(), lastStart.getTime() - KLAVIYO_SINCE_OVERLAP_MS);
});

const PROFILE = {
  type: 'profile',
  id: '01KLAVIYOPROFILE0000000001',
  attributes: {
    email: '  Jane.Doe@Acme-Sales.example.test ',
    phone_number: '+4930123456',
    first_name: 'Jane',
    last_name: 'Doe',
    organization: 'Acme Sales GmbH',
    title: 'Head of Ops',
    locale: 'de-DE',
    created: '2026-09-01T08:00:00+00:00',
    updated: '2026-10-01T10:00:00+00:00',
    location: { city: 'Berlin', region: 'BE', country: 'DE', zip: '10115', timezone: 'Europe/Berlin', ip: '203.0.113.9', latitude: 52.5, longitude: 13.4 },
    properties: { plan_interest: 'Pro', initial_utm_source: 'Newsletter', utm_source: 'later', utm_medium: 'Email', seats: 12 },
    subscriptions: {
      email: { marketing: { consent: 'SUBSCRIBED', method: 'KLAVIYO_FORM', method_detail: 'FORM123', consent_timestamp: '2026-09-01T08:00:00+00:00', double_optin: true } },
    },
  },
};

test('a profile maps to a lead: address keyed, names, organization as the account, ISO country', () => {
  const m = mapProfile(PROFILE);
  assert.equal(m.ok, true);
  const l = m.lead;
  assert.equal(l.profileId, '01KLAVIYOPROFILE0000000001');
  assert.equal(l.email, 'jane.doe@acme-sales.example.test');
  assert.equal(l.fullName, 'Jane Doe');
  assert.equal(l.accountName, 'Acme Sales GmbH');
  assert.equal(l.accountNameIsOrganization, true);
  assert.equal(l.phone, '+4930123456');
  assert.equal(l.city, 'Berlin');
  assert.equal(l.country, 'DE');
  assert.equal(l.updatedAt?.toISOString(), '2026-10-01T10:00:00.000Z');
  // First-touch UTM wins over the plain one; the vendor detail is method/form.
  assert.equal(l.sourceInput.utmSource, 'Newsletter');
  assert.equal(l.sourceInput.utmMedium, 'Email');
  assert.equal(l.sourceInput.vendor.detail, 'klaviyo_form/FORM123');
  assert.equal(l.consent.email.consent, 'SUBSCRIBED');
  assert.equal(l.consent.email.doubleOptin, true);
});

test('the kept attributes drop the IP and the coordinates', () => {
  const attrs = JSON.parse(mapProfile(PROFILE).lead.attributesText);
  assert.equal(attrs.title, 'Head of Ops');
  assert.deepEqual(attrs.location, { city: 'Berlin', region: 'BE', country: 'DE', zip: '10115', timezone: 'Europe/Berlin' });
  assert.equal(attrs.properties.plan_interest, 'Pro');
  assert.equal(attrs.properties.seats, 12);
  assert.ok(!JSON.stringify(attrs).includes('203.0.113.9'));
  assert.ok(!('latitude' in attrs.location));
});

test('custom properties are bounded in count and size, and the drop is counted', () => {
  const properties = {};
  for (let i = 0; i < KLAVIYO_PROPERTY_LIMIT + 10; i++) properties[`p${i}`] = 'x'.repeat(2000);
  const out = boundedAttributes({ properties });
  assert.ok(out.length <= KLAVIYO_ATTRIBUTES_MAX);
  const parsed = JSON.parse(out);
  assert.ok(parsed.droppedProperties >= 10);
  for (const v of Object.values(parsed.properties ?? {})) assert.ok(String(v).length <= 500);
});

test('person-only and address-only profiles still become leads; empty ones are refused', () => {
  const person = mapProfile({ id: 'p1', attributes: { email: 'solo@example.test', first_name: 'Solo', last_name: 'Person' } });
  assert.equal(person.lead.accountName, 'Solo Person');
  assert.equal(person.lead.accountNameIsOrganization, false);
  assert.equal(disambiguatedAccountName(person.lead), 'Solo Person (solo@example.test)');
  const addr = mapProfile({ id: 'p2', attributes: { email: 'only@example.test' } });
  assert.equal(addr.lead.accountName, 'only@example.test');
  const sms = mapProfile({ id: 'p3', attributes: { phone_number: '+491701234567' } });
  assert.equal(sms.ok, true);
  assert.equal(sms.lead.email, '');
  assert.equal(mapProfile({ id: 'p4', attributes: {} }).ok, false);
  assert.equal(mapProfile({ attributes: { email: 'x@example.test' } }).ok, false);
  assert.equal(mapProfile({ id: 'p5', type: 'list', attributes: { email: 'x@example.test' } }).ok, false);
});

test('a country that is not ISO alpha-2 is dropped, never guessed', () => {
  assert.equal(mapProfile({ id: 'p', attributes: { email: 'a@example.test', location: { country: 'Germany' } } }).lead.country, '');
});

test('the CRM\'s own stand-in domains are never a person\'s address', () => {
  assert.equal(profileEmail('lead.1234@import.local'), '');
  assert.equal(profileEmail('erased-1@erased.local'), '');
  assert.equal(profileEmail('not an address'), '');
  assert.equal(profileEmail('Ok@Example.Test'), 'ok@example.test');
});

test('a list subscription is shown by the list name the run read', () => {
  const subs = { email: { marketing: { method: 'LIST', method_detail: 'LIST42' } } };
  assert.equal(vendorDetail(subs, new Map([['LIST42', 'Newsletter DE']])), 'list/Newsletter DE');
  assert.equal(vendorDetail(subs, new Map()), 'list/LIST42');
  assert.equal(vendorDetail({}, new Map()), null);
  assert.equal(consentSummary({}), null);
});

test('source: UTM beats the vendor; the vendor beats a self-reported channel; no detail is still the vendor', () => {
  const lead = mapProfile(PROFILE).lead;
  assert.deepEqual(leadSourceName(lead.sourceInput), { kind: 'utm', name: 'utm:newsletter/email/-' });
  assert.deepEqual(
    leadSourceName({ vendor: { name: 'Klaviyo', detail: 'klaviyo_form/Footer signup' }, acquisitionSource: 'youtube' }),
    { kind: 'vendor', name: 'klaviyo:klaviyo_form/Footer signup' },
  );
  assert.deepEqual(leadSourceName({ vendor: { name: 'klaviyo', detail: null } }), { kind: 'vendor', name: 'klaviyo' });
  assert.deepEqual(leadSourceName({ reference: 'AFF1', vendor: { name: 'klaviyo' } }), { kind: 'affiliate', name: 'affiliate:AFF1' });
  const long = leadSourceName({ vendor: { name: 'klaviyo', detail: 'x'.repeat(500) } });
  assert.ok(long.name.length <= 120);
});

test('a stored link reads back for the account screen, whatever text it holds', () => {
  const lead = mapProfile(PROFILE).lead;
  const info = profileInfo({
    provider: 'klaviyo',
    sourceName: 'klaviyo:klaviyo_form/FORM123',
    consent: JSON.stringify(lead.consent),
    attributes: lead.attributesText,
    profileUpdatedAt: lead.updatedAt,
  });
  assert.equal(info.emailConsent, 'SUBSCRIBED · KLAVIYO_FORM · FORM123');
  assert.equal(info.location, 'Berlin, BE, 10115, DE');
  assert.equal(info.jobTitle, 'Head of Ops');
  assert.ok(info.properties.some(([k, v]) => k === 'seats' && v === '12'));
  const broken = profileInfo({ provider: 'klaviyo', sourceName: null, consent: '{not json', attributes: '', profileUpdatedAt: null });
  assert.equal(broken.emailConsent, null);
  assert.deepEqual(broken.properties, []);
});

test('a batch of import rows: one header for the union, blank cells for what a row does not send', () => {
  const table = manualAccountsTable([
    { name: 'Acme Sales', contactEmail: 'a@example.test', stage: 'LEAD_NEW' },
    { name: 'Solo', country: 'DE', stage: 'LEAD_NEW' },
  ]);
  const col = (h) => table.header.indexOf(h);
  assert.ok(col('name') >= 0 && col('country') >= 0 && col('contact_email') >= 0);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].row, 1);
  assert.equal(table.rows[0].values[col('country')], '');
  assert.equal(table.rows[1].values[col('contact_email')], '');
  assert.equal(table.rows[1].values[col('country')], 'DE');
});

// ── Phones that are not a person's ───────────────────────────────────────────

import {
  KLAVIYO_SHARED_PHONE_MIN,
  nonPersonalPhoneKeys,
  normalizeIgnoredPhonesText,
  parseIgnoredPhones,
  phoneKey,
} from '../../src/lib/klaviyoRule.ts';

test('a phone key compares numbers by their last digits, whatever the formatting', () => {
  assert.equal(phoneKey('+49 176 84708200'), phoneKey('0049 17684708200'));
  assert.equal(phoneKey('+4917684708200'), phoneKey('0176 84708200'));
  assert.equal(phoneKey('+49 (30) 123-4567'), phoneKey('030 1234567'));
  assert.equal(phoneKey('12345'), '');
  assert.equal(phoneKey(''), '');
  assert.equal(phoneKey(null), '');
});

test('the ignored list: one per line or comma, junk dropped, stored normalized and de-duplicated', () => {
  const keys = parseIgnoredPhones('+49 30 1234567\n0176 84708200, x, 12');
  assert.ok(keys.has(phoneKey('030 1234567')));
  assert.ok(keys.has(phoneKey('+4917684708200')));
  assert.equal(keys.size, 2);
  assert.equal(normalizeIgnoredPhonesText(' +49 30 1234567 \n030 1234567\nfoo\n0176 84708200'), '+49 30 1234567\n0176 84708200');
  assert.equal(parseIgnoredPhones(null).size, 0);
});

test('a number is not a person\'s when it is ignored or at least N different people carry it', () => {
  const holders = new Map([
    ['111111111', new Set(['p:a', 'p:b', 'c:x'])],
    ['222222222', new Set(['p:a', 'p:b'])],
    ['333333333', new Set(['p:c'])],
  ]);
  assert.equal(KLAVIYO_SHARED_PHONE_MIN, 3);
  assert.deepEqual([...nonPersonalPhoneKeys(holders, new Set())], ['111111111']);
  assert.deepEqual([...nonPersonalPhoneKeys(holders, new Set(['333333333']))].sort(), ['111111111', '333333333']);
});
