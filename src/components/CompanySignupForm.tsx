'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useT, useLocale } from '@/i18n/client';

// The employer self-signup form (#1865). The server decides everything that
// matters (free-mail refusal, rate limit, PENDING status); this only collects
// the fields and shows the one outcome the route ever reports for a valid
// submission: "check your inbox" — the same whether the address is new or not.
export function CompanySignupForm() {
  const t = useT();
  const locale = useLocale();
  const s = t.companySignup;
  const renderedAt = useRef(Date.now());
  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [industry, setIndustry] = useState('');
  const [size, setSize] = useState('');
  const [website, setWebsite] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!consent) {
      setError(s.errors.consent_required);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/public/signup/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName, contactName, email,
          industry: industry || undefined, size: size || undefined,
          consent, locale, website, renderedAt: renderedAt.current,
        }),
      });
      if (res.ok) {
        setDone(true);
        return;
      }
      const body = await res.json().catch(() => null);
      const code = body?.code as keyof typeof s.errors | undefined;
      setError((code && s.errors[code]) || s.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-green-900" data-testid="company-signup-done">
        <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <p className="text-sm">{s.done}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} method="post" className="space-y-4" data-testid="company-signup-form">
      <Input id="signup-company" label={s.companyName} required value={companyName} maxLength={191} onChange={(e) => setCompanyName(e.target.value)} />
      <Input id="signup-contact" label={s.contactName} required value={contactName} maxLength={120} onChange={(e) => setContactName(e.target.value)} />
      <Input id="signup-email" type="email" label={s.email} hint={s.emailHint} required value={email} maxLength={191} onChange={(e) => setEmail(e.target.value)} />
      <Input id="signup-industry" label={s.industry} value={industry} maxLength={191} onChange={(e) => setIndustry(e.target.value)} />
      <Input id="signup-size" label={s.size} value={size} maxLength={191} onChange={(e) => setSize(e.target.value)} />

      {/* Honeypot — hidden from people, tempting to bots. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} className="hidden" />

      <label className="flex items-start gap-2 text-xs text-gray-600">
        <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="company-signup-consent" />
        <span>
          {s.consent}{' '}
          <Link href="/privacy" className="text-blue-600 hover:underline">{s.consentLink}</Link>
        </span>
      </label>

      {error && <p role="alert" className="text-sm text-red-600" data-testid="company-signup-error">{error}</p>}
      <Button type="submit" disabled={busy} data-testid="company-signup-submit">{s.submit}</Button>
    </form>
  );
}
