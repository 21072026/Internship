'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { useLocale, useT } from '@/i18n/client';
import { AFFILIATE_HEARD_FROM, APPLICATION_LIMITS, type ApplicationField } from '@/lib/affiliateApplicationRule';

// The partner application form (#3361). The server is the judge
// (parseAffiliateApplication); this form keeps what is typed, marks the fields
// the server names and carries the honeypot and the render time the route's
// anti-spam reads. No password field: nobody gets an account from this form.

export function ApplicationForm({ accent }: { accent: string }) {
  const t = useT();
  const L = t.affiliateApply;
  const locale = useLocale();
  const renderedAt = useRef(Date.now());
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', company: '', phone: '', heardFrom: '', heardFromOther: '' });
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot
  const [invalid, setInvalid] = useState<Set<ApplicationField>>(new Set());
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error' | 'closed' | 'limited'>('idle');

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const err = (f: ApplicationField) => (invalid.has(f) ? L.errors[f] : undefined);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setInvalid(new Set());
    try {
      const res = await fetch('/api/partner/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, consent, website, renderedAt: renderedAt.current, locale }),
      });
      if (res.ok) return setState('sent');
      const body = await res.json().catch(() => ({}));
      if (res.status === 400 && Array.isArray(body.fields)) {
        setInvalid(new Set(body.fields as ApplicationField[]));
        return setState('idle');
      }
      setState(res.status === 503 ? 'closed' : res.status === 429 ? 'limited' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-6 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100" role="status" data-testid="affiliate-apply-sent">
        <p className="flex items-center gap-2 font-semibold">
          <Check className="h-5 w-5" aria-hidden="true" />
          {L.sentTitle}
        </p>
        <p className="mt-2 text-sm">{L.sentBody}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900" data-testid="affiliate-apply-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label={L.firstName} required autoComplete="given-name" maxLength={APPLICATION_LIMITS.name} value={form.firstName} onChange={set('firstName')} error={err('firstName')} data-testid="affiliate-apply-firstName" />
        <Input label={L.lastName} required autoComplete="family-name" maxLength={APPLICATION_LIMITS.name} value={form.lastName} onChange={set('lastName')} error={err('lastName')} data-testid="affiliate-apply-lastName" />
      </div>
      <Input label={L.email} type="email" required autoComplete="email" maxLength={APPLICATION_LIMITS.email} value={form.email} onChange={set('email')} error={err('email')} data-testid="affiliate-apply-email" />
      <Input label={L.company} autoComplete="organization" maxLength={APPLICATION_LIMITS.company} value={form.company} onChange={set('company')} error={err('company')} />
      <Input label={L.phone} type="tel" autoComplete="tel" maxLength={APPLICATION_LIMITS.phone} value={form.phone} onChange={set('phone')} error={err('phone')} />
      <Select
        label={L.heardFrom}
        required
        value={form.heardFrom}
        onChange={set('heardFrom')}
        error={err('heardFrom')}
        options={[{ value: '', label: L.choose }, ...AFFILIATE_HEARD_FROM.map((c) => ({ value: c, label: L.heardFromOptions[c] }))]}
        data-testid="affiliate-apply-heardFrom"
      />
      {form.heardFrom === 'other' && (
        <Input label={L.heardFromOther} required maxLength={APPLICATION_LIMITS.heardFromOther} value={form.heardFromOther} onChange={set('heardFromOther')} error={err('heardFromOther')} data-testid="affiliate-apply-heardFromOther" />
      )}

      {/* Honeypot — hidden from people, tempting to bots. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} className="hidden" />

      <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={invalid.has('consent')} data-testid="affiliate-apply-consent" />
        <span>
          {L.consent}{' '}
          <Link href="/privacy" className="underline">
            {L.consentLink}
          </Link>
        </span>
      </label>
      {invalid.has('consent') && <p className="text-sm text-red-600">{L.errors.consent}</p>}
      <p className="text-xs text-gray-500 dark:text-gray-400">{L.nextSteps}</p>

      {state === 'error' && <p className="text-sm text-red-600" role="alert">{L.failed}</p>}
      {state === 'closed' && <p className="text-sm text-red-600" role="alert">{L.closed}</p>}
      {state === 'limited' && <p className="text-sm text-red-600" role="alert">{L.limited}</p>}

      <Button type="submit" disabled={state === 'sending'} className="w-full" style={{ backgroundColor: accent }} data-testid="affiliate-apply-submit">
        {L.submit}
      </Button>
    </form>
  );
}
