'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';

// "My feedback" (#3877, src/lib/myFeedbackReports.ts): the reports this person
// sent with the feedback button — what they wrote, the page, the status and the
// team's note to them. Read from GET /api/support/reports, which answers with
// the caller's own reports only. A report opened from a notification is
// scrolled to by its anchor (`#report-<id>`).

interface Report {
  id: string;
  type: 'BUG' | 'FEEDBACK';
  status: 'NEW' | 'TRIAGED' | 'IN_PROGRESS' | 'RESOLVED' | 'WONT_FIX';
  description: string;
  path: string;
  createdAt: string;
  reporterNote: string | null;
  reporterNoteAt: string | null;
}

const STATUS_VARIANT: Record<Report['status'], 'default' | 'info' | 'warning' | 'success'> = {
  NEW: 'default',
  TRIAGED: 'info',
  IN_PROGRESS: 'warning',
  RESOLVED: 'success',
  WONT_FIX: 'default',
};

export default function MyFeedbackPage() {
  const t = useT();
  const m = t.myFeedback;
  const [reports, setReports] = useState<Report[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/support/reports')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setReports(d.reports ?? []))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!reports || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [reports]);

  return (
    <div className="space-y-4" data-testid="my-feedback">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{m.title}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{m.intro}</p>
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{m.failed}</p>
      ) : reports === null ? null : reports.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="my-feedback-empty">{m.empty}</p>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => (
            <li key={r.id} id={`report-${r.id}`} className="scroll-mt-4" data-testid={`my-feedback-${r.id}`}>
              <Card padding="sm">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={STATUS_VARIANT[r.status] ?? 'default'} data-testid="my-feedback-status">
                    {m.status[r.status] ?? r.status}
                  </Badge>
                  <span className="font-medium text-gray-800 dark:text-gray-100">{m.type[r.type]}</span>
                  <span className="text-gray-500 dark:text-gray-400">· {m.sentFrom.replace('{path}', () => r.path)}</span>
                  <RelativeTime date={r.createdAt} className="ml-auto text-xs text-gray-500 dark:text-gray-400" />
                </div>
                <p className="mt-2 whitespace-pre-line break-words text-sm text-gray-700 dark:text-gray-300">{r.description}</p>
                {r.reporterNote && (
                  <div className="mt-3 border-l-2 border-gray-300 pl-3 dark:border-gray-600" data-testid="my-feedback-reply">
                    <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      {m.reply}
                      {r.reporterNoteAt && (
                        <>
                          {' · '}
                          <RelativeTime date={r.reporterNoteAt} />
                        </>
                      )}
                    </p>
                    <p className="mt-1 whitespace-pre-line break-words text-sm text-gray-800 dark:text-gray-200">{r.reporterNote}</p>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
