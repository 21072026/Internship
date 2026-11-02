'use client';

import { useT } from '@/i18n/client';
import { ThemeVideo } from '@/components/partnerTheme/ThemeVideo';
import type { LandingCopy, LandingTheme } from '@/lib/affiliateLandingRule';
import { themeFontFamily } from '@/lib/partnerThemeFonts';
import { LARGE_BUTTON, TEXT_SHADOW, themeLook, type ThemeMedia } from '@/lib/partnerThemeLook';

// A small sketch of /partner in the theme being edited (#3535): the hero, a
// figure card, a step and the closing call, drawn through the same mapping as
// the page (themeLook), so what the admin sees here is what visitors get. The
// words are the copy of the language being edited, else the page's fallbacks.
// Effects are not replayed here; the page itself shows them.
export function ThemePreview({ theme, media, copy }: { theme: LandingTheme; media: ThemeMedia; copy: LandingCopy }) {
  const t = useT();
  const L = t.affiliateLanding;
  const look = themeLook(theme);
  const { p } = look;
  const heading = { fontFamily: themeFontFamily(theme.headingFont) };
  const hero = media.hero;
  const heroInk = !hero ? p.onHero : theme.heroOverlay === 'brand' ? p.onHero : '#ffffff';
  const center = theme.heroAlign === 'center';
  const ctaBand = theme.ctaStyle === 'band';
  const videoLabels = { pause: L.videoPause, play: L.videoPlay };
  const step = copy.steps?.[0];

  return (
    <div
      className="overflow-hidden rounded-lg border border-gray-200 text-sm dark:border-gray-700"
      style={{ backgroundColor: p.background, color: p.text, fontFamily: themeFontFamily(theme.bodyFont), colorScheme: 'light' }}
      data-testid="affiliate-theme-preview"
    >
      <div className={`relative isolate overflow-hidden px-4 ${theme.heroHeight === 'tall' ? 'py-14' : 'py-8'}`} style={{ background: hero ? '#000000' : look.gradient, color: heroInk }}>
        {hero?.kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element -- a just-uploaded file served by our own route
          <img src={hero.url} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover" />
        )}
        {hero?.kind === 'video' && <ThemeVideo src={hero.url} className="absolute inset-0 -z-10 h-full w-full object-cover" labels={videoLabels} />}
        {hero && look.overlay && <div className="absolute inset-0 -z-10" style={look.overlay} aria-hidden="true" />}
        <div className={`mb-6 flex ${theme.navLayout === 'center' ? 'justify-center' : 'justify-start'}`}>
          {media.logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a just-uploaded file served by our own route
            <img src={media.logo.url} alt="" className="h-8 w-auto max-w-[160px] object-contain" />
          ) : (
            <span className="font-bold" style={heading}>{t.affiliateSettings.landing.theme.mediaLabels.logo}</span>
          )}
        </div>
        <div className={center ? 'text-center' : 'text-left'} style={hero && theme.heroOverlay === 'none' ? TEXT_SHADOW : undefined}>
          <p className="text-2xl font-bold leading-tight" style={heading}>{copy.heroTitle ?? L.heroTitle}</p>
          <div className={`mt-4 flex flex-wrap gap-2 ${center ? 'justify-center' : ''}`}>
            <span className={`${LARGE_BUTTON} !px-4 !py-2 !text-base`} style={{ ...look.button('primary'), border: `2px solid ${p.onPrimary}` }}>{copy.applyLabel ?? L.applyLabel}</span>
            <span className={`${LARGE_BUTTON} !px-4 !py-2 !text-base`} style={look.button('secondary')}>{copy.productSignupLabel ?? L.productSignupLabel}</span>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 text-center" style={look.card}>
            <p className="text-xs">{L.stats.activePartners}</p>
            <p className="text-2xl font-bold" style={{ ...heading, color: p.accentLarge }}>120</p>
          </div>
          <div className="p-3" style={look.card}>
            <p className="text-lg font-bold" style={{ ...heading, color: p.accentLarge }}>01</p>
            <p className="font-bold" style={{ ...heading, color: p.heading }}>{step?.title || L.stepsTitle}</p>
          </div>
        </div>
        <div
          className={`p-4 ${ctaBand ? '' : 'border-t'}`}
          style={ctaBand ? { background: look.gradient, color: p.onBand, borderRadius: look.cardRadius } : { borderColor: `${p.text}33` }}
        >
          <p className="text-lg font-bold" style={{ ...heading, color: ctaBand ? p.onBand : p.heading }}>{copy.ctaTitle ?? L.ctaTitle}</p>
          <span className={`${LARGE_BUTTON} mt-3 !px-4 !py-2 !text-base`} style={look.button('primary')}>{copy.ctaApplyLabel ?? L.ctaApplyLabel}</span>
        </div>
      </div>
    </div>
  );
}
