// Unit tests for what an account event from a registered machine source means
// (#2450/#2451, generic since #2914): src/lib/accountEventRule.ts, the
// envelope schema's id handling, and the operator CLI's plain-ESM mirror of the
// slug rule (prisma/register-integration-source.mjs).
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  ACCOUNT_ACQUISITION_SOURCES,
  ACCOUNT_EVENT_TYPES,
  ACCOUNT_NAME_MAX,
  CONTACT_NAME_MAX,
  EVENT_ID_PATTERN,
  EXTERNAL_ID_MAX,
  RESERVED_SOURCE_SLUGS,
  SOURCE_LABEL_MAX,
  SOURCE_SLUG_PATTERN,
  accountNameFor,
  contactFullName,
  ingestIntent,
  ingestTrialWindow,
  isStaleEvent,
  normalizeExternalId,
  normalizeSourceLabel,
  normalizeSourceSlug,
} = await import('../../src/lib/accountEventRule.ts');
const { ACQUISITION_SOURCES } = await import('../../src/lib/leadSourceName.ts');
const mirror = await import('../../prisma/register-integration-source.mjs');

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

test('trial, conversion, loss and reactivation act on the funnel; every other type is recorded', () => {
  assert.deepEqual(ingestIntent('account_created'), { kind: 'open_trial', toStage: 'TRIAL_ACTIVE' });
  assert.deepEqual(ingestIntent('trial_started'), { kind: 'open_trial', toStage: 'TRIAL_ACTIVE' });
  assert.deepEqual(ingestIntent('converted'), { kind: 'won', toStage: 'DEAL_WON' });
  assert.deepEqual(ingestIntent('cancelled'), { kind: 'lost', toStage: 'DEAL_LOST' });
  assert.deepEqual(ingestIntent('deactivated'), { kind: 'lost', toStage: 'DEAL_LOST' });
  assert.deepEqual(ingestIntent('reactivated'), { kind: 'reactivate' });
  // deleted and out_of_scope stay record-only (an owner decision, #2966).
  assert.deepEqual(ingestIntent('deleted'), { kind: 'record' });
  assert.deepEqual(ingestIntent('out_of_scope'), { kind: 'record' });
  const acting = new Set(['account_created', 'trial_started', 'converted', 'cancelled', 'deactivated', 'reactivated']);
  for (const type of ACCOUNT_EVENT_TYPES) {
    if (!acting.has(type)) assert.deepEqual(ingestIntent(type), { kind: 'record' }, type);
  }
  assert.equal(new Set(ACCOUNT_EVENT_TYPES).size, ACCOUNT_EVENT_TYPES.length, 'no duplicate event type');
});

test('the acquisition channels are the lead-source rule\'s own list, not a copy', () => {
  assert.equal(ACCOUNT_ACQUISITION_SOURCES, ACQUISITION_SOURCES);
});

test('an event id is opaque, 1–64 characters of a fixed alphabet', () => {
  for (const ok of ['a', 'evt-0001', 'Evt_2026.10.14:42', 'x'.repeat(64)]) assert.ok(EVENT_ID_PATTERN.test(ok), ok);
  for (const bad of ['', 'x'.repeat(65), 'has space', 'slash/id', 'ümlaut', 'semi;colon']) {
    assert.ok(!EVENT_ID_PATTERN.test(bad), bad);
  }
});

test('an external id is opaque printable ASCII: trimmed, lower-cased, 1–191 characters', () => {
  assert.equal(normalizeExternalId('  Ext-ABC-001  '), 'ext-abc-001');
  assert.equal(normalizeExternalId('acct 42 / shop'), 'acct 42 / shop', 'any printable shape is the sender\'s business');
  assert.equal(normalizeExternalId('Billing:1001~#'), 'billing:1001~#');
  // The id columns also fold accents (`café` = `cafe`), so a non-ASCII id
  // could match another account: refused, never folded.
  for (const accented of ['café-1', 'straße', 'ＡＢＣ', 'id x', 'emoji-🙂']) {
    assert.equal(normalizeExternalId(accented), null, JSON.stringify(accented));
  }
  assert.equal(normalizeExternalId('Kelvin'), null, 'checked before lower-casing: the Kelvin sign is not a k');
  assert.equal(normalizeExternalId('x'.repeat(EXTERNAL_ID_MAX)), 'x'.repeat(EXTERNAL_ID_MAX));
  assert.equal(normalizeExternalId('x'.repeat(EXTERNAL_ID_MAX + 1)), null);
  assert.equal(normalizeExternalId('   '), null);
  assert.equal(normalizeExternalId(''), null);
  assert.equal(normalizeExternalId('ext\u0000001'), null);
  assert.equal(normalizeExternalId('ext\n001'), null);
  assert.equal(normalizeExternalId('ext\u0085001'), null, 'a C1 control character too');
  assert.equal(normalizeExternalId(42), null);
  assert.equal(normalizeExternalId(null), null);
});

