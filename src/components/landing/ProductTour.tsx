import { getImageProps } from 'next/image';
import type { Dictionary } from '@/i18n/dictionaries';
import { PRODUCT_TOUR_SHOTS, shotPath, type TourShot } from './productTourShots';

// The landing's product tour (#1399): three real screens, so a visitor sees
// the product before deciding whether to sign up for it. The files are
// produced by scripts/capture-landing-screenshots.mjs against the synthetic
// demo seed — see public/screenshots/README.md before replacing one.
//
// Each screen exists four times: light/dark × desktop/phone.
//   • Theme: the app's dark mode is a class on <html> (set by the visitor's
//     toggle, not only by the OS), which a <picture> media query cannot see —
//     so there are two <picture>s and CSS shows one. A lazy image that is
//     display:none is never fetched, so a visitor downloads one theme only.
//   • Device: a phone gets the phone layout through <source media>, not the
//     desktop capture shrunk to an unreadable thumbnail.
// `unoptimized`: the files are already sized WebP; running them through the
// image optimizer on the most-hit page in the app would only re-encode them.

const PHONE_MEDIA = '(max-width: 639px)';

function Shot({ shot, alt, theme }: { shot: TourShot; alt: string; theme: 'light' | 'dark' }) {
  // `unoptimized` leaves no srcSet to merge: the <img> is the desktop file.
  const { props: img } = getImageProps({
    src: shotPath(shot.name, 'desktop', theme),
    width: shot.desktop.width,
    height: shot.desktop.height,
    alt,
    unoptimized: true,
    loading: 'lazy',
    sizes: '(min-width: 1024px) 1024px, 100vw',
  });
  return (
    <picture className={theme === 'dark' ? 'hidden dark:block' : 'block dark:hidden'}>
      <source
        media={PHONE_MEDIA}
        srcSet={shotPath(shot.name, 'phone', theme)}
        width={shot.phone.width}
        height={shot.phone.height}
      />
      <img {...img} alt={alt} className="block w-full h-auto" />
    </picture>
  );
}

export function ProductTour({ t }: { t: Dictionary }) {
  const T = t.productTour;
  const copy = {
    mentee: { title: T.menteeT, body: T.menteeD, alt: T.menteeAlt },
    mentor: { title: T.mentorT, body: T.mentorD, alt: T.mentorAlt },
    company: { title: T.companyT, body: T.companyD, alt: T.companyAlt },
  } as const;

  return (
    <section className="py-20 sm:py-24 px-4 bg-white border-y border-gray-200" data-testid="landing-product-tour">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center">{T.title}</h2>
        <p className="mt-4 text-center text-gray-600">{T.subtitle}</p>
        <div className="mt-14 space-y-16 lg:space-y-20">
          {PRODUCT_TOUR_SHOTS.map((shot) => {
            const c = copy[shot.name];
            return (
              <figure key={shot.name} data-testid={`product-tour-${shot.name}`}>
                {/* Caption above, picture at the full content width: side by
                    side, a desktop capture was shown at half its size and its
                    text could not be read. */}
                <figcaption className="max-w-2xl mx-auto text-center">
                  <h3 className="text-xl font-semibold text-gray-900">{c.title}</h3>
                  <p className="mt-2 text-gray-600 leading-relaxed">{c.body}</p>
                </figcaption>
                {/* A phone capture is tall: cap its width so it reads as a
                    phone screen instead of filling a whole viewport height. */}
                <div className="mt-6 mx-auto w-full max-w-[20rem] sm:max-w-none overflow-hidden rounded-xl border border-gray-200 shadow-lg">
                  <Shot shot={shot} alt={c.alt} theme="light" />
                  <Shot shot={shot} alt={c.alt} theme="dark" />
                </div>
              </figure>
            );
          })}
        </div>
      </div>
    </section>
  );
}
