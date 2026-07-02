'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import {
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
    <div role="dialog" aria-label={t.cookies.title} className="fixed bottom-0 inset-x-0 z-[200] p-4">
      <div className="max-w-3xl mx-auto bg-white border border-gray-200 shadow-lg rounded-2xl p-5">
        <div className="sm:flex sm:items-start sm:gap-4">
          <div className="flex-1 mb-3 sm:mb-0">
            <p className="text-sm font-semibold text-gray-900">{t.cookies.title}</p>
            <p className="text-xs text-gray-500 mt-1">{t.cookies.body}</p>
            <p className="text-xs text-gray-500 mt-2 flex gap-3">
              <Link href="/privacy" className="text-blue-600 hover:underline">{t.cookies.privacyLink}</Link>
              <Link href="/terms" className="text-blue-600 hover:underline">{t.cookies.termsLink}</Link>
            </p>
          </div>
          {!customizing && (
            <div className="flex flex-wrap gap-2 flex-shrink-0">
              <button
                onClick={() => setCustomizing(true)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
              >
                {t.cookies.customize}
              </button>
              <button
                onClick={() => save(false, false)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
              >
                {t.cookies.necessaryOnly}
              </button>
              <button
                onClick={() => save(true, true)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
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
