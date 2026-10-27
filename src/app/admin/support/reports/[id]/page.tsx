'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Bug, FileText, MessageSquareText, Star } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ImageLightbox, useImageLightbox } from '@/components/ui/ImageLightbox';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { SupportTabs } from '@/components/SupportTabs';
import { ReplayPlayer } from '@/components/ReplayPlayer';
import { SupportReportGithubCard } from '@/components/SupportReportGithubCard';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import type { FeedbackContext } from '@/lib/feedbackContext';
import {
  SUPPORT_REPORT_STATUSES,
  SUPPORT_REPORT_STATUS_VARIANT,
  type SupportReportStatusKey,
} from '@/lib/supportReportStatus';

interface ReportFile { id: string; kind: 'SCREENSHOT' | 'ATTACHMENT' | 'REPLAY'; filename: string; contentType: string; size: number }
interface Report {
  id: string;
  type: 'BUG' | 'FEEDBACK';
  status: SupportReportStatusKey;
  rating: number | null;
  description: string;
  url: string;
  appVersion: string;
  env: string;
  userAgent: string;
  viewport: string;
  context: FeedbackContext | null;
  contactAllowed: boolean;
  createdAt: string;
  user: { id: string; fullName: string; email: string; role: string };
  files: ReportFile[];
}

