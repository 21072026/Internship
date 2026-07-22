'use client';

import { useState } from 'react';

// Enterprise SSO entry (#545). A user whose organization uses SSO enters their
// org's short code (slug); we hand off to the SP-initiated login route, which
// redirects to the tenant's IdP. Password sign-in stays the default at
// /auth/signin — this is only reached by SSO-enabled tenants.
export default function SsoStartPage() {
  const [slug, setSlug] = useState('');

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const s = slug.trim().toLowerCase();
    if (s) window.location.href = `/api/auth/sso/${encodeURIComponent(s)}/login`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <form onSubmit={go} className="w-full max-w-sm bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Sign in with SSO</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Enter your organization code to continue to your identity provider.
        </p>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="organization-code"
          autoFocus
          className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3.5 py-2.5 text-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!slug.trim()}
          className="w-full rounded-lg bg-blue-600 text-white py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          Continue
        </button>
        <a href="/auth/signin" className="block text-center text-sm text-blue-600 hover:underline">
          Back to password sign-in
        </a>
      </form>
    </div>
  );
}
