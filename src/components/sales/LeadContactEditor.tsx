'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { TEXT_LIMITS } from '@/lib/textLimits';

// The lead's contact on its record page (#3655): the account's primary contact
// — name, position, e-mail, phone — shown and, for the record's rep (or an
// admin), corrected in place. The server is the judge
// (PATCH /api/sales/leads/[id]/contact, src/lib/salesLeadContact.ts); this
// form only sends what is typed and shows the answer.

export interface LeadContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
}

function Row({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  if (!value) return null;
  return (
    <div data-testid={testId}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="break-words text-sm text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}

export function LeadContactEditor({ relationId, initial, canEdit }: { relationId: string; initial: LeadContact; canEdit: boolean }) {
  const t = useT();
  const s = t.sales.lead;
  const toast = useToast();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: initial.name ?? '', email: initial.email ?? '', phone: initial.phone ?? '', position: initial.position ?? '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const empty = !initial.name && !initial.email && !initial.phone && !initial.position;

  async function save() {
    if (!form.name.trim()) {
      setError(s.contactNameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sales/leads/${relationId}/contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(body.changed?.length ? s.contactSaved : s.contactUnchanged);
        setEditing(false);
        router.refresh();
        return;
      }
      setError(res.status === 400 ? s.contactInvalid : body.code === 'duplicate_email' ? s.contactDuplicate : s.contactSaveFailed);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    const field = (key: keyof typeof form, label: string, max: number, type = 'text') => (
      <Input
        label={label}
        type={type}
        value={form[key]}
        maxLength={max}
        disabled={busy}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        data-testid={`sales-lead-contact-input-${key}`}
      />
    );
    return (
      <div className="space-y-3" data-testid="sales-lead-contact-form">
        {field('name', s.contactName, TEXT_LIMITS.companyContactName)}
        {field('position', s.contactPosition, TEXT_LIMITS.companyContactPosition)}
        {field('email', s.email, TEXT_LIMITS.companyContactEmail, 'email')}
        {field('phone', s.phone, TEXT_LIMITS.companyContactPhone, 'tel')}
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert" data-testid="sales-lead-contact-error">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy} onClick={() => void save()} data-testid="sales-lead-contact-save">
            {s.contactSave}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setError(null);
              setForm({ name: initial.name ?? '', email: initial.email ?? '', phone: initial.phone ?? '', position: initial.position ?? '' });
            }}
          >
            {s.contactCancel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {empty ? (
        <p className="text-sm text-gray-500" data-testid="sales-lead-contact-empty">{s.contactEmpty}</p>
      ) : (
        <dl className="grid grid-cols-1 gap-4" data-testid="sales-lead-contact-person">
          <Row label={s.contactName} value={initial.name} testId="sales-lead-contact-name" />
          <Row label={s.contactPosition} value={initial.position} testId="sales-lead-contact-position" />
          <Row label={s.email} value={initial.email} testId="sales-lead-email" />
          <Row label={s.phone} value={initial.phone} testId="sales-lead-phone" />
        </dl>
      )}
      {canEdit && (
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-testid="sales-lead-contact-edit">
          {s.contactEdit}
        </Button>
      )}
    </div>
  );
}
