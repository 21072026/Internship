'use client';

/* eslint-disable @next/next/no-img-element -- these are committed release
   assets served straight from public/ at the size they were captured;
   next/image would add a loader round-trip and a config entry for a picture
   whose dimensions are already known at build time. */

import { useEffect, useState } from 'react';
import type { Locale } from '@/i18n/config';
import { defaultLocale } from '@/i18n/config';
import type { ReleaseMedia } from '@/lib/releaseNotes';

/**
 * The optional screenshot — or short clip — under a release note (#2233).
 *
 * Three things this component is deliberately NOT:
 *
 * 1. Not a lightbox. The "every image is a button that opens ImageLightbox"
 *    rule (#2147) is about *user-supplied* images, which the reader may need to
 *    inspect. This is repo content, cropped to the one component the note is
 *    about and shown at its natural size; there is nothing to enlarge.
 * 2. Not a paused video for readers who asked for reduced motion. The clip is
 *    only mounted once we know the preference is *not* `reduce` — so on a
 *    reduced-motion machine the poster is what renders and the WebM is never
 *    even fetched. Server render is the poster too, which is also the right
 *    thing for a browser with JS off.
 * 3. Not theme-aware. Captures are taken in the light theme only (two themes
 *    would mean two files per note), so the frame pins a white background even
 *    in dark mode — `dark:!bg-white`, because globals.css retints `.bg-white`
 *    under `html.dark`. A light picture inside a visible border reads as *a
 *    screenshot* rather than as a broken part of the page.
 *
 * `width`/`height` come from the PNG header at build time
 * (scripts/release-media.cjs), so the card reserves the space and the list does
 * not jump when the image arrives. The <video> gets the CLIP's own
 * `videoWidth`/`videoHeight` instead — a poster is a cropped element and a
 * recording is a whole viewport, so handing the poster's aspect ratio to the
 * <video> laid it out too short and `object-fit: contain` then shrank the
 * playing clip into the middle of its own frame.
 */
export function ReleaseNoteMedia({ media, locale }: { media: ReleaseMedia; locale: Locale }) {
  const alt = media.alt[locale] || media.alt[defaultLocale];
  const posterUrl = `/${media.poster}`;
  const [playMotion, setPlayMotion] = useState(false);

  useEffect(() => {
    if (!media.video) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setPlayMotion(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [media.video]);

  const posterSize = media.width && media.height ? { width: media.width, height: media.height } : {};
  const videoSize =
    media.videoWidth && media.videoHeight
      ? { width: media.videoWidth, height: media.videoHeight }
      : /* An older entry compacted before the clip's size was read: no size at
           all beats the poster's wrong one, which would letterbox the clip. */
        {};

  return (
    <figure
      data-testid="release-media"
      className="mt-4 max-w-[480px] overflow-hidden rounded-xl border border-gray-300 bg-white dark:!bg-white dark:border-gray-600"
    >
      {media.video && playMotion ? (
        /* Under five seconds by validation (WCAG 2.2.2), so it needs no pause
           control; muted + playsInline is what lets it autoplay at all. */
        <video
          data-testid="release-media-video"
          className="block h-auto w-full"
          autoPlay
          loop
          muted
          playsInline
          poster={posterUrl}
          aria-label={alt}
          {...videoSize}
        >
          <source src={`/${media.video}`} type="video/webm" />
          {/* Shown by a browser with no <video> at all; a browser that has
              <video> but cannot decode WebM keeps the poster above. */}
          <img src={posterUrl} alt={alt} className="block h-auto w-full" {...posterSize} />
        </video>
      ) : (
        <img
          data-testid="release-media-poster"
          src={posterUrl}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="block h-auto w-full"
          {...posterSize}
        />
      )}
    </figure>
  );
}