test('a source slug: lower-case letters, digits and dashes, 2–40, never a static sibling route', () => {
  assert.equal(normalizeSourceSlug('demo-feed'), 'demo-feed');
  assert.equal(normalizeSourceSlug('Demo-Feed'), 'demo-feed', 'the URL segment is case-insensitive');
  assert.equal(normalizeSourceSlug('a1'), 'a1');
  assert.equal(normalizeSourceSlug('9lives'), '9lives');
  assert.equal(normalizeSourceSlug('x'.repeat(40)), 'x'.repeat(40));
  for (const bad of ['', 'a', 'x'.repeat(41), '-feed', 'feed_1', 'feed.1', 'feed 1', 'fëed', '../feed', 'feed/x', 'feed%2f']) {
    assert.equal(normalizeSourceSlug(bad), null, JSON.stringify(bad));
    assert.ok(!SOURCE_SLUG_PATTERN.test(bad.toLowerCase()), bad);
  }
  for (const reserved of RESERVED_SOURCE_SLUGS) {
    assert.ok(SOURCE_SLUG_PATTERN.test(reserved), `${reserved} would otherwise be valid`);
    assert.equal(normalizeSourceSlug(reserved), null, reserved);
    assert.equal(normalizeSourceSlug(reserved.toUpperCase()), null, `${reserved} in another case`);
  }
  assert.equal(normalizeSourceSlug(undefined), null);
  assert.equal(normalizeSourceSlug(7), null);
});

test('every static sibling of [source] under /api/integrations is a reserved slug', () => {
  const dir = join(ROOT, 'src', 'app', 'api', 'integrations');
  const statics = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('['))
    .map((d) => d.name.toLowerCase())
    .sort();
  assert.ok(readdirSync(dir).includes('[source]'), 'the dynamic route exists');
  assert.deepEqual([...RESERVED_SOURCE_SLUGS].sort(), statics);
});

test('a source label is collapsed, stripped of control characters and capped', () => {
  assert.equal(normalizeSourceLabel('  Demo \t feed '), 'Demo feed');
  assert.equal(normalizeSourceLabel('Demo\u0000feed'), 'Demo feed');
  assert.equal(normalizeSourceLabel('x'.repeat(SOURCE_LABEL_MAX + 10)), 'x'.repeat(SOURCE_LABEL_MAX));
  assert.equal(normalizeSourceLabel('   '), null);
  assert.equal(normalizeSourceLabel(undefined), null);
});

test('the operator CLI\'s slug and label rules are the TS rule, value for value', () => {
  assert.equal(mirror.SOURCE_SLUG_PATTERN.source, SOURCE_SLUG_PATTERN.source);
  assert.equal(mirror.SOURCE_SLUG_PATTERN.flags, SOURCE_SLUG_PATTERN.flags);
  assert.deepEqual(mirror.RESERVED_SOURCE_SLUGS, [...RESERVED_SOURCE_SLUGS]);
  assert.equal(mirror.SOURCE_LABEL_MAX, SOURCE_LABEL_MAX);
  const slugs = [
    'demo-feed', 'Demo-Feed', 'a1', 'a', '', '-x', 'x'.repeat(40), 'x'.repeat(41), 'feed_1',
    'google', 'GOOGLE', 'calendar', 'fëed', undefined, null, 3,
  ];
  for (const s of slugs) assert.equal(mirror.normalizeSourceSlug(s), normalizeSourceSlug(s), JSON.stringify(s));
  const labels = ['  Demo \t feed ', 'Demo\u0000feed', 'x'.repeat(100), '   ', '', undefined, 5];
  for (const l of labels) assert.equal(mirror.normalizeSourceLabel(l), normalizeSourceLabel(l), JSON.stringify(l));
});

test('a new account is named after the company, else the person, else "<source label> <external id>"', () => {
  assert.equal(accountNameFor('ext-1', { company_name: ' Shop GmbH ', first_name: 'A' }, 'Demo feed'), 'Shop GmbH');
  assert.equal(accountNameFor('ext-1', { first_name: ' Ada ', last_name: 'Lovelace' }, 'Demo feed'), 'Ada Lovelace');
  assert.equal(accountNameFor('ext-1', null, 'Demo feed'), 'Demo feed ext-1');
  assert.equal(accountNameFor('ext-1', { company_name: '  ', first_name: null }, ' Demo feed '), 'Demo feed ext-1');
  assert.equal(contactFullName({ first_name: 'Ada', last_name: null }), 'Ada');
  assert.equal(contactFullName(undefined), '');
  const long = accountNameFor('x'.repeat(EXTERNAL_ID_MAX), null, 'L'.repeat(SOURCE_LABEL_MAX));
  assert.equal(long.length, ACCOUNT_NAME_MAX, 'a long label plus a long id still fits Company.name');
});

