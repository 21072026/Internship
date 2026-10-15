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
import { spawn } from 'node:child_process';
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

/**
 * Wall-clock budget for normalizing one uploaded glyph. Past it the child
 * process doing the work is SIGKILLed — see glyphMaster for why that, and not
 * sharp's own timeout, is the bound.
 */
export const GLYPH_DEADLINE_MS = 15_000;

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

export type GlyphRefusal = 'unreadable' | 'not_square' | 'too_small' | 'too_large' | 'empty' | 'too_complex' | 'busy';

/** Raster uploads must be at least this wide (and as tall). */
export const MIN_RASTER_SIZE = 512;

// The child's whole program. It reads the upload from stdin, normalizes it
// exactly as described on glyphMaster, writes the PNG to stdout and exits 0 —
// or exits with one of GLYPH_EXIT's codes. Plain CommonJS on purpose: it runs
// as `node -e`, so no file of ours has to exist next to the build output, and
// `require('sharp')` resolves from the app's working directory like the app's
// own import does. One libvips thread, no cache: it renders one image and dies.
const GLYPH_EXIT = { unreadable: 10, not_square: 11, too_small: 12, too_large: 13, empty: 14 } as const;
const GLYPH_CHILD_SOURCE = `
'use strict';
const sharp = require('sharp');
sharp.concurrency(1);
sharp.cache(false);
const kind = process.env.GLYPH_KIND;
const MAX = Number(process.env.GLYPH_MAX_PIXELS);
const MASTER = Number(process.env.GLYPH_MASTER_SIZE);
const MIN_RASTER = Number(process.env.GLYPH_MIN_RASTER);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const bytes = Buffer.concat(chunks);
  try {
    let density = 72;
    if (kind === 'raster') {
      const meta = await sharp(bytes, { limitInputPixels: MAX }).metadata();
      if (!meta.width || !meta.height) process.exit(${GLYPH_EXIT.unreadable});
      if (meta.width !== meta.height) process.exit(${GLYPH_EXIT.not_square});
      if (meta.width < MIN_RASTER) process.exit(${GLYPH_EXIT.too_small});
    } else {
      const meta = await sharp(bytes, { density: 72, limitInputPixels: MAX }).metadata();
      const side = Math.max(meta.width || 0, meta.height || 0);
      if (!side) process.exit(${GLYPH_EXIT.unreadable});
      density = Math.min(4800, Math.max(1, (72 * MASTER) / side));
    }
    const png = await sharp(bytes, { density, limitInputPixels: MAX })
      .resize(MASTER, MASTER, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .png()
      .toBuffer();
    const alpha = (await sharp(png).stats()).channels[3];
    if (!alpha || alpha.max === 0) process.exit(${GLYPH_EXIT.empty});
    process.stdout.write(png, () => process.exit(0));
  } catch (e) {
    process.exit(/pixel limit|exceeds/i.test(String((e && e.message) || e)) ? ${GLYPH_EXIT.too_large} : ${GLYPH_EXIT.unreadable});
  }
});
`;

/** The largest PNG the child may hand back (a 1024² RGBA PNG is far below it). */
const GLYPH_MAX_OUTPUT = 16 * 1024 * 1024;

type GlyphResult = { ok: true; png: Buffer } | { ok: false; reason: GlyphRefusal };

function runGlyphChild(input: GlyphInput, deadlineMs: number): Promise<GlyphResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GlyphResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // A minimal environment: the child needs no secret of the app's, and gets
    // none (no DATABASE_URL, no NEXTAUTH_SECRET, no SMTP password).
    const child = spawn(process.execPath, ['--max-old-space-size=256', '-e', GLYPH_CHILD_SOURCE], {
      cwd: process.cwd(),
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? '',
        GLYPH_KIND: input.kind,
        GLYPH_MAX_PIXELS: String(MAX_INPUT_PIXELS),
        GLYPH_MASTER_SIZE: String(MASTER_SIZE),
        GLYPH_MIN_RASTER: String(MIN_RASTER_SIZE),
      } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, reason: 'too_complex' });
    }, deadlineMs);
    const out: Buffer[] = [];
    let outBytes = 0;
    child.stdout.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > GLYPH_MAX_OUTPUT) {
        child.kill('SIGKILL');
        done({ ok: false, reason: 'unreadable' });
        return;
      }
      out.push(c);
    });
    child.on('error', () => done({ ok: false, reason: 'unreadable' }));
    child.on('close', (code) => {
      if (code === 0 && outBytes > 0) return done({ ok: true, png: Buffer.concat(out) });
      const reason = (Object.keys(GLYPH_EXIT) as (keyof typeof GLYPH_EXIT)[]).find((k) => GLYPH_EXIT[k] === code);
      done({ ok: false, reason: reason ?? 'unreadable' });
    });
    // The child may die before it has read everything (a kill, a crash); a
    // write to its closed stdin must not become an unhandled error here.
    child.stdin.on('error', () => {});
    child.stdin.end(input.bytes);
  });
}

// One normalization at a time per process: a hostile file costs at most one
// core for GLYPH_DEADLINE_MS, never all of them, and never the libuv threadpool
// the rest of the app shares (the work is in another process entirely).
let glyphSlot: Promise<unknown> | null = null;

/**
 * The uploaded glyph normalized to a MASTER_SIZE² transparent PNG, or the
 * reason it cannot be. An SVG is assumed to have passed validateSvgMark()
 * already (src/lib/svgMark.ts) — this function only rasterizes it, at a density
 * that makes its intrinsic size land on the master size instead of upscaling a
 * 64px rendering. Both paths decode under `limitInputPixels`.
 *
 * WHY A CHILD PROCESS. The upload is the one place untrusted bytes reach the
 * decoder, and neither of the in-process bounds holds there: sharp's
 * `.timeout()` is checked between libvips strips, while librsvg renders a
 * filtered element in one call, and a worker thread cannot be stopped in the
 * middle of native code either. So the decode runs in a separate Node process
 * that is SIGKILLed at GLYPH_DEADLINE_MS ('too_complex'). Everything after
 * this — every icon and launch image — is cut from the PNG it returns, in
 * process, from our own markup.
 *
 * `wait: false` (the upload) answers 'busy' instead of queueing behind a render
 * already running; `wait: true` (re-rendering a stored mark after a tile-colour
 * change) queues. `deadlineMs` exists for the unit test; the app never passes it.
 */
export async function glyphMaster(input: GlyphInput, opts: { wait?: boolean; deadlineMs?: number } = {}): Promise<GlyphResult> {
  if (glyphSlot && !opts.wait) return { ok: false, reason: 'busy' };
  while (glyphSlot) await glyphSlot.catch(() => {});
  const run = runGlyphChild(input, opts.deadlineMs ?? GLYPH_DEADLINE_MS);
  glyphSlot = run;
  try {
    return await run;
  } finally {
    if (glyphSlot === run) glyphSlot = null;
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
