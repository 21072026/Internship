// Generates the PWA raster assets that are committed under public/ (#2084):
//
//   public/splash/apple-splash-<w>x<h>.png   iOS launch screens, one per device
//   public/shortcut-<name>-96.png            manifest shortcut icons (96x96)
//
// Both are derived from the app mark (src/app/icon.svg) and the brand colour,
// so re-running this after a logo change keeps every size in step. Run with:
//
//   npm run gen:pwa-images
//
// The output is committed: a build must never depend on this script, and the
// manifest must never point at a file that only exists on someone's laptop.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { APPLE_SPLASH_DEVICES, splashHref, splashPixels } from '../src/lib/appleSplash.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = '#1D4ED8';
const BACKGROUND = '#ffffff';

const logo = readFileSync(join(root, 'src/app/icon.svg'));

/** A 96x96 shortcut icon: the brand tile with a white line glyph on it. */
function shortcutSvg(glyph: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
      `<rect width="96" height="96" rx="21" fill="${BRAND}"/>` +
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

async function main() {
  mkdirSync(join(root, 'public/splash'), { recursive: true });

  for (const { name, glyph } of SHORTCUT_ICONS) {
    const out = join(root, `public/shortcut-${name}-96.png`);
    await sharp(shortcutSvg(glyph)).resize(96, 96).png({ compressionLevel: 9 }).toFile(out);
    console.log(`wrote public/shortcut-${name}-96.png`);
  }

  for (const device of APPLE_SPLASH_DEVICES) {
    const { w, h } = splashPixels(device);
    // The mark sits at ~28% of the short edge — big enough to read, small
    // enough that it never crowds a 320pt phone.
    const size = Math.round(Math.min(w, h) * 0.28);
    const mark = await sharp(logo).resize(size, size).png().toBuffer();
    const png = await sharp({ create: { width: w, height: h, channels: 4, background: BACKGROUND } })
      .composite([{ input: mark, gravity: 'centre' }])
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    const href = splashHref(device);
    writeFileSync(join(root, 'public', href.replace(/^\//, '')), png);
    console.log(`wrote public${href} (${device.devices})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
