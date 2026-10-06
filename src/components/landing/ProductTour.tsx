import { getImageProps } from 'next/image';
import type { Dictionary } from '@/i18n/dictionaries';
import { MARKETING_TOUR_SHOTS, PRODUCT_TOUR_SHOTS, TOUR_SIZE, clipPath, shotPath, type TourShotName } from './productTourShots';
import { TourClip } from './TourClip';

// The landing's product tour (#1399): three real screens, so a visitor sees
// the product before deciding whether to sign up for it. Each product has its
// own set: the internship landing shows the mentee, mentor and company screens;
// the MARKETING (SaleVali) landing shows its pipeline board, a rep's dashboard
// and the funnel analytics — never the other product's screens. The files are
// produced by scripts/capture-landing-screenshots.mjs against the synthetic
// demo seed — see public/screenshots/README.md before replacing one.
//
// Each screen is a still for light/dark × desktop/phone, plus a short desktop
// loop per theme that plays over the still (TourClip).
//   • Theme: the app's dark mode is a class on <html> (set by the visitor's
//     toggle, not only by the OS), which a <picture> media query cannot see —
//     so there are two <picture>s and CSS shows one. A lazy image that is
//     display:none is never fetched, so a visitor downloads one theme only.
//   • Device: a phone gets the phone layout through <source media>, not the
//     desktop capture shrunk to an unreadable thumbnail — and a phone frame
//     instead of the browser window.
//   • Frame: every capture of a device has the same size, so all three sit in
//     one identical frame; that sameness is most of what makes the set look
//     deliberate rather than pasted in.
// `unoptimized`: the files are already sized WebP; running them through the
// image optimizer on the most-hit page in the app would only re-encode them.

const PHONE_MEDIA = '(max-width: 639px)';

function Shot({ name, alt, theme }: { name: TourShotName; alt: string; theme: 'light' | 'dark' }) {
  // `unoptimized` leaves no srcSet to merge: the <img> is the desktop file.
  const { props: img } = getImageProps({
    src: shotPath(name, 'desktop', theme),
    width: TOUR_SIZE.desktop.width,
    height: TOUR_SIZE.desktop.height,
    alt,
    unoptimized: true,
    loading: 'lazy',
    sizes: '(min-width: 1024px) 1024px, 100vw',
  });
  return (
    <picture className={theme === 'dark' ? 'hidden dark:block' : 'block dark:hidden'}>
      <source
        media={PHONE_MEDIA}
        srcSet={shotPath(name, 'phone', theme)}
        width={TOUR_SIZE.phone.width}
        height={TOUR_SIZE.phone.height}
      />
      <img {...img} alt={alt} className="block w-full h-auto" />
    </picture>
  );
}

export function ProductTour({ t, marketing = false }: { t: Dictionary; marketing?: boolean }) {
  const T = t.productTour;
  const M = t.productTourMarketing;
  const copy: Partial<Record<TourShotName, { title: string; body: string; alt: string }>> = marketing
    ? {
        'mkt-pipeline': { title: M.pipelineT, body: M.pipelineD, alt: M.pipelineAlt },
        'mkt-rep': { title: M.repT, body: M.repD, alt: M.repAlt },
        'mkt-insights': { title: M.insightsT, body: M.insightsD, alt: M.insightsAlt },
      }
    : {
        mentee: { title: T.menteeT, body: T.menteeD, alt: T.menteeAlt },
        mentor: { title: T.mentorT, body: T.mentorD, alt: T.mentorAlt },
        company: { title: T.companyT, body: T.companyD, alt: T.companyAlt },
      };
  const shots = marketing ? MARKETING_TOUR_SHOTS : PRODUCT_TOUR_SHOTS;
  // The address bar names the product's own host — what the visitor would type.
  const host = marketing ? 'marketing.bcsit-gmbh.de' : 'interncrm.com';

  return (
    <section className="py-20 sm:py-24 px-4 bg-white border-y border-gray-200" data-testid="landing-product-tour">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center">{marketing ? M.title : T.title}</h2>
        <p className="mt-4 text-center text-gray-600">{marketing ? M.subtitle : T.subtitle}</p>
        <div className="mt-14 space-y-20 lg:space-y-24">
          {shots.map((shot) => {
            const c = copy[shot.name]!;
            return (
              <figure key={shot.name} data-testid={`product-tour-${shot.name}`}>
                {/* Caption above, picture at the full content width: side by
                    side, a desktop capture was shown at half its size and its
                    text could not be read. */}
                <figcaption className="max-w-2xl mx-auto text-center">
                  <h3 className="text-xl font-semibold text-gray-900">{c.title}</h3>
                  <p className="mt-2 text-gray-600 leading-relaxed">{c.body}</p>
                </figcaption>
                {/* One frame, two shapes: a phone (black bezel, rounded screen)
                    below sm, a browser window from sm up. */}
                <div className="mt-8 mx-auto w-full max-w-[18rem] sm:max-w-none overflow-hidden rounded-[2.25rem] border-[10px] border-gray-900 bg-gray-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/15 sm:rounded-xl sm:border sm:border-gray-200 sm:bg-white">
                  <div aria-hidden="true" className="hidden sm:flex items-center gap-2 h-9 px-4 border-b border-gray-200 bg-gray-50">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                    <span className="mx-auto -translate-x-6 rounded-md bg-white px-3 py-0.5 text-xs text-gray-500 border border-gray-200">
                      {host}{shot.path}
                    </span>
                  </div>
                  <div className="relative overflow-hidden rounded-[1.6rem] sm:rounded-none">
                    <Shot name={shot.name} alt={c.alt} theme="light" />
                    <Shot name={shot.name} alt={c.alt} theme="dark" />
                    <TourClip
                      webm={clipPath(shot.name, 'light', 'webm')}
                      mp4={clipPath(shot.name, 'light', 'mp4')}
                      className="hidden sm:block dark:sm:hidden"
                    />
                    <TourClip
                      webm={clipPath(shot.name, 'dark', 'webm')}
                      mp4={clipPath(shot.name, 'dark', 'mp4')}
                      className="hidden dark:sm:block"
                    />
                  </div>
                </div>
              </figure>
            );
          })}
        </div>
      </div>
    </section>
  );
}
