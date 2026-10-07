// Machine-translation assist for tenant-authored multilingual text (#2055) —
// the pure half, client-safe, unit-tested in scripts/test/machine-translation.test.mjs.
//
// Every tenant-authored multilingual field stores one per-locale map
// (`Partial<Record<Locale, string>>` — src/lib/announcementText.ts,
// src/lib/goalTemplates.ts, message templates). This module decides what a
// "fill the empty languages" click may touch and keeps the record of which
// locales a machine wrote:
//
//   • ONLY EMPTY LOCALES ARE FILLED. A locale with text — written by a person
//     or already machine-filled — is never sent and never overwritten, on the
//     first click or any re-run. `mergeMachine` enforces it even if a caller
//     passes more than it asked for.
//   • A machine-filled locale is MARKED (`machineTranslated`, stored beside the
//     map) until an admin edits it or confirms it; then it is theirs.

import { defaultLocale, isLocale, locales, type Locale } from '@/i18n/config';

export type LocaleMap = Partial<Record<Locale, string>>;

export const TRANSLATION_PURPOSES = ['announcement', 'goal_template', 'message_template'] as const;
export type TranslationPurpose = (typeof TRANSLATION_PURPOSES)[number];

const filled = (map: LocaleMap, l: Locale) => typeof map[l] === 'string' && (map[l] as string).trim() !== '';

/** The locales with no text yet — the only ones a fill may write. */
export function emptyLocales(map: LocaleMap): Locale[] {
  return locales.filter((l) => !filled(map, l));
}

/** What to translate from: the writer's own locale if filled, then the default, then the first filled one. */
export function pickSource(map: LocaleMap, preferred?: string | null): { locale: Locale; text: string } | null {
  const order = [...(isLocale(preferred) ? [preferred] : []), defaultLocale, ...locales];
  for (const l of order) if (filled(map, l)) return { locale: l, text: (map[l] as string).trim() };
  return null;
}

/**
 * Fold a machine translation in: empty locales only, each one marked. Locales
 * the machine returned for a filled slot are dropped — a human translation is
 * never overwritten, whatever the caller sends.
 */
export function mergeMachine(map: LocaleMap, machine: LocaleMap, marked: readonly string[]): { map: LocaleMap; machineTranslated: Locale[] } {
  const next: LocaleMap = { ...map };
  const mark = new Set(normalizeMachineList(marked, map));
  for (const l of emptyLocales(map)) {
    const text = machine[l];
    if (typeof text === 'string' && text.trim()) {
      next[l] = text.trim();
      mark.add(l);
    }
  }
  return { map: next, machineTranslated: locales.filter((l) => mark.has(l)) };
}

/** A stored or submitted list, reduced to known locales that actually have text. */
export function normalizeMachineList(list: unknown, map: LocaleMap): Locale[] {
  if (!Array.isArray(list)) return [];
  const set = new Set(list.filter((l): l is Locale => typeof l === 'string' && isLocale(l)));
  return locales.filter((l) => set.has(l) && filled(map, l));
}

/** After an edit: a machine locale whose text changed is the admin's now. */
export function afterEdit(prev: LocaleMap, next: LocaleMap, marked: readonly Locale[]): Locale[] {
  return marked.filter((l) => (prev[l] ?? '') === (next[l] ?? '') && filled(next, l));
}
