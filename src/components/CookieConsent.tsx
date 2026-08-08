'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { useFixedBottomInset } from '@/hooks/useFixedBottomInset';
import {
  COOKIE_CONSENT_EVENT,
  COOKIE_CONSENT_KEY,
  COOKIE_CONSENT_VERSION,
  readCookieConsent,
} from '@/lib/cookieConsent';

// First-visit categorized cookie consent banner (necessary / analytics /
// marketing). The app ships no analytics/marketing scripts today, so this
// records the versioned choice (localStorage + a 1-year cookie) and provides
// the gate (see lib/cookieConsent hasConsent) for any future scripts. Re-prompts
// when the stored consent version is older than the current one.
export function CookieConsent() {
  const t = useT();
  const [show, setShow] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);

  // While the banner is up, reserve its height at the bottom of the document so
  // it can never sit on top of a page's primary button (#935).
  useFixedBottomInset(bannerRef, show);

  useEffect(() => {
    // Show when there's no consent for the current version yet.
    if (!readCookieConsent()) setShow(true);
  }, []);

  const save = (a: boolean, m: boolean) => {
    const value = JSON.stringify({
      version: COOKIE_CONSENT_VERSION,
      necessary: true,
      analytics: a,
      marketing: m,
      ts: new Date().toISOString(),
    });
    try { localStorage.setItem(COOKIE_CONSENT_KEY, value); } catch { /* ignore */ }
    document.cookie = `${COOKIE_CONSENT_KEY}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    // Let consent-gated scripts (the tawk.to chat, #1174) react to the choice
    // immediately instead of only on the next page load.
    window.dispatchEvent(new Event(COOKIE_CONSENT_EVENT));
    setShow(false);
  };

  if (!show) return null;

  const Toggle = ({ label, desc, checked, onChange, disabled }: {
    label: string; desc: string; checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean;
  }) => (
    <label className="flex items-start gap-3 py-2">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">
          {label}{disabled && <span className="ml-2 text-xs text-gray-400">({t.cookies.always})</span>}
        </span>
        <span className="block text-xs text-gray-500">{desc}</span>
      </span>
    </label>
  );

  return (
    <div
      ref={bannerRef}
      role="dialog"
      aria-label={t.cookies.title}
      data-testid="cookie-banner"
      className="fixed bottom-0 inset-x-0 z-[200] p-3 sm:p-4"
      // Notched phones: keep the banner off the home bar. env() resolves to 0
      // where there is no inset, so this is a no-op on every other device.
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="max-w-3xl mx-auto bg-white border border-gray-200 shadow-lg rounded-2xl p-4 sm:p-5">
        <div className="sm:flex sm:items-start sm:gap-4">
          <div className="flex-1 mb-3 sm:mb-0">
            <p className="text-sm font-semibold text-gray-900">{t.cookies.title}</p>
            {/* Two lines is enough on a phone — the banner used to fill 40% of the
                viewport there; the full sentence shows from sm: up. */}
            <p className="text-xs text-gray-500 mt-1 line-clamp-2 sm:line-clamp-none">{t.cookies.body}</p>
            <p className="text-xs text-gray-500 mt-2 flex gap-3">
              <Link href="/privacy" className="text-blue-600 hover:underline">{t.cookies.privacyLink}</Link>
              <Link href="/terms" className="text-blue-600 hover:underline">{t.cookies.termsLink}</Link>
            </p>
          </div>
          {!customizing && (
            /* One compact row on a phone (wrapping made the banner two buttons tall),
               the original inline group from sm: up. */
            <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:flex-shrink-0">
              <button
                onClick={() => setCustomizing(true)}
                className="px-2 py-2 sm:px-3 rounded-lg text-xs sm:text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
              >
                {t.cookies.customize}
              </button>
              <button
                onClick={() => save(false, false)}
                className="px-2 py-2 sm:px-3 rounded-lg text-xs sm:text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
              >
                {t.cookies.necessaryOnly}
              </button>
              <button
                onClick={() => save(true, true)}
                className="px-2 py-2 sm:px-3 rounded-lg text-xs sm:text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
              >
                {t.cookies.acceptAll}
              </button>
            </div>
          )}
        </div>

        {customizing && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <div className="divide-y divide-gray-50">
              <Toggle label={t.cookies.necessary} desc={t.cookies.necessaryDesc} checked disabled />
              <Toggle label={t.cookies.analytics} desc={t.cookies.analyticsDesc} checked={analytics} onChange={setAnalytics} />
              <Toggle label={t.cookies.marketing} desc={t.cookies.marketingDesc} checked={marketing} onChange={setMarketing} />
            </div>
            <div className="flex flex-wrap justify-end gap-2 mt-3">
              <button
                onClick={() => save(false, false)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
              >
                {t.cookies.necessaryOnly}
              </button>
              <button
                onClick={() => save(analytics, marketing)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
              >
                {t.cookies.savePreferences}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
