// The landing's product-tour screenshots (#1399) and their pixel sizes, as
// printed by `npm run capture:landing` (scripts/capture-landing-screenshots.mjs).
// The sizes are the <img>/<source> width and height, so the browser reserves
// the space before a file arrives — update them in the same commit as the
// files. The light and dark captures of one screen share a size.

export type TourShotName = 'mentee' | 'mentor' | 'company';
type Size = { width: number; height: number };
export type TourShot = { name: TourShotName; desktop: Size; phone: Size };

export const PRODUCT_TOUR_SHOTS: TourShot[] = [
  { name: 'mentee', desktop: { width: 1184, height: 789 }, phone: { width: 780, height: 1762 } },
  { name: 'mentor', desktop: { width: 1184, height: 668 }, phone: { width: 780, height: 898 } },
  { name: 'company', desktop: { width: 1184, height: 658 }, phone: { width: 780, height: 1744 } },
];

export function shotPath(name: TourShotName, device: 'desktop' | 'phone', theme: 'light' | 'dark') {
  return `/screenshots/${name}-${device}-${theme}.webp`;
}
