// Generates the PWA raster assets that are committed under public/ (#2084),
// one set per product mark (#2356):
//
//   public/icon[-salevali]-192.png, -512.png     manifest icons (purpose: any)
//   public/icon[-salevali]-512-maskable.png      full-bleed tile for launchers that mask
//   public/apple-touch-icon[-salevali].png       iOS home-screen icon (180, full-bleed:
//                                                iOS paints transparent corners black)
//   public/shortcut-<name>[-salevali]-96.png     manifest shortcut icons (96x96)
//   public/splash/apple-splash-<w>x<h>[-salevali].png   iOS launch screens, one per device
//
// Everything is derived from the two marks in public/ (icon.svg — the
// internship cap on blue; icon-salevali.svg — the SaleVali mark on its purple
// tile) and each tile colour, so re-running this after a logo change keeps
// every size of both products in step. Run with:
//
//   npm run gen:pwa-images
//
// The output is committed: a build must never depend on this script, and the
// manifest must never point at a file that only exists on someone's laptop.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { APPLE_SPLASH_DEVICES, splashHref, splashPixels, type SplashVariant } from '../src/lib/appleSplash.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKGROUND = '#ffffff';

type Brand = {
  /** File-name suffix: '' for the internship set, '-salevali' for SaleVali. */
  suffix: '' | '-salevali';
  variant: SplashVariant;
  /** The rounded-tile mark under public/. */
  logo: string;
  /** The tile colour behind the mark — also the full-bleed fill of the maskable icon. */
  tile: string;
};

const BRANDS: Brand[] = [
  { suffix: '', variant: '', logo: 'public/icon.svg', tile: '#1D4ED8' },
  { suffix: '-salevali', variant: 'salevali', logo: 'public/icon-salevali.svg', tile: '#1a0a2e' },
];

/** A 96x96 shortcut icon: the brand tile with a white line glyph on it. */
function shortcutSvg(glyph: string, tile: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
      `<rect width="96" height="96" rx="21" fill="${tile}"/>` +
      `<g transform="translate(24 24) scale(2)" fill="none" stroke="#ffffff" stroke-width="2" ` +
      `stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`
  );
}

// lucide glyphs on a 24x24 grid — the same marks the app uses in its own nav.
const SHORTCUT_ICONS: { name: string; glyph: string }[] = [
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

/** The mark rasterised at `size`, keeping its own rounded corners (transparent). */
async function markPng(logo: Buffer, size: number): Promise<Buffer> {
  return sharp(logo, { density: 384 }).resize(size, size).png().toBuffer();
}

/**
 * A full-bleed square: the tile colour edge to edge, the mark inset to `inset`
 * of the side. The mark's own rounded tile is the same colour, so it dissolves
 * into the background and only the glyph reads — which is what a masked
 * launcher icon (safe zone = inner 80%) and an iOS home-screen icon need.
 */
async function fullBleedPng(logo: Buffer, tile: string, size: number, inset: number): Promise<Buffer> {
  const mark = await markPng(logo, Math.round(size * inset));
  return sharp({ create: { width: size, height: size, channels: 4, background: tile } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function write(rel: string, png: Buffer | Promise<Buffer>) {
  await sharp(await png).toFile(join(root, 'public', rel));
  console.log(`wrote public/${rel}`);
}

async function main() {
  mkdirSync(join(root, 'public/splash'), { recursive: true });

  for (const brand of BRANDS) {
    const logo = readFileSync(join(root, brand.logo));
    const s = brand.suffix;

    await write(`icon${s}-192.png`, markPng(logo, 192));
    await write(`icon${s}-512.png`, markPng(logo, 512));
    await write(`icon${s}-512-maskable.png`, fullBleedPng(logo, brand.tile, 512, 0.8));
    await write(`apple-touch-icon${s}.png`, fullBleedPng(logo, brand.tile, 180, 1));

    for (const { name, glyph } of SHORTCUT_ICONS) {
      await write(
        `shortcut-${name}${s}-96.png`,
        sharp(shortcutSvg(glyph, brand.tile)).resize(96, 96).png({ compressionLevel: 9 }).toBuffer()
      );
    }

    for (const device of APPLE_SPLASH_DEVICES) {
      const { w, h } = splashPixels(device);
      // The mark sits at ~28% of the short edge — big enough to read, small
      // enough that it never crowds a 320pt phone.
      const size = Math.round(Math.min(w, h) * 0.28);
      const mark = await markPng(logo, size);
      const png = sharp({ create: { width: w, height: h, channels: 4, background: BACKGROUND } })
        .composite([{ input: mark, gravity: 'centre' }])
        .png({ compressionLevel: 9, palette: true })
        .toBuffer();
      await write(splashHref(device, brand.variant).replace(/^\//, ''), png);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
