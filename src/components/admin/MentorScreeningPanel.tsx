'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useT, useLocale } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/lib/relativeTime';
import { SCREENING_ITEMS, parseChecklist, type ScreeningChecklist, type ScreeningItem } from '@/lib/mentorScreeningRule';

// The screening record on a mentor application (#1807): the checklist (each
// tick stamped by the server with who and when), the interview and the
// reference. Admin-only; the applicant never sees any of it. Which items gate
// approval is the org policy — shown here as a badge, enforced by the server.

export interface ScreeningFields {
  screeningChecklist: unknown;
  interviewAt: string | null;
  interviewNotes: string | null;
  referenceName: string | null;
  referenceContact: string | null;
  referenceOutcome: string | null;
}

const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function MentorScreeningPanel({ applicationId, initial, required }: { applicationId: string; initial: ScreeningFields; required: ScreeningItem[] }) {
  const t = useT();
  const locale = useLocale();
  const S = t.mentorApplicationsAdmin.screening;
  const toast = useToast();
  const [checklist, setChecklist] = useState<ScreeningChecklist>(parseChecklist(initial.screeningChecklist));
  const [interviewAt, setInterviewAt] = useState(toLocalInput(initial.interviewAt));
  const [interviewNotes, setInterviewNotes] = useState(initial.interviewNotes ?? '');
  const [referenceName, setReferenceName] = useState(initial.referenceName ?? '');
  const [referenceContact, setReferenceContact] = useState(initial.referenceContact ?? '');
  const [referenceOutcome, setReferenceOutcome] = useState(initial.referenceOutcome ?? '');
  const [busy, setBusy] = useState<string>('');

  const send = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const res = await fetch(`/api/mentor-applications/${applicationId}/screening`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const d = await res.json();
      setChecklist(parseChecklist(d.screening?.screeningChecklist));
      return true;
    } catch {
      toast(S.saveError, 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  const toggle = (item: ScreeningItem) => send({ item, done: checklist[item]?.done !== true }, item);

  const saveRecord = async () => {
    const ok = await send(
      {
        interviewAt: interviewAt ? new Date(interviewAt).toISOString() : null,
        interviewNotes,
        referenceName,
        referenceContact,
        referenceOutcome,
      },
      'record'
    );
    if (ok) toast(S.saved);
  };

  return (
    <Card data-testid="mentor-screening-panel">
      <CardHeader><CardTitle>{S.title}</CardTitle></CardHeader>
      <p className="text-xs text-gray-500 mb-3">{S.hint}</p>
      <ul className="space-y-2">
        {SCREENING_ITEMS.map((item) => {
          const entry = checklist[item];
          return (
            <li key={item} className="flex items-start gap-2">
              <input
                id={`screening-${item}`}
                type="checkbox"
                className="mt-0.5"
                checked={entry?.done === true}
                disabled={busy !== ''}
                onChange={() => toggle(item)}
                data-testid={`screening-item-${item}`}
              />
              <label htmlFor={`screening-${item}`} className="text-sm text-gray-800 dark:text-gray-200">
                {S.items[item]}
                {required.includes(item) && (
                  <span className="ml-1.5 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                    {S.requiredBadge}
                  </span>
                )}
                {entry && (
                  <span className="block text-[11px] text-gray-500">{S.stamped.replace('{date}', formatDate(entry.at, locale))}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 space-y-3 border-t border-gray-100 dark:border-gray-800 pt-3">
        <Input label={S.interviewAt} type="datetime-local" value={interviewAt} onChange={(e) => setInterviewAt(e.target.value)} />
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">{S.interviewNotes}</label>
          <Textarea rows={3} maxLength={4000} value={interviewNotes} onChange={(e) => setInterviewNotes(e.target.value)} />
        </div>
        <p className="text-[11px] text-gray-500">{S.referenceHint}</p>
        <Input label={S.referenceName} maxLength={191} value={referenceName} onChange={(e) => setReferenceName(e.target.value)} />
        <Input label={S.referenceContact} maxLength={191} value={referenceContact} onChange={(e) => setReferenceContact(e.target.value)} />
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">{S.referenceOutcome}</label>
          <Textarea rows={2} maxLength={2000} value={referenceOutcome} onChange={(e) => setReferenceOutcome(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" loading={busy === 'record'} onClick={saveRecord} data-testid="screening-save">
          {S.save}
        </Button>
      </div>
    </Card>
  );
}
