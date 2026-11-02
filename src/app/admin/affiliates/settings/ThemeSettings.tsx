'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import {
  DEFAULT_THEME,
  FONT_KEYS,
  THEME_COLOR_KEYS,
  THEME_IMAGE_TYPES,
  THEME_MEDIA_KINDS,
  THEME_MEDIA_SLOTS,
  THEME_OPTIONS,
  THEME_VIDEO_TYPES,
  parseHexColor,
  type FontKey,
  type LandingCopy,
  type LandingTheme,
  type ThemeMediaSlot,
  type ThemeOptionKey,
} from '@/lib/affiliateLandingRule';
import { themeFontLabel } from '@/lib/partnerThemeFonts';
import type { ThemeMedia } from '@/lib/partnerThemeLook';
import { ThemePreview } from './ThemePreview';

// The look of the public programme page (#3535), part of the landing form: the
// theme is saved with the copy through the same PUT (saveLanding), so an
// unchanged save still writes nothing. The server judges every value — the
// colour pairs for contrast, the media ids for ownership — and names refused
// fields by path (`theme.colors.text`, `theme.media.hero`); `err` maps them here.
// An upload is stored at once (the preview needs its URL) and only becomes part
// of the page when the landing is saved.

const UPLOAD_ERRORS = ['missing', 'unsupported', 'too_large', 'mismatch', 'too_many'] as const;

interface Props {
  theme: LandingTheme | null;
  onChange: (theme: LandingTheme | null) => void;
  media: ThemeMedia;
  onMedia: (media: ThemeMedia) => void;
  copy: LandingCopy;
  err: (path: string) => string | undefined;
}

