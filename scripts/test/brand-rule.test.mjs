import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AA_TEXT,
  BRAND_ACCENT,
  BRAND_SERVED_KINDS,
  BRAND_SOURCE_KIND,
  PALETTE_STEPS,
  brandAssetPath,
  brandKindForFile,
  contrastRatio,
  effectiveTileColor,
  formatPalette,
  hasAnyBrand,
  hostBrandSource,
  isBrandVersion,
  normalizeHex,
  paletteCssVars,
  paletteIsReadable,
  parsePalette,
  rampFrom,
  resolveAccentChoice,
  resolveBrandFields,
  splashKind,
} from '../../src/lib/brandRule.ts';
import { APPLE_SPLASH_DEVICES, brandSplashLinks, splashPixels } from '../../src/lib/appleSplash.ts';
import { brandReport } from '../../prisma/set-public-host.mjs';

// The per-organization brand rule (#2922). Everything that decides WHICH brand
// a request wears and WHAT each field falls back to is pinned here, without a
// database: the default path must stay the default (that is the no-visual-
// change guarantee), a mismatched mapping must never dress the other product,
// and a generated palette must always carry readable primary buttons.
//
// Every brand value below is synthetic.

const ACCENT_KEYS = ['blue', 'green', 'purple', 'rose', 'teal', 'amber', 'magenta'];
const isAccentKey = (v) => typeof v === 'string' && ACCENT_KEYS.includes(v);

const DEFAULTS = { productName: 'Default Product', themeColor: '#1D4ED8', accent: 'blue' };
const EMPTY = {
  vertical: 'MARKETING',
  brandName: null,
  brandColor: null,
  brandTileColor: null,
  brandAccent: null,
  brandPalette: null,
  brandMarkVersion: null,
};
const VERSION = '0123456789abcdef';

// ── Source decision ──────────────────────────────────────────────────────────

test('no mapping is the default brand — the path every host takes today', () => {
  assert.equal(hostBrandSource({ hostVertical: 'INTERNSHIP', mapped: null }), 'default');
  assert.equal(hostBrandSource({ hostVertical: 'MARKETING', mapped: null }), 'default');
});

test('a mapped org with no brand field is still the default', () => {
  assert.equal(hasAnyBrand(EMPTY), false);
  assert.equal(hostBrandSource({ hostVertical: 'MARKETING', mapped: { ...EMPTY } }), 'default');
  // Blank strings are not brand data either.
  assert.equal(hasAnyBrand({ ...EMPTY, brandName: '   ', brandColor: '' }), false);
});

test('a mapped org of the host\'s own product with any brand field supplies the brand', () => {
  for (const field of ['brandName', 'brandColor', 'brandTileColor', 'brandAccent', 'brandPalette', 'brandMarkVersion']) {
    const mapped = { ...EMPTY, [field]: field === 'brandMarkVersion' ? VERSION : 'x' };
    assert.equal(hostBrandSource({ hostVertical: 'MARKETING', mapped }), 'org', field);
  }
});

test('a mapping that crosses products falls back to the default, never the other product\'s brand', () => {
  const branded = { ...EMPTY, vertical: 'INTERNSHIP', brandName: 'Acme Sales' };
  assert.equal(hostBrandSource({ hostVertical: 'MARKETING', mapped: branded }), 'default');
  assert.equal(hostBrandSource({ hostVertical: 'INTERNSHIP', mapped: { ...branded, vertical: 'MARKETING' } }), 'default');
});

// ── Field-by-field fallback ──────────────────────────────────────────────────

test('the default brand is exactly the defaults the caller passed in', () => {
  const r = resolveBrandFields(null, DEFAULTS, isAccentKey);
  assert.deepEqual(r, {
    source: 'default',
    productName: 'Default Product',
    themeColor: '#1D4ED8',
    tileColor: '#1D4ED8',
    accent: 'blue',
    palette: null,
    markVersion: null,
  });
  assert.equal(resolveBrandFields(EMPTY, DEFAULTS, isAccentKey).source, 'default');
});

test('a name-only brand changes the name and nothing else', () => {
  const r = resolveBrandFields({ ...EMPTY, brandName: 'Acme Sales' }, DEFAULTS, isAccentKey);
  assert.equal(r.source, 'org');
  assert.equal(r.productName, 'Acme Sales');
  assert.equal(r.themeColor, DEFAULTS.themeColor);
  assert.equal(r.accent, DEFAULTS.accent);
  assert.equal(r.palette, null);
  assert.equal(r.markVersion, null);
});

