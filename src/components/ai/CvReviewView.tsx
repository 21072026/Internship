'use client';

import { CheckCircle2, AlertCircle, CircleDashed } from 'lucide-react';
import { AiText } from '@/components/ai/AiText';
import { useLocale, useT } from '@/i18n/client';
import { scoreDelta, type CvReview } from '@/lib/cvReviewRules';

// The scored CV review (#2050), read-only — on the mentee's own card and, when
// they share it, on their mentor's view (SharedAiArtifacts). Every string the
// model wrote goes through AiText (#2026). The score is advice the mentee
// owns: this view is the only place it renders, never a company screen.

const BAND_CLASS: Record<CvReview['band'], string> = {
  ready: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  nearly: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  needs_work: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export function CvReviewView({ review, previousScore }: { review: CvReview; previousScore?: number | null }) {
  const t = useT();
  const c = t.cvFeedback;
  const locale = useLocale();
  const delta = scoreDelta(review.score, previousScore);
  return (
    <div className="space-y-3" data-testid="cv-review">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-3xl font-bold tabular-nums text-gray-900 dark:text-gray-100" data-testid="cv-review-score" aria-label={c.scoreLabel}>
          {review.score.toLocaleString(locale)}<span className="text-base font-normal text-gray-500">/100</span>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${BAND_CLASS[review.band]}`} data-testid="cv-review-band">{c.bands[review.band]}</span>
        {delta !== null && (
          <span className={`text-xs font-medium ${delta > 0 ? 'text-green-700 dark:text-green-400' : delta < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500'}`} data-testid="cv-review-delta">
            {delta === 0 ? c.deltaSame : c.delta.replace('{d}', `${delta > 0 ? '+' : ''}${delta.toLocaleString(locale)}`)}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{c.adviceNote}</p>
      {review.summary && <AiText text={review.summary} className="text-sm" />}

      {review.tailoring && (
        <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-900/10" data-testid="cv-review-tailoring">
          <p className="font-medium text-indigo-900 dark:text-indigo-200">{c.tailoredFor.replace('{title}', review.tailoring.title)}</p>
          {review.tailoring.missingSkills.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{c.missingSkills}</p>
              <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="cv-review-missing-skills">
                {review.tailoring.missingSkills.map((s) => (
                  <li key={s} className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-800 ring-1 ring-indigo-200 dark:bg-gray-900 dark:text-gray-200 dark:ring-indigo-800">{s}</li>
                ))}
              </ul>
            </div>
          )}
          {review.tailoring.wordingGaps.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{c.wordingGaps}</p>
              <ul className="mt-1 list-disc pl-5 text-xs">{review.tailoring.wordingGaps.map((w, i) => <li key={i}><AiText as="p" text={w} /></li>)}</ul>
            </div>
          )}
          {review.tailoring.emphasis && (
            <div className="mt-2">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{c.emphasis}</p>
              <AiText text={review.tailoring.emphasis} className="text-xs" />
            </div>
          )}
        </div>
      )}

      {review.checklist.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{c.checklistTitle}</p>
          <ul className="mt-1 space-y-1.5" data-testid="cv-review-checklist">
            {review.checklist.map((item, i) => {
              const Icon = item.status === 'ok' ? CheckCircle2 : item.status === 'missing' ? AlertCircle : CircleDashed;
              const tone = item.status === 'ok' ? 'text-green-600' : item.status === 'missing' ? 'text-red-600' : 'text-amber-600';
              return (
                <li key={i} className="flex gap-2 text-sm" data-testid={`cv-review-check-${item.status}`}>
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden />
                  <div>
                    <span className="sr-only">{c.status[item.status]}: </span>
                    <AiText as="p" text={item.item} className="font-medium" />
                    {item.status !== 'ok' && item.howToFix && <AiText as="p" text={item.howToFix} className="text-xs text-gray-600 dark:text-gray-400" />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{c.sectionsTitle}</p>
        <ol className="mt-1 space-y-1.5" data-testid="cv-review-sections">
          {review.sections.map((s, i) => (
            <li key={s.key} data-testid={`cv-review-section-${s.key}`}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>{i + 1}. {c.sections[s.key]}</span>
                <span className="tabular-nums text-gray-600 dark:text-gray-400">{s.score.toLocaleString(locale)}</span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div className="h-full bg-blue-500" style={{ width: `${s.score}%` }} />
              </div>
              {s.findings.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-gray-600 dark:text-gray-400">{s.findings.map((f, j) => <li key={j}><AiText as="p" text={f} /></li>)}</ul>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
