// The PWA icon renderer (#2084, #2922) — ONE renderer for both the committed
// default sets under public/ (scripts/generate-pwa-images.ts) and the sets an
// organization's uploaded mark generates (src/lib/brandAssets.ts), so the two
// can never drift into different geometry.
//
// No relative imports on purpose: this module is loaded by Next (the upload
// route), by Node directly (the generator script, `--experimental-strip-types`)
// and by `node --test` (scripts/test/brand-render.test.mjs). A relative `.ts`
// import works in only one of those, so anything it needs — the iOS device
// sizes above all — is passed in by the caller.
//
// GEOMETRY. Every built-in mark is the same drawing: a 64-unit square tile with
// 14-unit rounded corners and the glyph inset 9 units on every side (46 of 64).
// An organization uploads only the GLYPH (transparent background) and picks a
// tile colour; `composeMark` rebuilds that drawing from the two, and everything
// downstream treats the result exactly like a committed mark SVG.
import sharp from 'sharp';

/** Bumped when the generated output changes shape, so every stored set gets a new version. */
export const RENDER_VERSION = 1;

const WHITE = '#ffffff';
const TILE = 64;
const TILE_RADIUS = 14;
const GLYPH_INSET = 9;

/** The resolution every uploaded glyph is normalized to before anything is cut from it. */
export const MASTER_SIZE = 1024;

/** Upper bound on the pixels sharp will decode from an upload (a 4096² image). */
export const MAX_INPUT_PIXELS = 4096 * 4096;

/** A libvips operation that runs longer than this is abandoned (a hostile file, not a logo). */
const RENDER_TIMEOUT_SECONDS = 20;

function hex(colour: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(colour)) throw new Error(`not a #rrggbb colour: ${colour}`);
  return colour;
}

/** A 96x96 shortcut icon: the brand tile with a white line glyph on it. */
export function shortcutSvg(glyph: string, tile: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
      `<rect width="96" height="96" rx="21" fill="${tile}"/>` +
      `<g transform="translate(24 24) scale(2)" fill="none" stroke="#ffffff" stroke-width="2" ` +
      `stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`
  );
}

