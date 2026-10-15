import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  MASTER_SIZE,
  MIN_RASTER_SIZE,
  composeMark,
  glyphMaster,
  renderBrandSet,
} from '../../src/lib/brandRender.ts';
import { BRAND_SERVED_KINDS, brandKindForFile, splashKind } from '../../src/lib/brandRule.ts';
import { APPLE_SPLASH_DEVICES, splashPixels } from '../../src/lib/appleSplash.ts';

// The renderer behind an organization's uploaded mark (#2922) — the same
// functions the committed default icon sets are cut with
// (scripts/generate-pwa-images.ts). Pinned here: every kind is produced, at the
// size its consumer expects, as a real PNG; the full-bleed icons have no
// transparent corner (iOS paints one black); the launch images match the
// device table one for one; and an upload that cannot be a mark is refused.
//
// The glyph is a synthetic square-and-circle, the tile a synthetic colour.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TILE = '#0e7490';
const GLYPH_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#fde047"/><rect x="18" y="18" width="12" height="12" fill="#111827"/></svg>',
);
const SPLASH = APPLE_SPLASH_DEVICES.map(splashPixels);

async function corners(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  const w = info.width - 1;
  const h = info.height - 1;
  return [at(0, 0), at(w, 0), at(0, h), at(w, h)];
}

let rendered;
async function set() {
  if (!rendered) {
    const glyph = await glyphMaster({ kind: 'svg', bytes: GLYPH_SVG });
    assert.equal(glyph.ok, true);
    rendered = await renderBrandSet({ glyph: glyph.png, tile: TILE, splash: SPLASH, splashKind });
  }
  return rendered;
}

test('an SVG glyph is normalized to a transparent square master', async () => {
  const glyph = await glyphMaster({ kind: 'svg', bytes: GLYPH_SVG });
  assert.equal(glyph.ok, true);
  const meta = await sharp(glyph.png).metadata();
  assert.equal(meta.width, MASTER_SIZE);
  assert.equal(meta.height, MASTER_SIZE);
  assert.equal(meta.hasAlpha, true);
  // The circle does not reach the corners: they stay transparent.
  for (const c of await corners(glyph.png)) assert.equal(c.a, 0);
});

test('every served kind and one launch image per device are rendered, as PNG', async () => {
  const out = await set();
  const kinds = out.map((a) => a.kind);
  for (const kind of BRAND_SERVED_KINDS) assert.ok(kinds.includes(kind), `missing ${kind}`);
  for (const { w, h } of SPLASH) assert.ok(kinds.includes(splashKind(w, h)), `missing splash ${w}x${h}`);
  assert.equal(kinds.length, BRAND_SERVED_KINDS.length + SPLASH.length);
  assert.equal(new Set(kinds).size, kinds.length, 'a kind rendered twice');
  for (const { kind, png } of out) {
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, `${kind} is not a PNG`);
    // And the public route will serve it: every rendered kind is on the allowlist.
    assert.equal(brandKindForFile(`${kind}.png`), kind);
  }
});

test('each icon has the size its consumer expects', async () => {
  const out = Object.fromEntries((await set()).map((a) => [a.kind, a.png]));
  const expected = {
    'mark-128': 128,
    'icon-192': 192,
    'icon-512': 512,
    'icon-512-maskable': 512,
    'apple-touch-icon': 180,
    'favicon-32': 32,
    'shortcut-messages-96': 96,
    'shortcut-todos-96': 96,
    'shortcut-notifications-96': 96,
  };
  for (const [kind, size] of Object.entries(expected)) {
    const meta = await sharp(out[kind]).metadata();
    assert.equal(meta.width, size, kind);
    assert.equal(meta.height, size, kind);
  }
});

test('the 17 launch images match the device table pixel for pixel', async () => {
  const out = Object.fromEntries((await set()).map((a) => [a.kind, a.png]));
  assert.equal(SPLASH.length, 17);
  for (const { w, h } of SPLASH) {
    const meta = await sharp(out[splashKind(w, h)]).metadata();
    assert.equal(meta.width, w);
    assert.equal(meta.height, h);
    // White behind the mark, edge to edge.
    for (const c of await corners(out[splashKind(w, h)])) assert.deepEqual([c.r, c.g, c.b], [255, 255, 255]);
  }
});

test('full-bleed icons are opaque tile colour to the corners; the "any" icons keep rounded transparent corners', async () => {
  const out = Object.fromEntries((await set()).map((a) => [a.kind, a.png]));
  const tile = [0x0e, 0x74, 0x90];
  for (const kind of ['apple-touch-icon', 'icon-512-maskable']) {
    for (const c of await corners(out[kind])) {
      assert.equal(c.a, 255, `${kind} has a transparent corner — iOS paints it black`);
      assert.deepEqual([c.r, c.g, c.b], tile, kind);
    }
  }
  for (const kind of ['icon-192', 'icon-512', 'favicon-32']) {
    for (const c of await corners(out[kind])) assert.equal(c.a, 0, `${kind} should keep its rounded corner`);
  }
});

