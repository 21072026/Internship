'use client';

// Admin: the programme's public copy and partner contract, per locale. Saving a
// changed contract bumps its version, so every partner accepts it again.

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

type Copy = { title: string; body: string };
type Form = {
  landing: Record<'en' | 'tr' | 'de', Copy>;
  contract: Record<'en' | 'tr' | 'de', string>;
};

const LOCALES = ['en', 'tr', 'de'] as const;
const LANGUAGE_NAMES: Record<(typeof LOCALES)[number], string> = { en: 'English', tr: 'Türkçe', de: 'Deutsch' };
const EMPTY: Form = {
  landing: { en: { title: '', body: '' }, tr: { title: '', body: '' }, de: { title: '', body: '' } },
  contract: { en: '', tr: '', de: '' },
};

export default function AffiliateSettingsPage() {
  const t = useT();
  const a = t.affiliates;
  const [form, setForm] = useState<Form>(EMPTY);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/affiliate/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.settings) {
          setForm({
            landing: { ...EMPTY.landing, ...data.settings.landing },
            contract: { ...EMPTY.contract, ...data.settings.contract },
          });
        }
      });
  }, []);

  async function save() {
    const res = await fetch('/api/admin/affiliate/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        landing: { en: form.landing.en, tr: form.landing.tr.title ? form.landing.tr : undefined, de: form.landing.de.title ? form.landing.de : undefined },
        contract: { en: form.contract.en, tr: form.contract.tr || undefined, de: form.contract.de || undefined },
      }),
    });
    setMessage(res.ok ? a.settingsSaved : `${a.msgNotRecorded}: ${res.status}`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-4 md:p-6">
      <h1 className="text-2xl font-semibold">{a.settingsTitle}</h1>
      {message && <p role="status" className="text-sm">{message}</p>}
      {LOCALES.map((loc) => (
        <section key={loc} className="space-y-3 rounded border p-4">
          <h2 className="text-lg font-medium">{LANGUAGE_NAMES[loc]}</h2>
          <label className="block text-sm">
            {a.fieldTitle}
            <input
              className="mt-1 w-full rounded border p-2"
              value={form.landing[loc].title}
              onChange={(e) => setForm((f) => ({ ...f, landing: { ...f.landing, [loc]: { ...f.landing[loc], title: e.target.value } } }))}
            />
          </label>
          <label className="block text-sm">
            {a.fieldBody}
            <textarea
              rows={4}
              className="mt-1 w-full rounded border p-2"
              value={form.landing[loc].body}
              onChange={(e) => setForm((f) => ({ ...f, landing: { ...f.landing, [loc]: { ...f.landing[loc], body: e.target.value } } }))}
            />
          </label>
          <label className="block text-sm">
            {a.fieldContract}
            <textarea
              rows={10}
              className="mt-1 w-full rounded border p-2"
              value={form.contract[loc]}
              onChange={(e) => setForm((f) => ({ ...f, contract: { ...f.contract, [loc]: e.target.value } }))}
            />
          </label>
        </section>
      ))}
      <button type="button" onClick={save} className="rounded bg-black px-4 py-2 text-white">{a.saveSettings}</button>
    </div>
  );
}
