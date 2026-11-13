// Unit tests for moving a programme's settings between environments
// (src/lib/affiliateSettingsTransferRule.ts, docs/affiliate-module.md
// § Moving the settings, #3622).
//
// Run: npm run test:unit
//
// SYNTHETIC ONLY: example URLs, made-up bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  SETTINGS_TRANSFER_FORMAT,
  SETTINGS_TRANSFER_VERSION,
  TRANSFER_SECTIONS,
  base64ByteLength,
  defaultSelection,
  landingMediaIds,
  parseTransferFile,
  presentSections,
  remapLandingMedia,
  resolveSelection,
  transferFileName,
} = await import('../../src/lib/affiliateSettingsTransferRule.ts');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7]);
const ID_A = 'clh0000000000000000000aa';
const ID_B = 'clh0000000000000000000bb';

const asset = (over = {}) => ({
  id: ID_A,
  kind: 'image',
  contentType: 'image/png',
  size: PNG.length,
  sha256: createHash('sha256').update(PNG).digest('hex'),
  data: PNG.toString('base64'),
  ...over,
});

const file = (over = {}) => ({
  format: SETTINGS_TRANSFER_FORMAT,
  version: SETTINGS_TRANSFER_VERSION,
  exportedAt: '2026-11-11T10:00:00.000Z',
  appVersion: '0.0.0-test',
  sections: { referralUrl: 'https://shop.example/signup', windowNotice: 30 },
  assets: [],
  ...over,
});

test('a well-formed file parses, sections and assets as given', () => {
  const r = parseTransferFile(file({ assets: [asset()] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.file.sections, { referralUrl: 'https://shop.example/signup', windowNotice: 30 });
  assert.equal(r.file.assets.length, 1);
  assert.equal(r.file.assets[0].id, ID_A);
});

test('a file of another kind or version is refused before anything is read', () => {
  assert.deepEqual(parseTransferFile(null), { ok: false, issue: 'format' });
  assert.deepEqual(parseTransferFile([]), { ok: false, issue: 'format' });
  assert.deepEqual(parseTransferFile(file({ format: 'something-else' })), { ok: false, issue: 'format' });
  assert.deepEqual(parseTransferFile(file({ version: 2 })), { ok: false, issue: 'version' });
  assert.deepEqual(parseTransferFile(file({ sections: [] })), { ok: false, issue: 'sections' });
});

test('an unknown section is refused, not ignored', () => {
  assert.deepEqual(parseTransferFile(file({ sections: { partners: [] } })), { ok: false, issue: 'sections' });
});

test('a null referral URL is a section that clears it, not an absent one', () => {
  const r = parseTransferFile(file({ sections: { referralUrl: null } }));
  assert.equal(r.ok, true);
  assert.deepEqual(presentSections(r.file), ['referralUrl']);
});

test('assets: at most one per slot, each well-formed, no duplicate ids', () => {
  assert.deepEqual(parseTransferFile(file({ assets: {} })), { ok: false, issue: 'assets' });
  const four = [ID_A, ID_B, 'clh0000000000000000000cc', 'clh0000000000000000000dd'].map((id) => asset({ id }));
  assert.deepEqual(parseTransferFile(file({ assets: four })), { ok: false, issue: 'assets' });
  assert.deepEqual(parseTransferFile(file({ assets: [asset(), asset()] })), { ok: false, issue: 'asset_duplicate' });
  for (const bad of [
    { id: '../../etc/passwd' },
    { id: 'https://evil.example/x.png' },
    { contentType: 'image/svg+xml' }, // SVG can carry script; the theme never takes it
    { contentType: 'text/html' },
    { kind: 'video' }, // the declared kind must match the type
    { size: 0 },
    { size: 6 * 1024 * 1024 }, // over the image limit
    { size: PNG.length + 1 }, // the bytes are not the size they claim
    { sha256: 'not-a-hash' },
    { data: 'not base64!' },
  ]) {
    assert.deepEqual(parseTransferFile(file({ assets: [asset(bad)] })), { ok: false, issue: 'asset_invalid' }, JSON.stringify(bad));
  }
});

test('base64ByteLength reads the length without decoding', () => {
  for (const n of [1, 2, 3, 4, 15, 16]) {
    const b64 = Buffer.alloc(n, 7).toString('base64');
    assert.equal(base64ByteLength(b64), n);
  }
});

test('sections come back in apply order, the plan last', () => {
  const r = parseTransferFile(file({ sections: { plan: {}, windowNotice: 3, landing: {}, contract: {}, referralUrl: null, customerStatus: {} } }));
  assert.deepEqual(presentSections(r.file), ['landing', 'contract', 'customerStatus', 'windowNotice', 'referralUrl', 'plan']);
  assert.equal(TRANSFER_SECTIONS.at(-1), 'plan');
});

test('neither the plan nor the contract is ever pre-selected', () => {
  assert.deepEqual(defaultSelection(['landing', 'contract', 'customerStatus', 'plan']), ['landing', 'customerStatus']);
  assert.deepEqual(defaultSelection(['plan', 'contract']), []);
});

test('a selection names only sections the file has, at least one, and the plan only when confirmed', () => {
  const present = ['landing', 'contract', 'plan'];
  assert.deepEqual(resolveSelection('contract,landing', present, false), { ok: true, sections: ['landing', 'contract'] });
  assert.deepEqual(resolveSelection(' landing , ', present, false), { ok: true, sections: ['landing'] });
  assert.deepEqual(resolveSelection('', present, false), { ok: false, issue: 'empty' });
  assert.deepEqual(resolveSelection(null, present, false), { ok: false, issue: 'empty' });
  assert.deepEqual(resolveSelection('partners', present, false), { ok: false, issue: 'unknown_section' });
  assert.deepEqual(resolveSelection('referralUrl', present, false), { ok: false, issue: 'not_in_file' });
  assert.deepEqual(resolveSelection('landing,plan', present, false), { ok: false, issue: 'plan_unconfirmed' });
  assert.deepEqual(resolveSelection('plan,landing', present, true), { ok: true, sections: ['landing', 'plan'] });
});

test('landing media ids are read and remapped slot by slot; other ids stay', () => {
  const landing = { copy: {}, theme: { colors: {}, media: { logo: ID_A, hero: ID_B, showcase: null } } };
  assert.deepEqual(landingMediaIds(landing), [
    { slot: 'logo', id: ID_A },
    { slot: 'hero', id: ID_B },
  ]);
  const out = remapLandingMedia(landing, new Map([[ID_A, 'clhnew000000000000000001']]));
  assert.deepEqual(out.theme.media, { logo: 'clhnew000000000000000001', hero: ID_B, showcase: null });
  // The input is not mutated.
  assert.equal(landing.theme.media.logo, ID_A);
  // No theme: nothing to read, nothing to remap.
  assert.deepEqual(landingMediaIds({ copy: {}, theme: null }), []);
  assert.deepEqual(remapLandingMedia({ copy: {}, theme: null }, new Map()), { copy: {}, theme: null });
});

test('the file name carries the date only', () => {
  assert.equal(transferFileName(new Date('2026-11-11T23:59:00Z')), 'affiliate-settings-2026-11-11.json');
});
