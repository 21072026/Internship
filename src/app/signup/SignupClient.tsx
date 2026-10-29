'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { PasswordRules } from '@/components/auth/PasswordRules';
import { passwordPolicyError, passwordRefusalText, usePasswordPolicy } from '@/lib/passwordPolicyClient';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { browserTimeZone } from '@/lib/timezone';

/**
 * The form that posts to POST /api/public/signup/org (#1749). It never signs
 * anyone in: success is a "check your email" state, because the endpoint
 * deliberately returns no session and the account admits itself through the
 * verification link. A 503 `not_enabled` (the flag was switched off after this
 * page rendered) falls back to the same honest state the server renders.
 */
export function SignupClient() {
  const t = useT();
  const s = t.signup;
  const locale = useLocale();
  // No token: the org-less policy, which is the one the endpoint checks with.
  const pw = usePasswordPolicy(null);
  const [form, setForm] = useState({ orgName: '', fullName: '', email: '', password: '' });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  if (closed) return <SignupSoon />;
  if (sentTo) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center" data-testid="signup-check-email" role="status">
        <MailCheck className="h-10 w-10 text-blue-600 mx-auto" />
        <h2 className="mt-4 text-xl font-semibold text-gray-900">{s.successTitle}</h2>
        <p className="mt-2 text-gray-600">{s.successBody.replace('{email}', sentTo)}</p>
        <Link href="/auth/signin" className="mt-6 inline-block text-sm font-medium text-blue-600 hover:underline">
          {s.signInLink}
        </Link>
      </div>
    );
  }

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!consent) {
      setError(s.consentRequired);
      return;
    }
    const pwError = passwordPolicyError(form.password, pw.policy, t.passwordPolicy);
    if (pwError) {
      setError(pwError);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/public/signup/org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          consent: true,
          privacyVersion: PRIVACY_POLICY_VERSION,
          // The language and clock the account starts in, as /auth/register
          // sends them (#1720, #1210).
          locale,
          timezone: browserTimeZone() ?? undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 503 && body?.code === 'not_enabled') {
        setClosed(true);
        return;
      }
      if (!res.ok) {
        if (res.status === 429) setError(s.errorRate);
        else if (res.status === 409) setError(s.errorUnavailable);
        else setError(passwordRefusalText(body, pw.policy, t.passwordPolicy) ?? s.errorGeneric);
        return;
      }
      setSentTo(form.email.trim());
    } catch {
      setError(s.errorGeneric);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-gray-200 bg-white p-6 sm:p-8 space-y-4" data-testid="signup-form" noValidate>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="signup-error">
          {error}
        </div>
      )}
      <Input label={s.fieldOrg} name="orgName" required maxLength={120} autoComplete="organization" value={form.orgName} onChange={set('orgName')} />
      <Input label={s.fieldName} name="fullName" required maxLength={120} autoComplete="name" value={form.fullName} onChange={set('fullName')} />
      <Input label={s.fieldEmail} name="email" type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
      <Input label={s.fieldPassword} name="password" type="password" required autoComplete="new-password" value={form.password} onChange={set('password')} />
      <PasswordRules policy={pw.policy} rules={pw.rules} value={form.password} breachCheck={pw.breachCheck} />
      <label className="flex items-start gap-2 text-xs text-gray-600">
        <input type="checkbox" name="consent" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          {s.consentNote}{' '}
          <Link href="/privacy" className="text-blue-600 hover:underline">{t.auth.privacyLink}</Link>
          {' '}{s.consentAnd}{' '}
          <Link href="/terms" className="text-blue-600 hover:underline">{t.auth.termsLink}</Link>
        </span>
      </label>
      <Button type="submit" className="w-full" size="lg" loading={loading}>
        {s.submit}
      </Button>
      <p className="text-center text-sm text-gray-600">
        {s.haveAccount}{' '}
        <Link href="/auth/signin" className="font-medium text-blue-600 hover:underline">{s.signIn}</Link>
      </p>
    </form>
  );
}

/** Flag off: say so, and offer the way in that exists today. */
export function SignupSoon() {
  const s = useT().signup;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center" data-testid="signup-opening-soon">
      <h2 className="text-xl font-semibold text-gray-900">{s.soonTitle}</h2>
      <p className="mt-2 text-gray-600">{s.soonBody}</p>
      <Link
        href="/for-companies#talk"
        className="mt-6 inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
      >
        {s.soonCta}
      </Link>
    </div>
  );
}
