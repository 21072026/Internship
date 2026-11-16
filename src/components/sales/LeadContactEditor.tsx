'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { openInteractionDraft } from './interactionDraft';
import { ContactActions } from '@/components/ContactActions';

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

function Row({ label, value, testId, href, onOpen, custom, wide }: { label: string; value: string | null; testId: string; href?: string; onOpen?: () => void; custom?: ReactNode; wide?: boolean }) {
  if (!value) return null;
  return (
    <div data-testid={testId} className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="break-words text-sm text-gray-900 dark:text-gray-100">
        {custom ? (
          custom
        ) : href ? (
          // The device's own phone or mail program does the calling/sending —
          // the CRM sends nothing to a lead (#3741). The click also opens an
          // interaction draft on the page, so the contact is logged.
          <a href={href} onClick={onOpen} className="text-blue-600 hover:underline dark:text-blue-400" data-testid={`${testId}-link`}>
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/** A `tel:` target from a phone as people type it: digits and a leading +, nothing else. */
export function telHref(phone: string): string | undefined {
  const digits = phone.trim().replace(/(?!^\+)[^\d]/g, '');
  return /^\+?\d{3,}$/.test(digits) ? `tel:${digits}` : undefined;
}

export function LeadContactEditor({
  relationId,
  initial,
  canEdit,
  logOnContact = false,
  title,
}: {
  relationId: string;
  initial: LeadContact;
  canEdit: boolean;
  /** The card's heading: drawn here so "Edit contact" can sit on its line, at the right (#3803). */
  title?: ReactNode;
  /**
   * The phone/e-mail links also log the contact (#3741). The e-mail link opens an
   * interaction draft; the phone link asks "Did you reach them?" (#3748, the
   * internship mentor page's flow, which the maintainer asked for here too): Yes
   * logs the call at once, "Add a note" opens the draft instead, No logs nothing.
   */
  logOnContact?: boolean;
}) {
  const onContact = logOnContact ? (type: 'Call' | 'Email') => openInteractionDraft({ type }) : undefined;
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

  const header = (edit?: ReactNode) =>
    title || edit ? (
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-gray-100 pb-3 dark:border-gray-800">
        {title}
        {edit}
      </div>
    ) : null;

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
      <div>
      {header()}
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
      </div>
    );
  }

  return (
    <div>
      {header(
        canEdit ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-testid="sales-lead-contact-edit">
            {s.contactEdit}
          </Button>
        ) : undefined,
      )}
      {empty ? (
        <p className="text-sm text-gray-500" data-testid="sales-lead-contact-empty">{s.contactEmpty}</p>
      ) : (
        // Compact (#3803): two columns — name and position, then the phone — and the
        // e-mail on a line of its own, since it is the long one.
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3" data-testid="sales-lead-contact-person">
          <Row label={s.contactName} value={initial.name} testId="sales-lead-contact-name" />
          <Row label={s.contactPosition} value={initial.position} testId="sales-lead-contact-position" />
          <Row
            label={s.phone}
            value={initial.phone}
            testId="sales-lead-phone"
            href={initial.phone ? telHref(initial.phone) : undefined}
            custom={
              logOnContact && initial.phone && telHref(initial.phone) ? (
                // One way in for one number: the tel: link dials, then the question
                // follows. The only write is ContactActions' POST /api/interactions.
                <ContactActions
                  relationId={relationId}
                  phone={initial.phone}
                  onLogged={() => router.refresh()}
                  onAddNote={(type) => openInteractionDraft({ type })}
                  trigger={(prompt) => (
                    <a
                      href={telHref(initial.phone!)}
                      onClick={() => prompt('Call')}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                      data-testid="sales-lead-phone-link"
                    >
                      {initial.phone}
                    </a>
                  )}
                />
              ) : undefined
            }
          />
          <Row
            wide
            label={s.email}
            value={initial.email}
            testId="sales-lead-email"
            href={initial.email ? `mailto:${initial.email}` : undefined}
            onOpen={onContact ? () => onContact('Email') : undefined}
          />
        </dl>
      )}
    </div>
  );
}
