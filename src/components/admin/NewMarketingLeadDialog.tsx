'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { onPathKeys, startStageKey } from '@/lib/pipeline';

// "New lead / account" for a MARKETING org (#2562). The dialog only collects
// the fields; everything that decides what they MEAN — the match key, the
// stand-in lead address, the one-active-owner rule — happens on the server, in
// the marketing import's own writer (POST /api/admin/marketing-accounts).

type Outcome =
  | { kind: 'created'; leadId: string | null }
  | { kind: 'exists'; companyId: string; leadId: string | null }
  | { kind: 'contact_in_funnel'; leadId: string | null }
  | { kind: 'message'; text: string };

const EMPTY = {
  name: '',
  country: '',
  vatId: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  source: '',
};

export function NewMarketingLeadDialog({
  onClose,
  onCreated,
  onOpenAccount,
}: {
  onClose: () => void;
  /** Refresh the account list behind the dialog. */
  onCreated: () => void | Promise<void>;
  /** Open an existing account's edit dialog on the page. */
  onOpenAccount: (companyId: string) => void;
}) {
  const t = useT();
  const nl = t.companiesPage.newLead;
  const stages = useResolvedStages();
  const onPath = useMemo(() => {
    const keys = new Set(onPathKeys(stages));
    return [...stages].filter((s) => keys.has(s.key)).sort((a, b) => a.order - b.order);
  }, [stages]);
  const [fields, setFields] = useState(EMPTY);
  const [stage, setStage] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(true, onClose);

  const chosenStage = stage || startStageKey(stages);
  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setOutcome(null);
    try {
      // Blank optional fields are left out, so the import reads them as
      // "the form said nothing" rather than as an empty value.
      const body: Record<string, string> = { stage: chosenStage };
      for (const [key, value] of Object.entries(fields)) {
        if (value.trim()) body[key] = value.trim();
      }
      const res = await fetch('/api/admin/marketing-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 201) {
        setOutcome({ kind: 'created', leadId: data.leadId ?? null });
        setFields(EMPTY);
        await onCreated();
      } else if (data.code === 'account_exists') {
        setOutcome({ kind: 'exists', companyId: data.companyId, leadId: data.leadId ?? null });
      } else if (data.code === 'contact_in_funnel') {
        setOutcome({ kind: 'contact_in_funnel', leadId: data.leadId ?? null });
      } else if (data.code === 'contact_is_user') {
        setOutcome({ kind: 'message', text: nl.contactIsUser });
      } else if (data.code === 'already_mentored') {
        setOutcome({ kind: 'message', text: nl.alreadyMentored });
      } else if (data.code === 'account_ambiguous') {
        setOutcome({ kind: 'message', text: nl.ambiguous });
      } else {
        setOutcome({ kind: 'message', text: data.error ? `${nl.failed} ${data.error}` : nl.failed });
      }
    } catch {
      setOutcome({ kind: 'message', text: nl.failed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-lead-title"
        tabIndex={-1}
        data-testid="new-lead-dialog"
        className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <h2 id="new-lead-title" className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          {nl.title}
        </h2>
        <p className="text-sm text-gray-500 mb-5">{nl.hint}</p>

        {outcome?.kind === 'created' && (
          <div
            data-testid="new-lead-created"
            className="mb-4 p-3 rounded-lg border border-green-200 bg-green-50 text-green-800 text-sm flex flex-wrap items-center gap-3"
          >
            <span>{nl.created}</span>
            {outcome.leadId && (
              <Link href={`/admin/candidates/${outcome.leadId}`} className="underline font-medium" data-testid="new-lead-open-lead">
                {nl.openLead}
              </Link>
            )}
            <Link href="/admin/board" className="underline font-medium">
              {nl.openBoard}
            </Link>
          </div>
        )}
        {outcome?.kind === 'exists' && (
          <div
            data-testid="new-lead-exists"
            className="mb-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm flex flex-wrap items-center gap-3"
          >
            <span>{nl.exists}</span>
            <button
              type="button"
              className="underline font-medium"
              data-testid="new-lead-open-account"
              onClick={() => onOpenAccount(outcome.companyId)}
            >
              {nl.openAccount}
            </button>
            {outcome.leadId && (
              <Link href={`/admin/candidates/${outcome.leadId}`} className="underline font-medium">
                {nl.openLead}
              </Link>
            )}
          </div>
        )}
        {outcome?.kind === 'contact_in_funnel' && (
          <div
            data-testid="new-lead-contact-in-funnel"
            className="mb-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm flex flex-wrap items-center gap-3"
          >
            <span>{nl.contactInFunnel}</span>
            {outcome.leadId && (
              <Link href={`/admin/candidates/${outcome.leadId}`} className="underline font-medium">
                {nl.openLead}
              </Link>
            )}
          </div>
        )}
        {outcome?.kind === 'message' && (
          <div
            data-testid="new-lead-error"
            role="alert"
            className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm"
          >
            {outcome.text}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4" data-testid="new-lead-form">
          <Input id="new-lead-name" label={nl.name} required value={fields.name} onChange={set('name')} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              id="new-lead-country"
              label={nl.country}
              maxLength={2}
              value={fields.country}
              onChange={set('country')}
            />
            <Input id="new-lead-vat" label={nl.vatId} value={fields.vatId} onChange={set('vatId')} />
            <Input id="new-lead-contact-name" label={nl.contactName} value={fields.contactName} onChange={set('contactName')} />
            <Input
              id="new-lead-contact-email"
              type="email"
              label={nl.contactEmail}
              hint={nl.contactEmailHint}
              required
              value={fields.contactEmail}
              onChange={set('contactEmail')}
            />
            <Input
              id="new-lead-contact-phone"
              type="tel"
              label={nl.contactPhone}
              value={fields.contactPhone}
              onChange={set('contactPhone')}
            />
            <Input
              id="new-lead-source"
              label={nl.source}
              placeholder={nl.sourcePlaceholder}
              value={fields.source}
              onChange={set('source')}
            />
          </div>
          <div>
            <label htmlFor="new-lead-stage" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              {nl.stage}
            </label>
            <select
              id="new-lead-stage"
              data-testid="new-lead-stage"
              value={chosenStage}
              onChange={(e) => setStage(e.target.value)}
              className="block min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {onPath.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={busy} data-testid="new-lead-submit">
              {nl.submit}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