// One bug report (#3130): screenshot, description, environment, and the
// console / network context the browser recorded, plus the triage status.
export default function AdminSupportReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const a = t.adminReports;
  const [report, setReport] = useState<Report | null | 'missing'>(null);
  const [tab, setTab] = useState<'console' | 'network'>('console');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [draftStatus, setDraftStatus] = useState<SupportReportStatusKey | null>(null);
  const [notify, setNotify] = useState(false);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const lightbox = useImageLightbox();

  useEffect(() => {
    fetch(`/api/admin/support/reports/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setReport(d?.report ?? 'missing'))
      .catch(() => setReport('missing'));
  }, [id]);

  const saveStatus = async () => {
    if (!report || report === 'missing') return;
    const status = draftStatus ?? report.status;
    setSaving(true);
    setErr('');
    setNotice('');
    try {
      const res = await fetch(`/api/admin/support/reports/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, notifyReporter: notify && report.contactAllowed, note: notify ? note : undefined }),
      });
      if (!res.ok) throw new Error();
      const d = await res.json();
      setReport({ ...report, status });
      setDraftStatus(null);
      if (d.notified) setNotice(a.reporterNotified);
      setNotify(false);
      setNote('');
    } catch {
      setErr(t.common.error);
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <>
      <div className="mb-1 flex items-center gap-2">
        <Bug className="h-6 w-6 text-blue-600" aria-hidden="true" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
      </div>
      <p className="mb-6 text-gray-500">{a.subtitle}</p>
      <SupportTabs />
      <Link href="/admin/support/reports" className="mb-4 inline-flex items-center gap-1 text-sm text-blue-700 hover:underline dark:text-blue-400">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {a.back}
      </Link>
    </>
  );

  if (report === null) return <div>{header}<p className="py-10 text-center text-gray-400" data-testid="page-loading">{t.common.loading}</p></div>;
  if (report === 'missing') return <div>{header}<Card><p className="py-10 text-center text-gray-500">{t.common.error}</p></Card></div>;

  const fileUrl = (f: ReportFile) => `/api/admin/support/reports/${report.id}/files/${f.id}`;
  const screenshot = report.files.find((f) => f.kind === 'SCREENSHOT');
  const attachments = report.files.filter((f) => f.kind === 'ATTACHMENT');
  const replay = report.files.find((f) => f.kind === 'REPLAY');
  const images = [screenshot, ...attachments.filter((f) => f.contentType.startsWith('image/'))]
    .filter((f): f is ReportFile => !!f)
    .map((f) => ({ src: fileUrl(f), filename: f.filename }));
  const consoleErrors = report.context?.consoleErrors ?? [];
  const failedRequests = report.context?.failedRequests ?? [];

  const meta: [string, React.ReactNode][] = [
    [a.reporter, <span key="reporter"><PersonHoverCard personId={report.user.id} name={report.user.fullName} role={report.user.role} /> <span className="text-gray-500">{report.user.email}</span></span>],
    [a.page, <span key="page" className="break-all font-mono text-xs">{report.url || '—'}</span>],
    [a.version, report.appVersion],
    [a.environment, report.env],
    [a.browser, <span key="browser" className="break-all text-xs">{report.userAgent || '—'}</span>],
    [a.viewport, report.viewport || '—'],
    [a.rating, report.rating ? <span key="rating" className="inline-flex items-center gap-0.5"><Star className="h-4 w-4 fill-current text-amber-600" aria-hidden="true" />{report.rating}/5</span> : '—'],
    [a.contact, report.contactAllowed ? a.yes : a.no],
  ];

  return (
    <div data-testid="report-detail">
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {report.type === 'BUG' ? <Bug className="h-5 w-5 text-red-600" aria-hidden="true" /> : <MessageSquareText className="h-5 w-5 text-blue-600" aria-hidden="true" />}
        <Badge variant={report.type === 'BUG' ? 'danger' : 'info'}>{a[`type${report.type}`]}</Badge>
        <Badge variant={SUPPORT_REPORT_STATUS_VARIANT[report.status]} data-testid="report-status-badge">{a[`status${report.status}`]}</Badge>
        <RelativeTime date={report.createdAt} className="text-sm text-gray-500" />
      </div>

      {/* Triage (#3130) and, when the reporter allowed it, telling them (#3132). */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-sm text-gray-700 dark:text-gray-300">
            {a.changeStatus}
            <select
              value={draftStatus ?? report.status}
              disabled={saving}
              onChange={(e) => setDraftStatus(e.target.value as SupportReportStatusKey)}
              data-testid="report-status-select"
              className="mt-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            >
              {SUPPORT_REPORT_STATUSES.map((s) => <option key={s} value={s}>{a[`status${s}`]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input type="checkbox" checked={notify} disabled={!report.contactAllowed || saving} onChange={(e) => setNotify(e.target.checked)} data-testid="report-notify-reporter" />
            {a.notifyReporter}
          </label>
          <Button type="button" size="sm" onClick={() => void saveStatus()} disabled={saving || (!draftStatus && !notify)} data-testid="report-status-save">
            {a.saveStatus}
          </Button>
        </div>
        {!report.contactAllowed && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{a.notifyReporterOff}</p>}
        {notify && (
          <label className="mt-3 block text-sm text-gray-800 dark:text-gray-200">
            {a.statusNoteLabel}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" data-testid="report-status-note" />
          </label>
        )}
        {notice && <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">{notice}</p>}
        {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{a.description}</h2>
          <p className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-200" data-testid="report-description">{report.description}</p>
          <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
            {meta.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-gray-500">{k}</dt>
                <dd className="min-w-0 text-gray-800 dark:text-gray-200">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{a.screenshot}</h2>
          {screenshot ? (
            <button type="button" onClick={() => lightbox.open(images, 0)} aria-label={t.imageViewer.view.replace('{name}', screenshot.filename)} className="block w-full overflow-hidden rounded-lg border border-gray-200 hover:ring-2 hover:ring-blue-400 dark:border-gray-700">
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route */}
              <img src={fileUrl(screenshot)} alt={a.screenshot} className="w-full object-contain" data-testid="report-screenshot" />
            </button>
          ) : (
            <p className="text-sm text-gray-500">{a.noScreenshot}</p>
          )}
          {attachments.length > 0 && (
            <>
              <h3 className="mb-1 mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100">{a.attachments}</h3>
              <ul className="space-y-1 text-sm">
                {attachments.map((f) => (
                  <li key={f.id}>
                    {f.contentType.startsWith('image/') ? (
                      <button type="button" className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-400" onClick={() => lightbox.open(images, images.findIndex((i) => i.src === fileUrl(f)))}>
                        <FileText className="h-4 w-4" aria-hidden="true" /> {f.filename}
                      </button>
                    ) : (
                      <a href={fileUrl(f)} className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-400">
                        <FileText className="h-4 w-4" aria-hidden="true" /> {f.filename}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      {replay && (
        <Card className="mt-4">
          <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{a.replay}</h2>
          <ReplayPlayer src={fileUrl(replay)} context={report.context} size={replay.size} filename={`replay-${report.id}.json.gz`} />
        </Card>
      )}

      <Card className="mt-4">
        <div role="tablist" className="mb-3 flex gap-2 border-b border-gray-200 dark:border-gray-800">
          {(['console', 'network'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              data-testid={`report-tab-${k}`}
              className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
            >
              {(k === 'console' ? a.tabConsole : a.tabNetwork).replace('{count}', String(k === 'console' ? consoleErrors.length : failedRequests.length))}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'console' ? (
            consoleErrors.length === 0 ? <p className="text-sm text-gray-500">{a.noConsole}</p> : (
              <ol className="space-y-2" data-testid="report-console">
                {consoleErrors.map((e, i) => (
                  <li key={i} className="rounded-lg bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
                    <p className="font-mono"><span className="mr-2 font-semibold uppercase">{e.kind}</span>{e.at && <time dateTime={e.at} className="mr-2 opacity-70">{e.at.slice(11, 19)}</time>}{e.message}</p>
                    {e.stack && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap opacity-80">{e.stack}</pre>}
                  </li>
                ))}
              </ol>
            )
          ) : failedRequests.length === 0 ? <p className="text-sm text-gray-500">{a.noNetwork}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="report-network">
                <thead className="text-gray-500">
                  <tr><th className="py-1 pr-3">{a.colMethod}</th><th className="py-1 pr-3">{a.colUrl}</th><th className="py-1 pr-3">{a.colStatus}</th><th className="py-1 pr-3">{a.colDuration}</th><th className="py-1">{a.colRequestId}</th></tr>
                </thead>
                <tbody className="font-mono text-gray-800 dark:text-gray-200">
                  {failedRequests.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="py-1 pr-3">{r.method}</td>
                      <td className="break-all py-1 pr-3">{r.url}</td>
                      <td className="py-1 pr-3">{r.status || a.networkError}</td>
                      <td className="py-1 pr-3">{a.durationValue.replace('{ms}', String(r.durationMs))}</td>
                      <td className="py-1">{r.requestId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
      <SupportReportGithubCard reportId={report.id} />
      <ImageLightbox {...lightbox.lightboxProps} />
    </div>
  );
}
