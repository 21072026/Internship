'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Printer } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { useLocale, useT } from '@/i18n/client';

type ReportStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'CHANGES_REQUESTED';
interface Report { id: string; weekStart: string; summary: string; hoursSpent: number | null; blockers: string | null; status: ReportStatus; mentorComment: string | null }

const badgeVariant: Record<ReportStatus, 'info' | 'success' | 'warning' | 'purple'> = {
  DRAFT: 'info', SUBMITTED: 'purple', APPROVED: 'success', CHANGES_REQUESTED: 'warning',
};

// `readOnly` is not cosmetic here: POST /api/weekly-reports already answers 409
// `inactive_relation` for a mentorship that is not ACTIVE, so on an archive
// (#1408) an open compose form could only ever produce an error. The diary
// itself stays readable.
export function WeeklyReportsPanel({
  relationId,
  mode,
  readOnly = false,
}: {
  relationId: string;
  mode: 'mentee' | 'mentor';
  readOnly?: boolean;
}) {
  const t = useT().weeklyReports;
  const locale = useLocale();
  const [reports, setReports] = useState<Report[]>([]);
  const [currentWeekStart, setCurrentWeekStart] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ summary: '', hoursSpent: '', blockers: '' });
  const [comments, setComments] = useState<Record<string, string>>({});

  const load = useCallback(async (pageToLoad = 1, append = false) => {
    if (append) setLoadingMore(true);
    const response = await fetch(`/api/weekly-reports?relationId=${encodeURIComponent(relationId)}&page=${pageToLoad}&pageSize=20`);
    if (!response.ok) { setLoading(false); setLoadingMore(false); return; }
    const data = await response.json();
    setReports((previous) => append
      ? [...previous, ...data.reports.filter((report: Report) => !previous.some((item) => item.id === report.id))]
      : data.reports);
    setPage(data.page);
    setHasMore(data.hasMore);
    setCurrentWeekStart(data.currentWeekStart.slice(0, 10));
    const current = data.reports.find((report: Report) => report.weekStart.slice(0, 10) === data.currentWeekStart.slice(0, 10));
    if (current) setForm({ summary: current.summary, hoursSpent: current.hoursSpent?.toString() ?? '', blockers: current.blockers ?? '' });
    setLoading(false);
    setLoadingMore(false);
  }, [relationId]);

  useEffect(() => { void load(); }, [load]);
  const current = reports.find((report) => report.weekStart.slice(0, 10) === currentWeekStart);
  const editable = !readOnly && (!current || current.status === 'DRAFT' || current.status === 'CHANGES_REQUESTED');
  // The mentee view lifts the current week out of the history into the compose
  // section — but on an archive there is no compose section, so a report filed
  // in the week the mentorship ended would otherwise be invisible.
  const historyReports = mode === 'mentee' && !readOnly ? reports.filter((report) => report.id !== current?.id) : reports;

  async function save(status: 'DRAFT' | 'SUBMITTED') {
    setSaving(true); setMessage('');
    const payload = { summary: form.summary, hoursSpent: form.hoursSpent === '' ? null : Number(form.hoursSpent), blockers: form.blockers || null, ...(status === 'SUBMITTED' ? { status } : {}) };
    const response = await fetch(current ? `/api/weekly-reports/${current.id}` : '/api/weekly-reports', {
      method: current ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current ? payload : { relationId, status, ...payload }),
    });
    setMessage(response.ok ? t.saved : t.error); setSaving(false);
    if (response.ok) await load(1, false);
  }

  async function review(report: Report, status: 'APPROVED' | 'CHANGES_REQUESTED') {
    setSaving(true); setMessage('');
    const response = await fetch(`/api/weekly-reports/${report.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, mentorComment: comments[report.id] || null }) });
    setMessage(response.ok ? t.reviewed : t.error); setSaving(false);
    if (response.ok) await load(1, false);
  }

  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
  if (loading) return <Card data-testid="weekly-reports-panel"><p className="text-sm text-gray-500 dark:text-gray-400">{t.loading}</p></Card>;

  return (
    <Card data-testid="weekly-reports-panel">
      <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>{t.title}</CardTitle><Link href={`/weekly-reports/print?relationId=${encodeURIComponent(relationId)}`} className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"><Printer className="h-4 w-4" />{t.printDiary}</Link></div></CardHeader>
      {mode === 'mentee' && !readOnly && (
        <section className="mb-6 space-y-3" data-testid="current-weekly-report">
          <h3 className="font-medium text-gray-900 dark:text-gray-100">{t.current}</h3>
          {current?.mentorComment && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"><strong>{t.mentorComment}:</strong> {current.mentorComment}</p>}
          <div><label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{t.summary}</label><Textarea data-testid="weekly-report-summary" value={form.summary} disabled={!editable} onChange={(e) => setForm((p) => ({ ...p, summary: e.target.value }))} placeholder={t.summaryPlaceholder} maxLength={TEXT_LIMITS.weeklyReportSummary} showCounter rows={5} /></div>
          <Input data-testid="weekly-report-hours" label={t.hours} type="number" min="0" max="168" value={form.hoursSpent} disabled={!editable} onChange={(e) => setForm((p) => ({ ...p, hoursSpent: e.target.value }))} />
          <div><label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{t.blockers}</label><Textarea data-testid="weekly-report-blockers" value={form.blockers} disabled={!editable} onChange={(e) => setForm((p) => ({ ...p, blockers: e.target.value }))} placeholder={t.blockersPlaceholder} maxLength={TEXT_LIMITS.weeklyReportBlockers} showCounter rows={3} /></div>
          {editable && <div className="flex flex-wrap gap-2"><Button data-testid="weekly-report-save-draft" variant="outline" loading={saving} onClick={() => void save('DRAFT')}>{t.saveDraft}</Button><Button data-testid="weekly-report-submit" loading={saving} onClick={() => void save('SUBMITTED')}>{t.submit}</Button></div>}
          {current && <Badge variant={badgeVariant[current.status]}>{t.status[current.status]}</Badge>}
        </section>
      )}
      {message && <p role="status" className="mb-4 text-sm text-gray-600 dark:text-gray-300">{message}</p>}
      <section className="space-y-3">
        <h3 className="font-medium text-gray-900 dark:text-gray-100">{t.history}</h3>
        {historyReports.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">{t.noReports}</p>}
        {historyReports.map((report) => (
          <article key={report.id} className="rounded-xl border border-gray-200 p-4 dark:border-gray-700" data-testid="weekly-report-row">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium text-gray-900 dark:text-gray-100">{t.weekOf.replace('{date}', date(report.weekStart))}</h4><Badge variant={badgeVariant[report.status]}>{t.status[report.status]}</Badge></div>
            <p className="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{report.summary}</p>
            {report.hoursSpent !== null && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t.hours}: {report.hoursSpent}</p>}
            {report.blockers && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-500 dark:text-gray-400"><strong>{t.blockers}:</strong> {report.blockers}</p>}
            {report.mentorComment && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-500 dark:text-gray-400"><strong>{t.mentorComment}:</strong> {report.mentorComment}</p>}
            {mode === 'mentor' && !readOnly && report.status === 'SUBMITTED' && <div className="mt-4 space-y-2"><Textarea aria-label={t.mentorComment} value={comments[report.id] || ''} onChange={(e) => setComments((p) => ({ ...p, [report.id]: e.target.value }))} placeholder={t.commentPlaceholder} maxLength={TEXT_LIMITS.weeklyReportMentorComment} showCounter rows={3} /><div className="flex flex-wrap gap-2"><Button size="sm" loading={saving} onClick={() => void review(report, 'APPROVED')}>{t.approve}</Button><Button size="sm" variant="outline" loading={saving} onClick={() => void review(report, 'CHANGES_REQUESTED')}>{t.requestChanges}</Button></div></div>}
          </article>
        ))}
        {hasMore && <Button data-testid="weekly-reports-load-more" variant="outline" loading={loadingMore} onClick={() => void load(page + 1, true)}>{t.loadMore}</Button>}
      </section>
    </Card>
  );
}
