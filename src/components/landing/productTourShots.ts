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

export type TourShotName = 'mentee' | 'mentor' | 'company';
type Device = 'desktop' | 'phone';
type Theme = 'light' | 'dark';

export const TOUR_SIZE: Record<Device, { width: number; height: number }> = {
  desktop: { width: 1600, height: 1000 },
  phone: { width: 780, height: 1688 },
};

/** The address shown in the desktop frame's address bar — where the screen lives. */
export const PRODUCT_TOUR_SHOTS: { name: TourShotName; path: string }[] = [
  { name: 'mentee', path: '/portal/journey' },
  { name: 'mentor', path: '/mentor/board' },
  { name: 'company', path: '/company/candidates' },
];

export function shotPath(name: TourShotName, device: Device, theme: Theme) {
  return `/screenshots/${name}-${device}-${theme}.webp`;
}

/** The desktop clip of a screen (WebM first, MP4 for the browsers without VP9). */
export function clipPath(name: TourShotName, theme: Theme, ext: 'webm' | 'mp4') {
  return `/screenshots/${name}-desktop-${theme}.${ext}`;
}
