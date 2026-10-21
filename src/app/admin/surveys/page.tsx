'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Smile, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useLocale, useT } from '@/i18n/client';
import { pickLocalized } from '@/lib/surveySchema';
import { SurveyFromInstrument, type Instrument } from '@/components/admin/SurveyFromInstrument';

// The programme's surveys (#1910): how many have answered each one, and the
// way into its completion console (#1889) and its results. A survey is created
// here from a built-in instrument (#1877); a free-form question builder is not
// part of this screen.

interface SurveyRow {
  id: string;
  title: unknown;
  status: 'DRAFT' | 'OPEN' | 'CLOSED';
  anonymity: 'IDENTIFIED' | 'CONFIDENTIAL' | 'ANONYMOUS';
  _count: { invitations: number; responses: number };
}

const STATUS_VARIANT = { DRAFT: 'default', OPEN: 'success', CLOSED: 'info' } as const;

export default function AdminSurveysPage() {
  const t = useT();
  const s = t.surveyResults;
  const locale = useLocale();
  const [rows, setRows] = useState<SurveyRow[] | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    fetch('/api/admin/surveys')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        setRows(body.surveys);
        setInstruments(body.instruments ?? []);
      })
      .catch(() => setError(t.common.error));
  }, [t.common.error, reload]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
          <Smile className="h-6 w-6 text-blue-500" /> {s.listTitle}
        </h1>
        <p className="text-gray-500 mt-1 max-w-3xl">{s.listSubtitle}</p>
      </div>
      {instruments.length > 0 && <SurveyFromInstrument instruments={instruments} onCreated={() => setReload((n) => n + 1)} />}
      {error && <p className="text-red-600" role="alert">{error}</p>}
      {!rows && !error && <p className="text-gray-500">{t.common.loading}</p>}
      {rows && rows.length === 0 && <Card><p className="text-gray-500">{s.empty}</p></Card>}
      {rows && rows.length > 0 && (
        <ul className="space-y-3" data-testid="survey-list">
          {rows.map((row) => (
            <li key={row.id}>
              <Card padding="sm" className="flex flex-wrap items-center gap-3" data-testid={`survey-row-${row.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900 dark:text-gray-100 break-words">{pickLocalized(row.title, locale)}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
                    <Badge variant={STATUS_VARIANT[row.status]}>{s[`status_${row.status}`]}</Badge>
                    <Badge variant="purple">{s[`anonymity_${row.anonymity}`]}</Badge>
                    <span>{s.responses.replace('{n}', String(row._count.responses))}</span>
                  </div>
                </div>
                <Link
                  href={`/admin/surveys/${row.id}`}
                  className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-3 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400"
                  data-testid={`survey-completion-link-${row.id}`}
                >
                  {t.surveyCompletion.completionLink}
                </Link>
                <Link
                  href={`/admin/surveys/${row.id}/results`}
                  className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-3 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400"
                  data-testid={`survey-results-link-${row.id}`}
                >
                  {s.viewResults} <ArrowRight className="h-4 w-4" />
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
