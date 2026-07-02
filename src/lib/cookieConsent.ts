// Cookie-consent storage + versioning. Bump COOKIE_CONSENT_VERSION when the
// categories or their meaning change — the banner re-prompts when the stored
// version is older, so consent stays current (GDPR/TTDSG demonstrability).
export const COOKIE_CONSENT_KEY = 'cookie_consent';
export const COOKIE_CONSENT_VERSION = 2;

export interface CookieConsentValue {
  version: number;
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  ts: string;
}

// Read the stored consent (client-only). Returns null if absent, unparseable,
// or from an older version (so callers treat it as "not yet consented").
export function readCookieConsent(): CookieConsentValue | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CookieConsentValue>;
    if (!parsed || parsed.version !== COOKIE_CONSENT_VERSION) return null;
    return parsed as CookieConsentValue;
  } catch {
    return null;
  }
}

// Whether an optional category may load its scripts. Necessary is always true.
export function hasConsent(category: 'necessary' | 'analytics' | 'marketing'): boolean {
  if (category === 'necessary') return true;
  return readCookieConsent()?.[category] ?? false;
}
