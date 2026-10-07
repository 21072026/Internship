'use client';

import { AiText } from '@/components/ai/AiText';
import { useT } from '@/i18n/client';
import { RUBRIC, type PracticeReport } from '@/lib/practiceInterviewRules';

// The practice-interview after-action report (#2051), read-only — on the
// mentee's card and, only when they share it, on their mentor's view. Every
// string the model wrote goes through AiText (#2026).
export function PracticeReportView({ report }: { report: PracticeReport }) {
  const p = useT().practiceInterview;
  return (
    <div className="space-y-3 text-sm" data-testid="practice-report">
      <p className="text-xs text-gray-500 dark:text-gray-400">{p.reportFor.replace('{role}', report.role)}</p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="practice-report-ratings">
        {RUBRIC.map((k) => (
          <li key={k} className="rounded-lg border border-gray-100 p-2 dark:border-gray-800" data-testid={`practice-rating-${k}`}>
            <p className="text-xs text-gray-500 dark:text-gray-400">{p.rubric[k]}</p>
            <p className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">{report.ratings[k]}<span className="text-xs font-normal text-gray-500">/5</span></p>
          </li>
        ))}
      </ul>
      {report.summary && <AiText text={report.summary} />}
      {report.wentWell.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{p.wentWell}</p>
          <ul className="mt-1 list-disc pl-5">{report.wentWell.map((w, i) => <li key={i}><AiText as="p" text={w} /></li>)}</ul>
        </div>
      )}
      {report.workOn.length > 0 && (
        <div data-testid="practice-report-work-on">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{p.workOn}</p>
          <ol className="mt-1 list-decimal pl-5">{report.workOn.map((w, i) => <li key={i}><AiText as="p" text={w} /></li>)}</ol>
        </div>
      )}
      {report.rewrite && (
        <div className="rounded-lg bg-green-50 p-3 dark:bg-green-900/10">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{p.rewrite}</p>
          <AiText as="p" text={report.rewrite.question} className="mt-1 text-xs text-gray-600 dark:text-gray-400" />
          <AiText text={report.rewrite.answer} className="mt-1" />
        </div>
      )}
    </div>
  );
}
