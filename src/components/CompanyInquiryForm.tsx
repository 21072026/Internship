'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Send, Check } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';

// Demo/contact form for companies (#1104). Anti-spam is server-side (honeypot +
// minimum render-to-submit time + rate limit); here we only capture the honeypot
// and the render time. No external captcha — the CSP blocks third-party scripts.
export function CompanyInquiryForm() {
  const t = useT();
  const locale = useLocale();
  const c = t.forCompanies;
  const renderedAt = useRef(Date.now());
  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [openRoles, setOpenRoles] = useState('');
  const [message, setMessage] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consent) {
      setError(c.errorConsent);
      return;
    }
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/company-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          contactName,
          email,
          phone: phone || undefined,
          openRoles: openRoles || undefined,
          message: message || undefined,
          consent,
          locale,
          website,
          renderedAt: renderedAt.current,
        }),
      });
      if (res.ok) {
        setStatus('sent');
        return;
      }
      // Never fail silently (#679): 429 gets its own wording, everything else
      // says plainly that it was our side.
      setError(res.status === 429 ? c.errorRate : c.errorGeneric);
      setStatus('idle');
    } catch {
      setError(c.errorGeneric);
      setStatus('idle');
    }
  };

  if (status === 'sent') {
    return (
      <div
        data-testid="company-inquiry-success"
        className="rounded-2xl border border-green-200 bg-green-50 p-8 text-center"
      >
        <div className="w-12 h-12 rounded-full bg-green-100 text-green-700 flex items-center justify-center mx-auto mb-4">
          <Check className="h-6 w-6" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">{c.successTitle}</h3>
        <p className="text-sm text-gray-600 leading-relaxed max-w-md mx-auto">{c.successBody}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-gray-200 bg-white p-6 sm:p-8 space-y-4">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input label={c.fieldCompany} required value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        <Input label={c.fieldContact} required value={contactName} onChange={(e) => setContactName(e.target.value)} />
        <Input label={c.fieldEmail} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label={c.fieldPhone} value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <Input label={c.fieldRoles} value={openRoles} onChange={(e) => setOpenRoles(e.target.value)} />
      <div>
        <label htmlFor="inquiry-message" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
          {c.fieldMessage}
        </label>
        <Textarea
          id="inquiry-message"
          rows={4}
          maxLength={2000}
          showCounter
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {/* Honeypot — hidden from people, tempting to bots. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        className="hidden"
      />

      <label className="flex items-start gap-2 text-xs text-gray-600">
        <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          {c.consent}{' '}
          <Link href="/privacy" className="text-blue-600 hover:underline">{c.consentLink}</Link>
        </span>
      </label>

      <Button type="submit" size="lg" className="w-full" loading={status === 'sending'}>
        <Send className="h-4 w-4" /> {status === 'sending' ? c.sending : c.submit}
      </Button>
    </form>
  );
}
