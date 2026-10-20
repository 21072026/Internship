// The partner contract's version rules (docs/affiliate-module.md, decision 14).
//
// PURE: the text is per-organisation data; this file only decides which version is
// current, whether a partner must accept it again, and which locale to show.
// Nothing here knows any organisation's name or wording.

export type LocaleMap = Partial<Record<'en' | 'tr' | 'de', string>>;

/**
 * The text for one locale, falling back to English, then to the empty string. An
 * organisation that wrote only one language still gets a contract to show.
 */
export function localizedText(map: LocaleMap | null | undefined, locale: string): string {
  if (!map) return '';
  return (map as Record<string, string | undefined>)[locale] ?? map.en ?? '';
}

/**
 * The next contract version after an edit. The version moves only when the text
 * really changes, so saving the same wording again does not re-ask every partner.
 */
export function nextContractVersion(current: number, before: LocaleMap | null, after: LocaleMap): number {
  return JSON.stringify(before ?? {}) === JSON.stringify(after) ? current : current + 1;
}

/** A partner must accept the current version; accepting an older one does not count. */
export function needsContractAcceptance(acceptedVersions: readonly number[], currentVersion: number): boolean {
  return !acceptedVersions.includes(currentVersion);
}
