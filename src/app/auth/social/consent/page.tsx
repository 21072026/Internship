'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { useT } from '@/i18n/client';

// Social sign-up's consent step (#1962): the same data-sharing note and the
// same privacy / terms checkbox the register form shows, before a social
// identity becomes a NEW account. The identity itself is in a sealed cookie
// the callback set; this page only sends the person's answer.
export default function SocialConsentPage() {
  const t = useT();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checked) {
      setError(t.auth.consentRequired);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/social/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true, privacyVersion: PRIVACY_POLICY_VERSION }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.redirect === 'string') {
        window.location.href = data.redirect;
        return;
      }
      setError(data.code === 'ticket_expired' ? t.auth.socialConsentExpired : t.auth.socialErrors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      <form onSubmit={submit} data-testid="social-consent" className="w-full max-w-md space-y-4 rounded-2xl border border-gray-200 bg-white p-8 dark:border-gray-700 dark:bg-gray-800">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t.auth.socialConsentTitle}</h1>
        <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-gray-600">
          <p className="mb-1 font-medium text-gray-700">{t.auth.dataSharingTitle}</p>
          <p>{t.auth.dataSharingBody}</p>
        </div>
        <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
          <input type="checkbox" className="mt-0.5" data-testid="social-consent-checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>
            {t.auth.consentNote}{' '}
            <Link href="/privacy" className="text-blue-600 hover:underline">{t.auth.privacyLink}</Link>
            {' '}&{' '}
            <Link href="/terms" className="text-blue-600 hover:underline">{t.auth.termsLink}</Link>
          </span>
        </label>
        {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
        <Button type="submit" className="w-full" size="lg" loading={busy} data-testid="social-consent-submit">
          {t.auth.createAccount}
        </Button>
        <Link href="/auth/signin" className="block text-center text-sm text-blue-600 hover:underline">
          {t.auth.ssoBackToPassword}
        </Link>
      </form>
    </div>
  );
}