export function ThemeSettings({ theme, onChange, media, onMedia, copy, err }: Props) {
  const t = useT();
  const T = t.affiliateSettings.landing.theme;
  const [uploading, setUploading] = useState<ThemeMediaSlot | null>(null);
  const [uploadError, setUploadError] = useState<Partial<Record<ThemeMediaSlot, string>>>({});
  // What the hex fields show while being typed; the theme takes a value once it parses.
  const [hexText, setHexText] = useState<Partial<Record<string, string>>>({});

  if (!theme) {
    return (
      <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800" data-testid="affiliate-theme">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{T.title}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">{T.hint}</p>
        <Button type="button" variant="outline" onClick={() => onChange(DEFAULT_THEME)} data-testid="affiliate-theme-enable">
          {T.enable}
        </Button>
      </div>
    );
  }

  const set = (patch: Partial<LandingTheme>) => onChange({ ...theme, ...patch });
  const setColor = (key: (typeof THEME_COLOR_KEYS)[number], raw: string) => {
    setHexText({ ...hexText, [key]: raw });
    const hex = parseHexColor(raw);
    if (hex) set({ colors: { ...theme.colors, [key]: hex } });
  };

  async function upload(slot: ThemeMediaSlot, file: File | undefined) {
    if (!file) return;
    setUploading(slot);
    setUploadError({ ...uploadError, [slot]: undefined });
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/admin/affiliate/settings/landing/assets', { method: 'POST', body });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        onMedia({ ...media, [slot]: { url: json.url, kind: json.kind } });
        set({ media: { ...theme!.media, [slot]: json.id } });
      } else {
        const code = (UPLOAD_ERRORS as readonly string[]).includes(json.code) ? (json.code as (typeof UPLOAD_ERRORS)[number]) : 'failed';
        setUploadError({ ...uploadError, [slot]: T.uploadErrors[code] });
      }
    } catch {
      setUploadError({ ...uploadError, [slot]: T.uploadErrors.failed });
    } finally {
      setUploading(null);
    }
  }

  const accept = (slot: ThemeMediaSlot) =>
    [...THEME_IMAGE_TYPES, ...(THEME_MEDIA_KINDS[slot].includes('video') ? THEME_VIDEO_TYPES : [])].join(',');
  const fontOptions = FONT_KEYS.map((f) => ({ value: f, label: themeFontLabel(f) }));
  const layoutKeys = (Object.keys(THEME_OPTIONS) as ThemeOptionKey[]).filter((k) => k !== 'animation');

  return (
    <div className="space-y-6 border-t border-gray-200 pt-4 dark:border-gray-800" data-testid="affiliate-theme">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{T.title}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">{T.hint}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} data-testid="affiliate-theme-disable">
          {T.disable}
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-gray-800 dark:text-gray-200">{T.colors}</legend>
            <p className="text-sm text-gray-600 dark:text-gray-400">{T.colorHint}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {THEME_COLOR_KEYS.map((key) => (
                <div key={key} className="flex items-end gap-2">
                  <input
                    type="color"
                    aria-label={T.colorLabels[key]}
                    value={theme.colors[key]}
                    onChange={(e) => {
                      setHexText({ ...hexText, [key]: e.target.value });
                      set({ colors: { ...theme.colors, [key]: e.target.value } });
                    }}
                    className="mb-1 h-10 w-12 shrink-0 cursor-pointer rounded border border-gray-300 bg-transparent p-0.5 dark:border-gray-600"
                    data-testid={`affiliate-theme-color-${key}-picker`}
                  />
                  <div className="min-w-0 flex-1">
                    <Input
                      label={T.colorLabels[key]}
                      value={hexText[key] ?? theme.colors[key]}
                      maxLength={7}
                      spellCheck={false}
                      error={err(`theme.colors.${key}`)}
                      onChange={(e) => setColor(key, e.target.value)}
                      data-testid={`affiliate-theme-color-${key}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">{T.fonts}</legend>
            <Select
              label={T.headingFont}
              value={theme.headingFont}
              options={fontOptions}
              error={err('theme.headingFont')}
              onChange={(e) => set({ headingFont: e.target.value as FontKey })}
              data-testid="affiliate-theme-headingFont"
            />
            <Select
              label={T.bodyFont}
              value={theme.bodyFont}
              options={fontOptions}
              error={err('theme.bodyFont')}
              onChange={(e) => set({ bodyFont: e.target.value as FontKey })}
              data-testid="affiliate-theme-bodyFont"
            />
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">{T.layout}</legend>
            {[...layoutKeys, 'animation' as const].map((key) => (
              <Select
                key={key}
                label={T.options[key].label}
                hint={key === 'animation' ? T.animationHint : undefined}
                value={theme[key]}
                options={(THEME_OPTIONS[key] as readonly string[]).map((v) => ({ value: v, label: (T.options[key] as Record<string, string>)[v] }))}
                error={err(`theme.${key}`)}
                onChange={(e) => set({ [key]: e.target.value } as Partial<LandingTheme>)}
                data-testid={`affiliate-theme-${key}`}
              />
            ))}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-gray-800 dark:text-gray-200">{T.media}</legend>
            <p className="text-sm text-gray-600 dark:text-gray-400">{T.mediaHint}</p>
            {THEME_MEDIA_SLOTS.map((slot) => {
              const current = media[slot];
              const id = `affiliate-theme-media-${slot}`;
              return (
                <div key={slot} className="flex flex-wrap items-center gap-3" data-testid={id}>
                  <div className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
                    {theme.media[slot] && current?.kind === 'image' && (
                      // eslint-disable-next-line @next/next/no-img-element -- an upload served by our own route
                      <img src={current.url} alt="" className="h-full w-full object-contain" />
                    )}
                    {theme.media[slot] && current?.kind === 'video' && <video src={current.url} muted playsInline preload="metadata" className="h-full w-full object-cover" aria-hidden="true" />}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <label htmlFor={`${id}-file`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">{T.mediaLabels[slot]}</label>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        id={`${id}-file`}
                        type="file"
                        accept={accept(slot)}
                        disabled={uploading !== null}
                        onChange={(e) => {
                          void upload(slot, e.target.files?.[0]);
                          e.target.value = '';
                        }}
                        className="max-w-full text-sm text-gray-700 file:mr-2 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium dark:text-gray-300 dark:file:bg-gray-800 dark:file:text-gray-200"
                        data-testid={`${id}-input`}
                      />
                      {theme.media[slot] && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => set({ media: { ...theme.media, [slot]: null } })}>
                          {T.removeMedia}
                        </Button>
                      )}
                      {uploading === slot && <span className="text-sm text-gray-600 dark:text-gray-400">{T.uploading}</span>}
                    </div>
                    {(uploadError[slot] || err(`theme.media.${slot}`)) && (
                      <p className="text-sm text-red-600" role="alert">{uploadError[slot] ?? err(`theme.media.${slot}`)}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </fieldset>
        </div>

        <div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{T.preview}</h4>
            <a href="/partner" target="_blank" rel="noopener" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
              {T.openPage}
            </a>
          </div>
          <ThemePreview theme={theme} media={Object.fromEntries(THEME_MEDIA_SLOTS.filter((s) => theme.media[s]).map((s) => [s, media[s]]).filter(([, m]) => m))} copy={copy} />
          <p className="text-xs text-gray-600 dark:text-gray-400">{T.previewHint}</p>
        </div>
      </div>
    </div>
  );
}