test('colour drives the tint and, without a tile, the tile', () => {
  const r = resolveBrandFields({ ...EMPTY, brandColor: '#0E7490' }, DEFAULTS, isAccentKey);
  assert.equal(r.themeColor, '#0e7490');
  assert.equal(r.tileColor, '#0e7490');
  const t = resolveBrandFields({ ...EMPTY, brandColor: '#0E7490', brandTileColor: '#123' }, DEFAULTS, isAccentKey);
  assert.equal(t.tileColor, '#112233');
});

test('an accent key is honoured; an unknown one falls back', () => {
  assert.equal(resolveBrandFields({ ...EMPTY, brandAccent: 'teal' }, DEFAULTS, isAccentKey).accent, 'teal');
  assert.equal(resolveBrandFields({ ...EMPTY, brandAccent: 'chartreuse' }, DEFAULTS, isAccentKey).accent, 'blue');
});

test("'brand' needs a palette: an explicit one, or one generated from the colour", () => {
  const noColour = resolveBrandFields({ ...EMPTY, brandAccent: BRAND_ACCENT }, DEFAULTS, isAccentKey);
  assert.equal(noColour.accent, 'blue');
  assert.equal(noColour.palette, null);

  const generated = resolveBrandFields({ ...EMPTY, brandAccent: BRAND_ACCENT, brandColor: '#0e7490' }, DEFAULTS, isAccentKey);
  assert.equal(generated.accent, BRAND_ACCENT);
  assert.equal(generated.palette.length, 10);

  const exact = formatPalette(rampFrom('#7c3aed'));
  const explicit = resolveBrandFields({ ...EMPTY, brandAccent: BRAND_ACCENT, brandPalette: exact }, DEFAULTS, isAccentKey);
  assert.deepEqual(explicit.palette, parsePalette(exact));
});

test('a palette without the brand accent is offered, not imposed', () => {
  const r = resolveBrandFields({ ...EMPTY, brandPalette: formatPalette(rampFrom('#0e7490')) }, DEFAULTS, isAccentKey);
  assert.equal(r.accent, 'blue');
  assert.equal(r.palette.length, 10);
});

test('only a well-formed version names an icon set', () => {
  assert.equal(resolveBrandFields({ ...EMPTY, brandMarkVersion: VERSION }, DEFAULTS, isAccentKey).markVersion, VERSION);
  assert.equal(resolveBrandFields({ ...EMPTY, brandName: 'x', brandMarkVersion: '../../etc' }, DEFAULTS, isAccentKey).markVersion, null);
  assert.equal(isBrandVersion('0123456789ABCDEF'), false);
  assert.equal(isBrandVersion('0123456789abcde'), false);
});

test('the tile an icon set is rendered on: tile, else colour, else the fallback', () => {
  assert.equal(effectiveTileColor({ brandTileColor: '#111111', brandColor: '#222222' }, '#333333'), '#111111');
  assert.equal(effectiveTileColor({ brandTileColor: null, brandColor: '#222222' }, '#333333'), '#222222');
  assert.equal(effectiveTileColor({ brandTileColor: 'nope', brandColor: null }, '#333333'), '#333333');
  assert.equal(effectiveTileColor(null, '#ABC'), '#aabbcc');
});

// ── A person's accent under a brand ──────────────────────────────────────────

test('a stored preference: a key wins; brand only while there is a palette; else the default', () => {
  const withPalette = { accent: BRAND_ACCENT, palette: rampFrom('#0e7490') };
  const without = { accent: 'blue', palette: null };
  assert.equal(resolveAccentChoice('rose', withPalette, isAccentKey), 'rose');
  assert.equal(resolveAccentChoice(BRAND_ACCENT, withPalette, isAccentKey), BRAND_ACCENT);
  assert.equal(resolveAccentChoice(BRAND_ACCENT, without, isAccentKey), 'blue');
  assert.equal(resolveAccentChoice(null, withPalette, isAccentKey), BRAND_ACCENT);
  assert.equal(resolveAccentChoice('garbage', without, isAccentKey), 'blue');
});

// ── Colour maths and palettes ────────────────────────────────────────────────

test('hex normalisation', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' #0E7490 '), '#0e7490');
  assert.equal(normalizeHex('0e7490'), null);
  assert.equal(normalizeHex('#0e749'), null);
  assert.equal(normalizeHex('red'), null);
  assert.equal(normalizeHex('#fff;background:url(x)'), null);
});

test('WCAG contrast matches the known pairs', () => {
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000') * 100) / 100, 21);
  // Tailwind blue-600 under white text — the product's primary button.
  assert.ok(Math.abs(contrastRatio('#2563eb', '#ffffff') - 5.17) < 0.01);
});