test('the composed mark puts the tile under the glyph, inset 9/64 per side', async () => {
  const glyph = await glyphMaster({ kind: 'svg', bytes: GLYPH_SVG });
  const mark = await composeMark(glyph.png, TILE, 64);
  const { data, info } = await sharp(mark).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
  // Inside the tile but outside the glyph box (x=5 < 9): tile colour.
  assert.deepEqual(px(5, 32).slice(0, 3), [0x0e, 0x74, 0x90]);
  // The very centre is the glyph's dark square.
  assert.deepEqual(px(32, 32).slice(0, 3), [0x11, 0x18, 0x27]);
});

test('a raster glyph must be square and at least 512 px', async () => {
  const square = await sharp({ create: { width: MIN_RASTER_SIZE, height: MIN_RASTER_SIZE, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
  assert.equal((await glyphMaster({ kind: 'raster', bytes: square })).ok, true);
  const wide = await sharp({ create: { width: 800, height: 600, channels: 4, background: '#000000' } }).png().toBuffer();
  assert.deepEqual(await glyphMaster({ kind: 'raster', bytes: wide }), { ok: false, reason: 'not_square' });
  const small = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#000000' } }).png().toBuffer();
  assert.deepEqual(await glyphMaster({ kind: 'raster', bytes: small }), { ok: false, reason: 'too_small' });
  const webp = await sharp({ create: { width: 600, height: 600, channels: 4, background: '#334455' } }).webp().toBuffer();
  assert.equal((await glyphMaster({ kind: 'raster', bytes: webp })).ok, true);
});

test('garbage and an empty drawing are refused, not rendered', async () => {
  assert.deepEqual(await glyphMaster({ kind: 'raster', bytes: Buffer.from('not an image') }), { ok: false, reason: 'unreadable' });
  assert.deepEqual(await glyphMaster({ kind: 'svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>') }), {
    ok: false,
    reason: 'empty',
  });
});

test('a decompression bomb is refused by the pixel limit', async () => {
  // A 1-bit-ish PNG that DECODES to 5000x5000 (25M px > the 4096² limit).
  const bomb = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#000000' } }).png({ compressionLevel: 9, palette: true }).toBuffer();
  const v = await glyphMaster({ kind: 'raster', bytes: bomb });
  assert.equal(v.ok, false);
  assert.ok(['too_large', 'unreadable'].includes(v.reason), v.reason);
});

// A file the validator would refuse (src/lib/svgMark.ts) but that reaches the
// renderer anyway — the deadline is the bound for whatever slips past the rules.
// Six chained dilations of a huge radius: one uninterruptible librsvg call
// each, which sharp's own timeout never interrupts.
const SLOW_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><filter id="f" x="-50%" y="-50%" width="200%" height="200%">' +
    '<feMorphology operator="dilate" radius="1000000"/>'.repeat(6) +
    '</filter><rect width="64" height="64" fill="#0e7490" filter="url(#f)"/></svg>',
);

test('a render that outlives its deadline is killed, not waited for', async () => {
  const started = Date.now();
  const v = await glyphMaster({ kind: 'svg', bytes: SLOW_SVG }, { deadlineMs: 1000 });
  const elapsed = Date.now() - started;
  // A fast machine may finish inside a second; then the file simply renders.
  if (!v.ok) assert.equal(v.reason, 'too_complex');
  assert.ok(elapsed < 5000, `took ${elapsed} ms`);
});

test('one render at a time: an upload answers busy, a re-render queues', async () => {
  const first = glyphMaster({ kind: 'svg', bytes: SLOW_SVG }, { deadlineMs: 800 });
  assert.deepEqual(await glyphMaster({ kind: 'svg', bytes: GLYPH_SVG }), { ok: false, reason: 'busy' });
  const queued = glyphMaster({ kind: 'svg', bytes: GLYPH_SVG }, { wait: true });
  await first;
  assert.equal((await queued).ok, true);
  // And the slot is free again afterwards.
  assert.equal((await glyphMaster({ kind: 'svg', bytes: GLYPH_SVG })).ok, true);
});

test('the same glyph and tile render the same bytes — a re-upload is the same version', async () => {
  const a = await glyphMaster({ kind: 'svg', bytes: GLYPH_SVG });
  const b = await glyphMaster({ kind: 'svg', bytes: GLYPH_SVG });
  assert.deepEqual(a.png, b.png);
});
