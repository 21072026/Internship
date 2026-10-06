'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { Dictionary } from '@/i18n/dictionaries';

// The ADMIN's editor for an account's address book (#2442) on
// /admin/companies/[id]. Every action is one request to
// /api/companies/[id]/contacts…, then a server re-render: the page's other
// cards (the contact columns, the contact permission) read the primary
// contact too, so they must follow a swap.

export type EditableContact = {
  id: string;
  isPrimary: boolean;
  name: string;
  email: string | null;
  phone: string | null;
  position: string | null;
};

type Labels = Dictionary['companyDetail']['contacts'];
type Draft = { name: string; email: string; phone: string; position: string };

const EMPTY: Draft = { name: '', email: '', phone: '', position: '' };
const draftOf = (c: EditableContact): Draft => ({
  name: c.name,
  email: c.email ?? '',
  phone: c.phone ?? '',
  position: c.position ?? '',
});

function ContactFields({ draft, onChange, labels, idPrefix }: { draft: Draft; onChange: (d: Draft) => void; labels: Labels; idPrefix: string }) {
  const field = (key: keyof Draft, label: string, type = 'text') => (
    <Input
      id={`${idPrefix}-${key}`}
      label={label}
      type={type}
      value={draft[key]}
      required={key === 'name'}
      onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
      data-testid={`${idPrefix}-${key}`}
    />
  );
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {field('name', labels.name)}
      {field('position', labels.position)}
      {field('email', labels.email, 'email')}
      {field('phone', labels.phone, 'tel')}
    </div>
  );
}

export function CompanyContactsEditor({
  companyId,
  contacts,
  labels,
}: {
  companyId: string;
  contacts: EditableContact[];
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EditableContact | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [companies, setCompanies] = useState<{ id: string; name: string }[] | null>(null);

  const base = `/api/companies/${companyId}/contacts`;

  const send = async (url: string, method: string, body?: unknown): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        router.refresh();
        return true;
      }
      const data = await res.json().catch(() => ({}));
      setError(data?.code === 'duplicate_email' ? labels.duplicate : labels.failed);
      return false;
    } catch {
      setError(labels.failed);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openMove = async (id: string) => {
    setMoving(id);
    setMoveTarget('');
    if (companies) return;
    const res = await fetch('/api/companies?all=1').catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    setCompanies(((data?.companies ?? []) as { id: string; name: string }[]).filter((c) => c.id !== companyId));
  };

  return (
    <div className="space-y-3" data-testid="company-contacts-editor">
      <p className="text-xs text-gray-500">{labels.primaryHint}</p>
      {contacts.length === 0 && <p className="text-sm text-gray-500">{labels.none}</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {contacts.map((c) => (
          <li key={c.id} className="py-3" data-testid={`company-contact-${c.id}`}>
            {editing === c.id ? (
              <form
                className="space-y-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await send(`${base}/${c.id}`, 'PATCH', draft)) setEditing(null);
                }}
              >
                <ContactFields draft={draft} onChange={setDraft} labels={labels} idPrefix={`contact-edit-${c.id}`} />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={busy} data-testid="contact-edit-save">
                    {labels.save}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    {labels.cancel}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{c.name || c.email}</span>
                  {c.isPrimary && (
                    <Badge variant="info" className="ml-2" data-testid="company-contact-primary-badge">
                      {labels.primary}
                    </Badge>
                  )}
                  {c.position && <span className="ml-2 text-gray-500">{c.position}</span>}
                  <div className="break-words text-gray-600 dark:text-gray-400">
                    {[c.email, c.phone].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {!c.isPrimary && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => send(`${base}/${c.id}/primary`, 'POST')}
                      data-testid={`contact-make-primary-${c.id}`}
                    >
                      {labels.makePrimary}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(c.id);
                      setDraft(draftOf(c));
                    }}
                    data-testid={`contact-edit-${c.id}`}
                  >
                    {labels.edit}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => openMove(c.id)} data-testid={`contact-move-${c.id}`}>
                    {labels.move}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(c)} data-testid={`contact-remove-${c.id}`}>
                    {labels.remove}
                  </Button>
                </div>
              </div>
            )}
            {moving === c.id && (
              <form
                className="mt-2 flex flex-wrap items-end gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (moveTarget && (await send(`${base}/${c.id}/move`, 'POST', { companyId: moveTarget }))) setMoving(null);
                }}
              >
                <div className="min-w-[14rem] flex-1">
                  <Select
                    id={`contact-move-target-${c.id}`}
                    label={labels.moveTo}
                    value={moveTarget}
                    placeholder={labels.chooseCompany}
                    options={(companies ?? []).map((co) => ({ value: co.id, label: co.name }))}
                    onChange={(e) => setMoveTarget(e.target.value)}
                    data-testid="contact-move-target"
                  />
                </div>
                <Button type="submit" size="sm" disabled={busy || !moveTarget} data-testid="contact-move-confirm">
                  {labels.move}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setMoving(null)}>
                  {labels.cancel}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>

      {adding ? (
        <form
          className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await send(base, 'POST', draft)) {
              setAdding(false);
              setDraft(EMPTY);
            }
          }}
          data-testid="contact-add-form"
        >
          <ContactFields draft={draft} onChange={setDraft} labels={labels} idPrefix="contact-add" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy} data-testid="contact-add-save">
              {labels.save}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {labels.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAdding(true);
            setEditing(null);
            setDraft(EMPTY);
          }}
          data-testid="contact-add"
        >
          {labels.add}
        </Button>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600" data-testid="company-contacts-error">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={labels.remove}
        message={labels.removeConfirm.replace('{name}', removing?.name || removing?.email || '')}
        confirmLabel={labels.remove}
        cancelLabel={labels.cancel}
        variant="danger"
        loading={busy}
        onConfirm={async () => {
          if (removing && (await send(`${base}/${removing.id}`, 'DELETE'))) setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
