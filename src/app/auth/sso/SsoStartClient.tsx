'use client';

import { useState } from 'react';
import { useT } from '@/i18n/client';

// Enterprise SSO entry (#545). A user whose organization uses SSO enters their
// org's short code (slug); we hand off to the SP-initiated login route, which
// redirects to the tenant's IdP. Password sign-in stays the default at
// /auth/signin — this is only reached by SSO-enabled tenants.
export function SsoStartClient() {
  const t = useT();
  const [slug, setSlug] = useState('');

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const s = slug.trim().toLowerCase();
    if (s) window.location.href = `/api/auth/sso/${encodeURIComponent(s)}/login`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <form onSubmit={go} className="w-full max-w-sm bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t.auth.ssoTitle}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t.auth.ssoSubtitle}
        </p>
        <input
          data-testid="sso-slug-input"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="organization-code"
          autoFocus
          className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3.5 py-2.5 text-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100 focus:outline-none"
        />
        <button
          type="submit"
          data-testid="sso-continue"
          disabled={!slug.trim()}
          className="w-full rounded-lg bg-blue-600 text-white py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {t.auth.ssoContinue}
        </button>
        <a href="/auth/signin" className="block text-center text-sm text-blue-600 hover:underline">
          {t.auth.ssoBackToPassword}
        </a>
      </form>
    </div>
  );
}
