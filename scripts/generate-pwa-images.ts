// Generates the PWA raster assets that are committed under public/ (#2084),
// one set per product mark (#2492):
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
// The renderer itself is shared with the per-organization upload (#2922), so a
// committed default set and an organization's generated set are cut the same
// way — this script only decides WHAT to render and where to write it.
import { SHORTCUT_ICONS, fullBleedPng, markPng, shortcutPng, splashPng } from '../src/lib/brandRender.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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
      await write(`shortcut-${name}${s}-96.png`, shortcutPng(glyph, brand.tile));
    }

    for (const device of APPLE_SPLASH_DEVICES) {
      const { w, h } = splashPixels(device);
      await write(splashHref(device, brand.variant).replace(/^\//, ''), splashPng(logo, w, h));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
