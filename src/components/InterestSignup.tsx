'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useT } from '@/i18n/client';
import { utmFromSearch } from '@/lib/inquiryAttribution';

export function InterestSignup() {
  const t = useT().interest;
  const locale = useLocale();
  const renderedAt = useRef(Date.now());
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="max-w-3xl mx-auto px-4 pb-12 text-sm text-gray-600 dark:text-gray-300" data-testid="interest-signup">
    <details><summary className="cursor-pointer text-center underline underline-offset-4">{t.title}</summary>
      {sent ? <p role="status" className="mt-4 text-center">{t.received}</p> : <form className="mt-4 flex flex-wrap items-center justify-center gap-3" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setFailed(false);
        const data = new FormData(e.currentTarget);
        try {
          const res = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            email: data.get('email'), role: data.get('role'), consent: data.get('consent') === 'on',
            website: data.get('website'), renderedAt: renderedAt.current, locale,
            utm: utmFromSearch(window.location.search), referrer: document.referrer,
          }) });
          if (!res.ok) throw new Error(); setSent(true);
        } catch { setFailed(true); } finally { setBusy(false); }
      }}>
        <label>{t.email}<input required name="email" type="email" maxLength={191} autoComplete="email" className="ml-2 rounded border bg-white p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100" /></label>
        <label>{t.role}<select name="role" className="ml-2 rounded border bg-white p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100">{(['MENTEE','MENTOR','COMPANY','OTHER'] as const).map(role => <option key={role} value={role}>{t.roles[role]}</option>)}</select></label>
        <label className="absolute -left-[10000px]" aria-hidden="true">{t.website}<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <label className="basis-full text-center"><input required type="checkbox" name="consent" className="mr-2" />{t.consent} <Link href="/privacy" className="underline">{t.privacy}</Link></label>
        <button disabled={busy} className="rounded border px-3 py-2 disabled:opacity-50">{t.submit}</button>
        {failed && <p role="alert">{t.failed}</p>}
      </form>}
    </details>
  </div>;
}
