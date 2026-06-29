'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

const KEY = 'cookie_consent';

// First-visit cookie consent banner. The app ships no analytics/marketing
// scripts today, so this records the choice (localStorage + a 1-year cookie)
// for compliance; analytics/marketing categories gate any future scripts.
export function CookieConsent() {
  const t = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      setShow(true);
    }
  }, []);

  const save = (analytics: boolean, marketing: boolean) => {
    const value = JSON.stringify({ necessary: true, analytics, marketing, ts: new Date().toISOString() });
    try { localStorage.setItem(KEY, value); } catch { /* ignore */ }
    document.cookie = `${KEY}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    setShow(false);
  };

  if (!show) return null;

  return (
    <div role="dialog" aria-label={t.cookies.title} className="fixed bottom-0 inset-x-0 z-[200] p-4">
      <div className="max-w-3xl mx-auto bg-white border border-gray-200 shadow-lg rounded-2xl p-5 sm:flex sm:items-center sm:gap-4">
        <div className="flex-1 mb-3 sm:mb-0">
          <p className="text-sm font-semibold text-gray-900">{t.cookies.title}</p>
          <p className="text-xs text-gray-500 mt-1">{t.cookies.body}</p>
        </div>
        <div className="flex flex-wrap gap-2 flex-shrink-0">
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
      </div>
    </div>
  );
}
