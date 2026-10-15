// Unit tests for src/lib/postCampaignRule.ts — who may receive a campaign
// letter, what is printed, and what an objection blocks (#2697).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  POST_COOLDOWN_DAYS,
  CAMPAIGN_CODE_RE,
  addressBlock,
  campaignCodeFrom,
  campaignLandingPath,
  campaignShortLink,
  postIneligibility,
  renderLetter,
  salutation,
  suppressionKeys,
} = await import('../../src/lib/postCampaignRule.ts');
const { ownerObjected, OWNER_OBJECTION_VIAS } = await import('../../src/lib/contactPermissionRule.ts');

const NOW = new Date('2026-10-04T12:00:00Z');
const DAY = 86_400_000;
const base = { address: 'Hauptstr. 1\n10115 Berlin', postPermission: null, suppressed: false, lastSentAt: null, now: NOW };

test('an account with an address and no history may receive a letter', () => {
  assert.equal(postIneligibility(base), null);
  // A live NONE row is the normal state of an imported account: post needs no consent.
  assert.equal(postIneligibility({ ...base, postPermission: { basis: 'NONE', revokedAt: null } }), null);
});

test('an objection blocks the letter, whichever way the owner made it', () => {
  for (const via of ['LINK', 'OBJECTION']) {
    assert.equal(postIneligibility({ ...base, postPermission: { revokedAt: NOW, revokedVia: via } }), 'objected', via);
  }
  // …and is reported as the objection even when the address is missing too.
  assert.equal(postIneligibility({ ...base, address: '', postPermission: { revokedAt: NOW, revokedVia: 'OBJECTION' } }), 'objected');
});

test('the block list outlives the account row', () => {
  assert.equal(postIneligibility({ ...base, suppressed: true }), 'suppressed');
});

test('an admin revocation blocks the letter but is not an objection', () => {
  assert.equal(postIneligibility({ ...base, postPermission: { revokedAt: NOW, revokedVia: 'ADMIN' } }), 'revoked');
});

test('no address, nothing to print', () => {
  assert.equal(postIneligibility({ ...base, address: '  ' }), 'no_address');
  assert.equal(postIneligibility({ ...base, address: null }), 'no_address');
});

test(`one letter per account per ${POST_COOLDOWN_DAYS} days`, () => {
  const recent = new Date(NOW.getTime() - (POST_COOLDOWN_DAYS - 1) * DAY);
  const old = new Date(NOW.getTime() - (POST_COOLDOWN_DAYS + 1) * DAY);
  assert.equal(postIneligibility({ ...base, lastSentAt: recent }), 'recently_mailed');
  assert.equal(postIneligibility({ ...base, lastSentAt: old }), null);
});

test('a recorded objection locks the contact-permission row like the opt-out link', () => {
  assert.deepEqual([...OWNER_OBJECTION_VIAS].sort(), ['LINK', 'OBJECTION']);
  assert.equal(ownerObjected({ basis: 'NONE', revokedAt: NOW, revokedVia: 'OBJECTION' }), true);
  assert.equal(ownerObjected({ basis: 'NONE', revokedAt: NOW, revokedVia: 'ADMIN' }), false);
  assert.equal(ownerObjected({ basis: 'NONE', revokedAt: null, revokedVia: 'OBJECTION' }), false);
});

test('campaign codes are URL-safe and derived from the name', () => {
  assert.equal(campaignCodeFrom('Herbst 2026 – Shop-Händler'), 'herbst-2026-shop-handler');
  assert.equal(campaignCodeFrom('Straße & Söhne'), 'strasse-sohne');
  assert.equal(campaignCodeFrom('!!!'), 'kampagne');
  assert.equal(campaignCodeFrom('x'.repeat(80)).length, 60);
  for (const ok of ['a', 'q4-2026', 'amazon-de']) assert.match(ok, CAMPAIGN_CODE_RE);
  for (const bad of ['', '-a', 'a-', 'A', 'a b', 'ä']) assert.doesNotMatch(bad, CAMPAIGN_CODE_RE);
});

test('the short link lands on the demo form with the letter as its source', () => {
  assert.equal(campaignShortLink('https://marketing.example.test/', 'q4'), 'https://marketing.example.test/b/q4');
  assert.equal(campaignLandingPath('q4'), '/?utm_source=brief&utm_medium=post&utm_campaign=q4#demo');
});

test('the address block follows DIN 5008', () => {
  assert.deepEqual(addressBlock({ companyName: 'Shop GmbH', contactName: 'Eva Weber', address: 'Hauptstr. 1, 10115 Berlin', country: 'DE' }), [
    'Shop GmbH',
    'z. Hd. Eva Weber',
    'Hauptstr. 1',
    '10115 Berlin',
  ]);
  // Abroad: the country is the last line, upper case.
  assert.deepEqual(addressBlock({ companyName: 'Shop', address: 'Ring 2|1010 Wien', country: 'at', countryName: () => 'Österreich' }), [
    'Shop',
    'Ring 2',
    '1010 Wien',
    'ÖSTERREICH',
  ]);
  assert.equal(addressBlock({ companyName: 'Shop', address: '' }), null);
  assert.equal(addressBlock({ companyName: 'S', address: 'a\nb\nc\nd\ne\nf\ng' }).length, 6);
});

test('the salutation never guesses a gender', () => {
  assert.equal(salutation('Eva Weber'), 'Guten Tag Eva Weber,');
  assert.equal(salutation(null), 'Sehr geehrte Damen und Herren,');
  assert.equal(
    renderLetter('{salutation}\n{company} — {link} {link}', { company: 'Shop', contactName: '', link: 'x.de/b/q' }),
    'Sehr geehrte Damen und Herren,\nShop — x.de/b/q x.de/b/q',
  );
});

test('an objection blocks every key the account could come back under', () => {
  const keys = suppressionKeys({
    vatId: 'DE 123 456 789',
    name: 'Müller  Shop GmbH',
    country: 'DE',
    contactEmail: ' Info@Mueller.de ',
    address: 'Hauptstraße 1, 10115 Berlin',
  });
  assert.deepEqual(keys, ['vat:de123456789', 'name:mullershopgmbh|de', 'email:info@mueller.de', 'addr:hauptstrasse110115berlin']);
  // The same account typed differently produces the same keys.
  assert.deepEqual(
    suppressionKeys({ vatId: 'de123456789', name: 'MÜLLER SHOP GMBH', country: 'de', contactEmail: 'info@mueller.de', address: 'Hauptstrasse 1 10115 Berlin' }),
    keys,
  );
  assert.deepEqual(suppressionKeys({}), []);
});
