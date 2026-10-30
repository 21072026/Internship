// SSO directory sync (#1943) — the pure rule. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const {
  isSyncTarget,
  attributeKeyOf,
  planSsoProfileSync,
  planAttributeWrites,
  classifyPhotoClaim,
  photoContentType,
  MAX_PHOTO_BYTES,
} = await import('../../src/lib/ssoDirectorySyncRule.ts');
const { planFieldUpdates } = await import('../../src/lib/externalSyncPolicy.ts');

const map = (claim, target) => ({ claim, target });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('targets are an allowlist: profile fields, the photo, attr:<key> — never identity or access', () => {
  for (const ok of ['department', 'city', 'timezone', 'fullName', 'photo', 'attr:cost_center']) assert.equal(isSyncTarget(ok), true, ok);
  for (const bad of ['email', 'role', 'orgId', 'password', 'isActive', 'ssoExempt', 'attr:', 'attr:Bad-Key', 'attr:1x', '']) {
    assert.equal(isSyncTarget(bad), false, bad);
  }
  assert.equal(attributeKeyOf('attr:cost_center'), 'cost_center');
  assert.equal(attributeKeyOf('department'), null);
});

test('a claim the IdP did not send is no opinion; the first non-empty value of a multi-valued claim is used', () => {
  const plan = planSsoProfileSync(
    [map('department', 'department'), map('l', 'city'), map('title', 'targetPosition')],
    { department: ['  ', 'Engineering', 'Ops'], title: ['Staff Engineer'] },
    [],
  );
  assert.deepEqual(plan.fields, { department: 'Engineering', targetPosition: 'Staff Engineer' });
  assert.equal('city' in plan.fields, false);
  assert.deepEqual(plan.rejected, []);
});

test('a value that does not fit is rejected by target NAME, never by value', () => {
  const plan = planSsoProfileSync(
    [map('tz', 'timezone'), map('dept', 'department')],
    { tz: ['Mars/Olympus_Mons'], dept: ['x'.repeat(192)] },
    [],
  );
  assert.deepEqual(plan.fields, {});
  assert.deepEqual(plan.rejected.sort(), ['department', 'timezone']);
  assert.equal(JSON.stringify(plan).includes('Mars'), false);
  const ok = planSsoProfileSync([map('tz', 'timezone')], { tz: ['Europe/Berlin'] }, []);
  assert.equal(ok.fields.timezone, 'Europe/Berlin');
});

test('org attributes are normalised by their type; a mapping to an attribute the org lacks is skipped', () => {
  const attributes = [
    { id: 'a1', key: 'site', type: 'SELECT', options: ['Berlin', 'Köln'] },
    { id: 'a2', key: 'start', type: 'DATE' },
  ];
  const plan = planSsoProfileSync(
    [map('site', 'attr:site'), map('start', 'attr:start'), map('gone', 'attr:deleted_one')],
    { site: ['berlin'], start: ['31.12.2024'], gone: ['x'] },
    attributes,
  );
  assert.deepEqual(plan.attributes, { a1: 'Berlin', a2: '2024-12-31' });
  const bad = planSsoProfileSync([map('site', 'attr:site')], { site: ['Hamburg'] }, attributes);
  assert.deepEqual(bad.attributes, {});
  assert.deepEqual(bad.rejected, ['attr:site']);
});

test('the overwrite decision is the shared policy: gaps fill, a disagreement needs authority', () => {
  const current = { department: 'Sales', city: null };
  const incoming = { department: 'Engineering', city: 'Berlin' };
  const soft = planFieldUpdates(current, incoming, { authoritative: false });
  assert.deepEqual(soft.changes, { city: 'Berlin' });
  assert.deepEqual(soft.withheld, ['department']);
  const hard = planFieldUpdates(current, incoming, { authoritative: true });
  assert.deepEqual(hard.changes, { department: 'Engineering', city: 'Berlin' });

  const have = new Map([['a1', 'Köln']]);
  assert.deepEqual(planAttributeWrites({ a1: 'Berlin', a2: 'x' }, have, false), { writes: { a2: 'x' }, withheld: ['a1'] });
  assert.deepEqual(planAttributeWrites({ a1: 'Berlin' }, have, true), { writes: { a1: 'Berlin' }, withheld: [] });
  assert.deepEqual(planAttributeWrites({ a1: 'Köln' }, have, false), { writes: {}, withheld: [] });
});

test('a photo claim is a URL to fetch or inline base64 under the avatar cap', () => {
  assert.deepEqual(classifyPhotoClaim(' https://idp.example/p.png '), { kind: 'url', url: 'https://idp.example/p.png' });
  assert.equal(classifyPhotoClaim('http://169.254.169.254/latest').kind, 'url'); // the SSRF guard decides, not this
  const inline = classifyPhotoClaim(Buffer.from(PNG).toString('base64'));
  assert.equal(inline.kind, 'inline');
  assert.equal(photoContentType(inline.bytes), 'image/png');
  assert.equal(classifyPhotoClaim('not base64 at all!').kind, 'invalid');
  assert.equal(classifyPhotoClaim('').kind, 'invalid');
  const tooBig = Buffer.alloc(MAX_PHOTO_BYTES + 3).toString('base64');
  assert.equal(classifyPhotoClaim(tooBig).kind, 'invalid');
});

test('only image signatures count as a photo', () => {
  assert.equal(photoContentType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(photoContentType(Uint8Array.from(Buffer.from('%PDF-1.7'))), null);
  assert.equal(photoContentType(Uint8Array.from(Buffer.from('<svg/>'))), null);
});