// lucide glyphs on a 24x24 grid — the same marks the app uses in its own nav.
export const SHORTCUT_ICONS: { name: 'messages' | 'todos' | 'notifications'; glyph: string }[] = [
  // message-square
  { name: 'messages', glyph: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  // check-square
  {
    name: 'todos',
    glyph: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  },
  // bell
  {
    name: 'notifications',
    glyph: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  },
];

/** A shortcut icon rendered to PNG. */
export async function shortcutPng(glyph: string, tile: string): Promise<Buffer> {
  return sharp(shortcutSvg(glyph, tile)).resize(96, 96).png({ compressionLevel: 9 }).toBuffer();
}

/** The mark rasterised at `size`, keeping its own rounded corners (transparent). */
export async function markPng(logo: Buffer, size: number): Promise<Buffer> {
  return sharp(logo, { density: 384 }).resize(size, size).png().toBuffer();
}

/**
 * A full-bleed square: the tile colour edge to edge, the mark inset to `inset`
 * of the side. The mark's own rounded tile is the same colour, so it dissolves
 * into the background and only the glyph reads — which is what a masked
 * launcher icon (safe zone = inner 80%) and an iOS home-screen icon need.
 */
export async function fullBleedPng(logo: Buffer, tile: string, size: number, inset: number): Promise<Buffer> {
  const mark = await markPng(logo, Math.round(size * inset));
  return sharp({ create: { width: size, height: size, channels: 4, background: tile } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * One iOS launch screen: the mark at ~28% of the short edge, centred on white —
 * big enough to read, small enough that it never crowds a 320pt phone.
 */
export async function splashPng(logo: Buffer, w: number, h: number): Promise<Buffer> {
  const size = Math.round(Math.min(w, h) * 0.28);
  const mark = await markPng(logo, size);
  return sharp({ create: { width: w, height: h, channels: 4, background: WHITE } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

export type GlyphInput = { kind: 'svg' | 'raster'; bytes: Buffer };

export type GlyphRefusal = 'unreadable' | 'not_square' | 'too_small' | 'too_large' | 'empty';

/** Raster uploads must be at least this wide (and as tall). */
export const MIN_RASTER_SIZE = 512;

/**
 * The uploaded glyph normalized to a MASTER_SIZE² transparent PNG, or the
 * reason it cannot be. An SVG is assumed to have passed validateSvgMark()
 * already (src/lib/svgMark.ts) — this function only rasterizes it, at a density
 * that makes its intrinsic size land on the master size instead of upscaling a
 * 64px rendering. Both paths decode under `limitInputPixels` and a timeout.
 */
export async function glyphMaster(input: GlyphInput): Promise<{ ok: true; png: Buffer } | { ok: false; reason: GlyphRefusal }> {
  try {
    if (input.kind === 'raster') {
      const meta = await sharp(input.bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      if (!meta.width || !meta.height) return { ok: false, reason: 'unreadable' };
      if (meta.width !== meta.height) return { ok: false, reason: 'not_square' };
      if (meta.width < MIN_RASTER_SIZE) return { ok: false, reason: 'too_small' };
    }
    let density = 72;
    if (input.kind === 'svg') {
      const meta = await sharp(input.bytes, { density: 72, limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      const side = Math.max(meta.width ?? 0, meta.height ?? 0);
      if (!side) return { ok: false, reason: 'unreadable' };
      density = Math.min(4800, Math.max(1, (72 * MASTER_SIZE) / side));
    }
    const png = await sharp(input.bytes, { density, limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: RENDER_TIMEOUT_SECONDS })
      .resize(MASTER_SIZE, MASTER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .png()
      .toBuffer();
    const stats = await sharp(png).stats();
    const alpha = stats.channels[3];
    if (!alpha || alpha.max === 0) return { ok: false, reason: 'empty' };
    return { ok: true, png };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (/pixel limit|exceeds/i.test(message)) return { ok: false, reason: 'too_large' };
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * The full mark at `size`: the tile (rounded corners, transparent outside them)
 * with the glyph inset on it — the drawing of public/icon.svg, rebuilt from a
 * glyph and a colour. The tile is OUR markup with a validated colour; the
 * glyph only ever arrives here as pixels.
 */
export async function composeMark(glyph: Buffer, tile: string, size: number): Promise<Buffer> {
  const radius = (TILE_RADIUS / TILE) * size;
  const tileSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" fill="${hex(tile)}"/></svg>`,
  );
  const inner = Math.round(((TILE - 2 * GLYPH_INSET) / TILE) * size);
  const g = await sharp(glyph).resize(inner, inner).png().toBuffer();
  return sharp(tileSvg)
    .composite([{ input: g, gravity: 'centre' }])
    .png()
    .toBuffer();
}

export type RenderedAsset = { kind: string; png: Buffer };

/**
 * Every served kind of one organization's set, from its normalized glyph and
 * tile colour. `splash` is the list of iOS launch-image pixel sizes
 * (APPLE_SPLASH_DEVICES through splashPixels, src/lib/appleSplash.ts) and
 * `splashKind` names each one — passed in, see the header.
 */
export async function renderBrandSet(input: {
  glyph: Buffer;
  tile: string;
  splash: { w: number; h: number }[];
  splashKind: (w: number, h: number) => string;
}): Promise<RenderedAsset[]> {
  const tile = hex(input.tile);
  // The master mark is a PNG at full resolution; every size below is cut from
  // it exactly the way the generator cuts the committed sets from an SVG.
  const mark = await composeMark(input.glyph, tile, MASTER_SIZE);
  const out: RenderedAsset[] = [
    { kind: 'mark-128', png: await sharp(input.glyph).resize(128, 128).png({ compressionLevel: 9 }).toBuffer() },
    { kind: 'icon-192', png: await markPng(mark, 192) },
    { kind: 'icon-512', png: await markPng(mark, 512) },
    { kind: 'icon-512-maskable', png: await fullBleedPng(mark, tile, 512, 0.8) },
    { kind: 'apple-touch-icon', png: await fullBleedPng(mark, tile, 180, 1) },
    { kind: 'favicon-32', png: await markPng(mark, 32) },
  ];
  for (const { name, glyph } of SHORTCUT_ICONS) {
    out.push({ kind: `shortcut-${name}-96`, png: await shortcutPng(glyph, tile) });
  }
  for (const { w, h } of input.splash) {
    out.push({ kind: input.splashKind(w, h), png: await splashPng(mark, w, h) });
  }
  return out;
}
