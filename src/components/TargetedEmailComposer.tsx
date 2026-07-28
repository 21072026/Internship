'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

interface Relation {
  id: string;
  mentee: { fullName: string; email: string };
}

// Targeted email composer shared by the mentor (/mentor/email) and admin
// (/admin/email) screens — admin ⊇ mentor parity (#708). Fetches the caller's
// mentorship relations (admin gets all) and posts to /api/mentor/email, which
// already authorizes ADMIN and respects each recipient's email opt-out.
export function TargetedEmailComposer() {
  const t = useT();
  const [relations, setRelations] = useState<Relation[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chosen = relations.filter((r) => selected[r.id]).map((r) => r.id);
  const allChecked = relations.length > 0 && chosen.length === relations.length;

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/mentor/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationIds: chosen, subject, body }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(t.mentorEmail.sentCount.replace('{n}', String(data.sent)));
        setSubject('');
        setBody('');
        setSelected({});
      } else {
        setResult(data.error || 'Failed');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentorEmail.title}</h1>
        <p className="text-gray-500 mt-1">{t.mentorEmail.subtitle}</p>
      </div>

      {result && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{result}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t.mentorEmail.recipients} ({chosen.length})</CardTitle>
          </CardHeader>
          {relations.length === 0 ? (
            <p className="text-sm text-gray-400">{t.mentor.noMenteesAssigned}</p>
          ) : (
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm font-medium pb-2 border-b border-gray-100">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) =>
                    setSelected(e.target.checked ? Object.fromEntries(relations.map((r) => [r.id, true])) : {})
                  }
                />
                {t.mentorEmail.selectAll}
              </label>
              {relations.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm py-1">
                  <input
                    type="checkbox"
                    checked={!!selected[r.id]}
                    onChange={(e) => setSelected((p) => ({ ...p, [r.id]: e.target.checked }))}
                  />
                  <span className="truncate">{r.mentee.fullName}</span>
                </label>
              ))}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t.mentorEmail.compose}</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.mentorEmail.template}</label>
              <select
                id="email-template"
                defaultValue=""
                onChange={(e) => {
                  const tpl = (t.emailTemplates as Record<string, { subject: string; body: string }>)[e.target.value];
                  if (tpl) { setSubject(tpl.subject); setBody(tpl.body); }
                  e.target.value = '';
                }}
                className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100 focus:outline-none"
              >
                <option value="">{t.mentorEmail.templatePlaceholder}</option>
                {['welcome', 'checkin', 'interview', 'followup'].map((k) => (
                  <option key={k} value={k}>{(t.emailTemplates as Record<string, { label: string }>)[k]?.label ?? k}</option>
                ))}
              </select>
            </div>
            <Input label={t.mentorEmail.subject} value={subject} onChange={(e) => setSubject(e.target.value)} />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.mentorEmail.message}</label>
              <Textarea
                rows={8}
                aria-label={t.mentorEmail.message}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={10000}
                showCounter
              />
            </div>
            <Button onClick={send} loading={sending} disabled={chosen.length === 0 || !subject || !body}>
              {t.mentorEmail.send}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
