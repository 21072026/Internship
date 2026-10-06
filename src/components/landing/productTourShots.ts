// The landing's product-tour captures (#1399), produced by
// `npm run capture:landing` (scripts/capture-landing-screenshots.mjs).
//
// Every capture of one device has the SAME size — the whole viewport, 16:10 on
// desktop and the phone's own 390×844 at 2x — so the tour reads as one set in
// one frame. The first version cropped each screen to its content and shipped
// six different aspect ratios, which is what made it look improvised. The sizes
// are the <img>/<source> width and height (the browser reserves the space
// before a file arrives); the script writes exactly these, so they only change
// together with it.

export type TourShotName = 'mentee' | 'mentor' | 'company' | 'mkt-pipeline' | 'mkt-rep' | 'mkt-insights';
type Device = 'desktop' | 'phone';
type Theme = 'light' | 'dark';

export const TOUR_SIZE: Record<Device, { width: number; height: number }> = {
  desktop: { width: 1600, height: 1000 },
  phone: { width: 780, height: 1688 },
};

export type TourShot = { name: TourShotName; path: string };

/** The internship landing's three screens. `path` is the address shown in the desktop frame's address bar — where the screen lives. */
export const PRODUCT_TOUR_SHOTS: TourShot[] = [
  { name: 'mentee', path: '/portal/journey' },
  { name: 'mentor', path: '/mentor/board' },
  { name: 'company', path: '/company/candidates' },
];

/** The MARKETING (SaleVali) landing's three screens, captured on the marketing host against the `demo-marketing` tenant. */
export const MARKETING_TOUR_SHOTS: TourShot[] = [
  { name: 'mkt-pipeline', path: '/admin/board' },
  { name: 'mkt-rep', path: '/sales' },
  { name: 'mkt-insights', path: '/admin/analytics' },
];

export type TourLocale = 'en' | 'tr' | 'de';

/** English keeps the original unsuffixed names; Turkish and German captures carry `-tr` / `-de`. */
const suffix = (locale: TourLocale) => (locale === 'en' ? '' : `-${locale}`);

export function shotPath(name: TourShotName, device: Device, theme: Theme, locale: TourLocale = 'en') {
  return `/screenshots/${name}-${device}-${theme}${suffix(locale)}.webp`;
}

/** The desktop clip of a screen (WebM first, MP4 for the browsers without VP9). */
export function clipPath(name: TourShotName, theme: Theme, ext: 'webm' | 'mp4', locale: TourLocale = 'en') {
  return `/screenshots/${name}-desktop-${theme}${suffix(locale)}.${ext}`;
}
