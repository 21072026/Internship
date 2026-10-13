'use client';

import { useState } from 'react';
import { Sparkles, Check, X } from 'lucide-react';
import { AiBadge } from '@/components/AiBadge';
import { AiText } from '@/components/ai/AiText';
import { useT } from '@/i18n/client';

// Paste-in enrichment (#2055, part 2): a person pastes text they have — never a
// URL, nothing is fetched or scraped — and gets PROPOSED field values, each
// accepted or rejected on its own. Accepting only fills the form field; the
// form's own Save is what stores anything.

export interface EnrichField {
  key: string;
  label: string;
}

type Proposal = Record<string, string | string[]>;

export function EnrichPanel({
  endpoint,
  fields,
  onAccept,
  testId,
}: {
  endpoint: string;
  fields: EnrichField[];
  onAccept: (key: string, value: string | string[]) => void;
  testId: string;
}) {
  const e = useT().enrich;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [decided, setDecided] = useState<Record<string, 'accepted' | 'rejected'>>({});

  const suggest = async () => {
    setBusy(true);
    setNotice('');
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.trim() }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(body.code === 'consent_required' ? e.consentRequired : e.unavailable);
        return;
      }
      setProposal(body.proposal ?? null);
      setDecided({});
    } catch {
      setNotice(e.unavailable);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-sm text-indigo-700 hover:underline dark:text-indigo-300" data-testid={`${testId}-open`}>
        <Sparkles className="h-4 w-4" aria-hidden /> {e.open}
      </button>
    );
  }

  const shown = (v: string | string[]) => (Array.isArray(v) ? v.join(', ') : v);
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3 dark:border-indigo-900 dark:bg-indigo-900/10" data-testid={testId}>
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{e.title}</p>
      <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{e.hint}</p>
      <textarea
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        rows={4}
        maxLength={12_000}
        placeholder={e.pastePlaceholder}
        className="mt-2 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-800"
        data-testid={`${testId}-text`}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void suggest()}
          disabled={busy || text.trim().length < 20}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          data-testid={`${testId}-suggest`}
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> {busy ? e.suggesting : e.suggest}
        </button>
        {notice && <span role="alert" className="text-xs text-amber-700 dark:text-amber-400" data-testid={`${testId}-notice`}>{notice}</span>}
      </div>
      {proposal && (
        <div className="mt-3 space-y-2">
          <AiBadge note />
          {fields.map((f) => {
            const v = proposal[f.key];
            if (v === undefined || (Array.isArray(v) ? v.length === 0 : !String(v).trim())) return null;
            const state = decided[f.key];
            return (
              <div key={f.key} className="rounded-md border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900" data-testid={`${testId}-field-${f.key}`}>
                <p className="text-xs font-medium text-gray-500">{f.label}</p>
                <AiText text={shown(v)} className="text-sm" />
                {state ? (
                  <p className="mt-1 text-xs text-gray-500" data-testid={`${testId}-field-${f.key}-${state}`}>{state === 'accepted' ? e.accepted : e.rejected}</p>
                ) : (
                  <div className="mt-1 flex gap-3">
                    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-green-700" onClick={() => { onAccept(f.key, v); setDecided((d) => ({ ...d, [f.key]: 'accepted' })); }} data-testid={`${testId}-field-${f.key}-accept`}>
                      <Check className="h-3.5 w-3.5" aria-hidden /> {e.accept}
                    </button>
                    <button type="button" className="inline-flex items-center gap-1 text-xs text-gray-600" onClick={() => setDecided((d) => ({ ...d, [f.key]: 'rejected' }))} data-testid={`${testId}-field-${f.key}-reject`}>
                      <X className="h-3.5 w-3.5" aria-hidden /> {e.reject}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