test('a palette is ten hexes, lightest first', () => {
  const ramp = rampFrom('#0e7490');
  assert.deepEqual(parsePalette(formatPalette(ramp)), ramp);
  assert.deepEqual(parsePalette(ramp.join(' , ')), ramp);
  assert.equal(parsePalette(ramp.slice(0, 9).join(',')), null);
  assert.equal(parsePalette([...ramp.slice(0, 9), 'url(x)'].join(',')), null);
  assert.equal(parsePalette(''), null);
});

test('a generated ramp keeps its order and always clears AA on the 600 shade', () => {
  // Pale, saturated, dark and grey inputs — the pale ones are the dangerous
  // ones, where a naive ramp puts white text on a light button.
  for (const src of ['#fde047', '#a3e635', '#22d3ee', '#f0abfc', '#0e7490', '#7c3aed', '#111827', '#9ca3af', '#ffffff', '#000000']) {
    const ramp = rampFrom(src);
    assert.equal(ramp.length, PALETTE_STEPS.length, src);
    for (const hex of ramp) assert.match(hex, /^#[0-9a-f]{6}$/, src);
    assert.ok(paletteIsReadable(ramp), `${src}: 600 = ${ramp[6]} at ${contrastRatio(ramp[6], '#ffffff').toFixed(2)}:1`);
    assert.ok(contrastRatio(ramp[6], '#ffffff') >= AA_TEXT, src);
    // Lightness falls monotonically from 50 to 900 (luminance as the proxy).
    const lum = ramp.map((h) => contrastRatio(h, '#000000'));
    for (let i = 1; i < lum.length; i++) assert.ok(lum[i] <= lum[i - 1] + 1e-9, `${src}: step ${PALETTE_STEPS[i]} is lighter than ${PALETTE_STEPS[i - 1]}`);
  }
});

test('an unreadable palette is refused', () => {
  const pale = ['#fefce8', '#fef9c3', '#fef08a', '#fde047', '#facc15', '#eab308', '#ca8a04', '#a16207', '#854d0e', '#713f12'];
  assert.equal(paletteIsReadable(pale), false); // yellow-600 is 2.9:1 under white
});

test('the CSS variables carry nothing but normalized hexes and rgba()', () => {
  const vars = paletteCssVars(rampFrom('#0e7490'));
  assert.deepEqual(Object.keys(vars), [...PALETTE_STEPS.map((s) => `--brand-${s}`), '--brand-tint', '--brand-tint-hover']);
  for (const [k, v] of Object.entries(vars)) {
    assert.match(v, k.startsWith('--brand-tint') ? /^rgba\(\d{1,3},\d{1,3},\d{1,3},0\.\d+\)$/ : /^#[0-9a-f]{6}$/, k);
  }
});

// ── The served-file allowlist ────────────────────────────────────────────────

test('every served kind round-trips through its file name; the source never does', () => {
  for (const kind of BRAND_SERVED_KINDS) assert.equal(brandKindForFile(`${kind}.png`), kind);
  assert.equal(brandKindForFile(`${BRAND_SOURCE_KIND}.png`), null);
  assert.equal(brandKindForFile(BRAND_SOURCE_KIND), null);
  assert.equal(brandKindForFile('source.svg'), null);
  assert.equal(brandKindForFile('icon-192.svg'), null);
  assert.equal(brandKindForFile('icon-192'), null);
  assert.equal(brandKindForFile('../icon-192.png'), null);
  assert.equal(brandKindForFile('splash-1x1.png'), null);
  assert.equal(brandKindForFile('anything.png'), null);
});

test('every launch image the <head> links resolves to a kind the upload renders', () => {
  const links = brandSplashLinks(`/brand/${VERSION}`);
  assert.equal(links.length, APPLE_SPLASH_DEVICES.length);
  links.forEach((link, i) => {
    const { w, h } = splashPixels(APPLE_SPLASH_DEVICES[i]);
    const file = link.url.split('/').pop();
    assert.equal(brandKindForFile(file), splashKind(w, h));
    assert.equal(link.url, brandAssetPath(VERSION, splashKind(w, h)));
  });
});

// ── The deploy log's brand report (prisma/set-public-host.mjs --list) ────────

test('a mapped org with no brand data is flagged, in generic words, without values', () => {
  const org = { id: 'org_1', slug: 'acme', publicHost: 'acme.example.test', ...EMPTY };
  const none = brandReport(org);
  assert.match(none.summary, /name=— mark=— colour=—/);
  assert.match(none.warning, /acme \(org_1\) is mapped to acme\.example\.test but carries no brand data/);

  const some = brandReport({ ...org, brandName: 'Acme Sales', brandColor: '#0e7490', brandMarkVersion: VERSION });
  assert.equal(some.warning, null);
  assert.match(some.summary, new RegExp(`name=set mark=${VERSION} colour=set`));
  assert.doesNotMatch(some.summary, /Acme Sales|#0e7490/);
});
