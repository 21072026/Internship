'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { MapPin } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { skillsOf, type PortalJob } from '@/lib/portalJobView';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SCREENING_LIMITS, type ScreeningQuestion } from '@/lib/screeningQuestions';
import type { Locale } from '@/i18n/config';

// One open role on the mentee's job board (#1830). Anything not visible — a
// draft, a full role, another org's — reads as "not open any more" (the API
// answers 404). The apply form (#1832) asks the role's screening questions; the
// server checks the answers again and refuses a second application.
export default function PortalJobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT();
  const J = t.portalJobs;
  const locale = useLocale();
  const [job, setJob] = useState<(PortalJob & { screeningQuestions: ScreeningQuestion[] }) | null | undefined>(undefined);
  const [mine, setMine] = useState<{ id: string; stage: string } | null>(null);

  const load = useCallback(() => {
    fetch(`/api/portal/requisitions/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { setJob(body?.job ?? null); setMine(body?.myApplication ?? null); })
      .catch(() => setJob(null));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  return (
    <div data-testid="portal-job-detail">
      <Link href="/portal/jobs" className="text-sm text-blue-700 dark:text-blue-300">← {J.back}</Link>
      {job === undefined ? (
        <p className="py-10 text-center text-gray-600 dark:text-gray-400" data-testid="page-loading">{t.common.loading}</p>
      ) : job === null ? (
        <p className="py-10 text-center text-gray-700 dark:text-gray-300" data-testid="portal-job-not-found">{J.notFound}</p>
      ) : (
        <div className="mt-4 space-y-5">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{job.title}</h1>
            <p className="mt-1 text-gray-700 dark:text-gray-300">{job.company.name}</p>
            <p className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
              {job.city && <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" aria-hidden="true" />{job.city}</span>}
              {job.workMode && <span>{job.workMode}</span>}
              {job.startDate && <span>{J.starts.replace('{date}', formatDate(job.startDate, locale))}</span>}
            </p>
          </div>
          {job.description && <Card><p className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-200">{job.description}</p></Card>}
          {skillsOf(job.requiredSkills).length > 0 && (
            <Card>
              <CardHeader><CardTitle>{J.skills}</CardTitle></CardHeader>
              <div className="flex flex-wrap gap-1">{skillsOf(job.requiredSkills).map((s) => <Badge key={s}>{s}</Badge>)}</div>
            </Card>
          )}
          {mine ? (
            <Card data-testid="portal-job-applied">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">{J.applied}</p>
              <Link href="/portal/applications" className="mt-2 inline-block text-sm text-blue-700 hover:underline dark:text-blue-300">{J.viewApplications}</Link>
            </Card>
          ) : (
            <ApplyForm jobId={job.id} questions={job.screeningQuestions} locale={locale} onApplied={load} />
          )}
          {job.company.description && (
            <Card>
              <CardHeader><CardTitle>{J.about}</CardTitle></CardHeader>
              <p className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-200">{job.company.description}</p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ApplyForm({ jobId, questions, locale, onApplied }: { jobId: string; questions: ScreeningQuestion[]; locale: Locale; onApplied: () => void }) {
  const t = useT();
  const J = t.portalJobs;
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (id: string, value: string | boolean) => setAnswers((a) => ({ ...a, [id]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const screeningAnswers = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== ''));
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requisitionId: jobId, ...(note.trim() ? { coverNote: note.trim() } : {}), screeningAnswers }),
      });
      if (res.ok || res.status === 409) { onApplied(); return; }
      const body = await res.json().catch(() => ({}));
      setError(body.code === 'required_missing' ? J.requiredMissing : J.applyFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="portal-job-apply">
      <CardHeader><CardTitle>{J.applyTitle}</CardTitle></CardHeader>
      <form onSubmit={submit} className="space-y-4">
        {questions.map((q) => {
          const label = `${q.label[locale] ?? q.label.en}${q.required ? ` (${J.required})` : ''}`;
          const testId = `screening-${q.id}`;
          if (q.type === 'BOOLEAN') {
            return (
              <fieldset key={q.id} data-testid={testId}>
                <legend className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">{label}</legend>
                <div className="flex gap-4 text-sm">
                  {([true, false] as const).map((v) => (
                    <label key={String(v)} className="flex items-center gap-2">
                      <input type="radio" name={q.id} checked={answers[q.id] === v} onChange={() => set(q.id, v)} />{v ? J.yes : J.no}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }
          if (q.type === 'SELECT') {
            return <Select key={q.id} label={label} id={testId} value={String(answers[q.id] ?? '')} onChange={(e) => set(q.id, e.target.value)} placeholder={J.choose} options={(q.options ?? []).map((o) => ({ value: o, label: o }))} data-testid={testId} />;
          }
          return <Input key={q.id} label={label} id={testId} value={String(answers[q.id] ?? '')} maxLength={SCREENING_LIMITS.textAnswer} onChange={(e) => set(q.id, e.target.value)} data-testid={testId} />;
        })}
        <div>
          <label htmlFor="cover-note" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{J.coverNote}</label>
          <Textarea id="cover-note" value={note} maxLength={SCREENING_LIMITS.coverNote} onChange={(e) => setNote(e.target.value)} data-testid="portal-job-cover-note" />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        <Button type="submit" disabled={busy} data-testid="portal-job-apply-submit">{J.applyCta}</Button>
      </form>
    </Card>
  );
}
