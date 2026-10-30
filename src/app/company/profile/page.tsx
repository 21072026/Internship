'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { COMPANY_SELF_EDITABLE_FIELDS } from '@/lib/companyVerification';

type Field = (typeof COMPANY_SELF_EDITABLE_FIELDS)[number];
type Form = Record<Field, string>;

const EMPTY: Form = { description: '', logoUrl: '', industry: '', size: '', address: '', contactEmail: '' };

// /company/profile (#1865) — a COMPANY user edits its own company: exactly the
// six fields PUT /api/companies/[id] admits for that role, nothing else. The
// name, the quota and the verification state are the programme's.
export default function CompanyProfilePage() {
  const t = useT();
  const p = t.companyProfile;
  const { data: session } = useSession();
  const companyId = session?.user?.companyId ?? null;
  const [name, setName] = useState('');
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!companyId) return;
    fetch(`/api/companies/${companyId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const c = d?.company;
        if (!c) return;
        setName(c.name ?? '');
        setForm(Object.fromEntries(COMPANY_SELF_EDITABLE_FIELDS.map((f) => [f, c[f] ?? ''])) as Form);
      })
      .finally(() => setLoading(false));
  }, [companyId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/companies/${companyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      setMessage(res.ok ? { ok: true, text: p.saved } : { ok: false, text: p.saveFailed });
    } finally {
      setSaving(false);
    }
  }

  const set = (field: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{p.title}</h1>
        <p className="mt-1 text-gray-500">{name ? p.subtitleFor.replace('{company}', name) : p.subtitle}</p>
      </div>
      <Card>
        {loading ? (
          <p className="py-6 text-center text-gray-400">{t.common.loading}</p>
        ) : (
          <form onSubmit={save} className="space-y-4" data-testid="company-profile-form">
            <div>
              <label htmlFor="cp-description" className="mb-1 block text-sm font-medium text-gray-700">{p.fields.description}</label>
              <Textarea id="cp-description" rows={5} maxLength={2000} showCounter value={form.description} onChange={set('description')} />
            </div>
            <Input id="cp-logo" type="url" label={p.fields.logoUrl} maxLength={191} value={form.logoUrl} onChange={set('logoUrl')} />
            <Input id="cp-industry" label={p.fields.industry} maxLength={191} value={form.industry} onChange={set('industry')} />
            <Input id="cp-size" label={p.fields.size} maxLength={191} value={form.size} onChange={set('size')} />
            <Input id="cp-address" label={p.fields.address} maxLength={191} value={form.address} onChange={set('address')} />
            <Input id="cp-email" type="email" label={p.fields.contactEmail} maxLength={191} value={form.contactEmail} onChange={set('contactEmail')} />
            {message && (
              <p role="status" className={message.ok ? 'text-sm text-green-700' : 'text-sm text-red-600'} data-testid="company-profile-message">
                {message.text}
              </p>
            )}
            <Button type="submit" disabled={saving} data-testid="company-profile-save">{p.save}</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