test('the contact name fits Company.contactName even when both parts are at their own maximum', () => {
  assert.equal(CONTACT_NAME_MAX, 191);
  const full = contactFullName({ first_name: 'F'.repeat(191), last_name: 'L'.repeat(191) });
  assert.equal(full.length, CONTACT_NAME_MAX);
  assert.ok(full.startsWith('F'.repeat(191)));
  // A cut that lands on the separating space leaves no trailing blank.
  assert.equal(contactFullName({ first_name: 'F'.repeat(190), last_name: 'Lovelace' }), 'F'.repeat(190));
  assert.equal(contactFullName({ first_name: ' Ada ', last_name: ' Lovelace ' }), 'Ada Lovelace');
});

test("the source's trial dates fill gaps but never overwrite a date the record carries", () => {
  const d = (n) => new Date(Date.UTC(2026, 9, n));
  const event = { trialStartedAt: d(1), trialEndsAt: d(31) };
  const fallback = { trialStartedAt: d(5), trialEndsAt: d(35) };
  assert.deepEqual(ingestTrialWindow({ trialStartedAt: null, trialEndsAt: null }, event, fallback), event);
  assert.deepEqual(ingestTrialWindow({ trialStartedAt: d(2), trialEndsAt: d(20) }, event, fallback), {});
  assert.deepEqual(ingestTrialWindow({ trialStartedAt: d(2), trialEndsAt: null }, event, fallback), { trialEndsAt: d(31) });
  // The CRM's own rule only fills what neither side has.
  assert.deepEqual(
    ingestTrialWindow({ trialStartedAt: null, trialEndsAt: null }, { trialStartedAt: null, trialEndsAt: null }, fallback),
    fallback,
  );
  assert.deepEqual(
    ingestTrialWindow({ trialStartedAt: null, trialEndsAt: null }, { trialStartedAt: null, trialEndsAt: null }, {}),
    {},
  );
});

test('an event older than the newest APPLIED one is stale; none applied yet is never stale', () => {
  const now = new Date('2026-10-06T10:00:00Z');
  assert.equal(isStaleEvent(new Date('2026-10-05T10:00:00Z'), now), true);
  assert.equal(isStaleEvent(new Date('2026-10-07T10:00:00Z'), now), false);
  assert.equal(isStaleEvent(now, now), false);
  assert.equal(isStaleEvent(now, null), false);
});

test('the v1 envelope: ids lower-cased, dropped fields stripped, a changed version refused', async () => {
  const { accountEventSchema } = await import('../../src/lib/accountEventSchema.ts');
  const base = {
    event_id: 'Evt-0001',
    schema_version: 1,
    event_type: 'account_created',
    occurred_at: '2026-10-14T09:00:00Z',
    external_id: '  Ext-ABC-001 ',
    referral_code: 'AFF-7',
    acquisition_source: 'youtube',
    decision_ends_at: '2026-11-14T09:00:00+01:00',
    contact: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@shop.example', company_name: null },
    // Not part of the contract: accepted and dropped, never stored or read.
    x_sender_flag: true,
    x_sender_note: 'anything',
  };
  const ok = accountEventSchema.safeParse(base);
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  assert.equal(ok.data.event_id, 'evt-0001');
  assert.equal(ok.data.external_id, 'ext-abc-001');
  assert.equal(ok.data.referral_code, 'AFF-7');
  assert.equal(ok.data.trial_started_at, null);
  assert.ok(ok.data.decision_ends_at instanceof Date);
  assert.ok(!('x_sender_flag' in ok.data) && !('x_sender_note' in ok.data), 'unknown keys are stripped');

  const bad = accountEventSchema.safeParse({
    ...base,
    schema_version: 2,
    event_type: 'renamed_type',
    event_id: 'has space',
    external_id: ' ',
    acquisition_source: 'billboard',
  });
  assert.ok(!bad.success);
  const paths = bad.error.issues.map((i) => i.path.join('.'));
  for (const p of ['schema_version', 'event_type', 'event_id', 'external_id', 'acquisition_source']) {
    assert.ok(paths.includes(p), `${p} refused (${paths.join(', ')})`);
  }

  const accented = accountEventSchema.safeParse({ ...base, external_id: 'Café-1' });
  assert.ok(!accented.success);
  assert.deepEqual(accented.error.issues.map((i) => i.path.join('.')), ['external_id']);
  assert.match(accented.error.issues[0].message, /printable ASCII/);
});
