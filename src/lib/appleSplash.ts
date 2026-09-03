// iOS launch ("splash") screens for the installed PWA (#2084).
//
// Safari does not read the web app manifest for launch images: it wants one
// <link rel="apple-touch-startup-image"> per device resolution, matched by a
// media query. Hand-listing seventeen of those in the layout is unreadable and
// rots the moment Apple ships a new screen size, so the device table lives here
// and both the <link> tags (src/app/layout.tsx) and the image generator
// (scripts/generate-pwa-images.mjs) are derived from it.
//
// Portrait only, deliberately: a launch image shows for a fraction of a second
// and a missing one costs a blank flash, not a broken app — doubling the asset
// count to cover landscape is not worth the repository weight.

export type AppleSplashDevice = {
  /** CSS width in points. */
  width: number;
  /** CSS height in points. */
  height: number;
  /** devicePixelRatio. */
  ratio: number;
  /** What this row covers — for humans, never rendered. */
  devices: string;
};

export const APPLE_SPLASH_DEVICES: AppleSplashDevice[] = [
  { width: 320, height: 568, ratio: 2, devices: 'iPhone SE (1st gen), 5s' },
  { width: 375, height: 667, ratio: 2, devices: 'iPhone SE (2nd/3rd gen), 8, 7, 6s' },
  { width: 414, height: 736, ratio: 3, devices: 'iPhone 8 Plus, 7 Plus, 6s Plus' },
  { width: 375, height: 812, ratio: 3, devices: 'iPhone X, XS, 11 Pro, 12 mini, 13 mini' },
  { width: 414, height: 896, ratio: 2, devices: 'iPhone XR, 11' },
  { width: 414, height: 896, ratio: 3, devices: 'iPhone XS Max, 11 Pro Max' },
  { width: 390, height: 844, ratio: 3, devices: 'iPhone 12, 12 Pro, 13, 13 Pro, 14' },
  { width: 428, height: 926, ratio: 3, devices: 'iPhone 12/13 Pro Max, 14 Plus' },
  { width: 393, height: 852, ratio: 3, devices: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { width: 430, height: 932, ratio: 3, devices: 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus' },
  { width: 402, height: 874, ratio: 3, devices: 'iPhone 16 Pro' },
  { width: 440, height: 956, ratio: 3, devices: 'iPhone 16 Pro Max' },
  { width: 768, height: 1024, ratio: 2, devices: 'iPad mini, iPad 9.7"' },
  { width: 810, height: 1080, ratio: 2, devices: 'iPad 10.2"' },
  { width: 834, height: 1112, ratio: 2, devices: 'iPad Air 10.5"' },
  { width: 834, height: 1194, ratio: 2, devices: 'iPad Pro 11"' },
  { width: 1024, height: 1366, ratio: 2, devices: 'iPad Pro 12.9"' },
];

/** Pixel dimensions of the image a device needs. */
export function splashPixels(d: AppleSplashDevice): { w: number; h: number } {
  return { w: d.width * d.ratio, h: d.height * d.ratio };
}

/** Public path of the generated image for a device. */
export function splashHref(d: AppleSplashDevice): string {
  const { w, h } = splashPixels(d);
  return `/splash/apple-splash-${w}x${h}.png`;
}

/** The media query Safari matches a launch image with. */
export function splashMedia(d: AppleSplashDevice): string {
  return `(device-width: ${d.width}px) and (device-height: ${d.height}px) and (-webkit-device-pixel-ratio: ${d.ratio}) and (orientation: portrait)`;
}

/** `icons.other` entries for the root layout's metadata. */
export function appleSplashLinks(): { rel: string; url: string; media: string }[] {
  return APPLE_SPLASH_DEVICES.map((d) => ({
    rel: 'apple-touch-startup-image',
    url: splashHref(d),
    media: splashMedia(d),
  }));
}
