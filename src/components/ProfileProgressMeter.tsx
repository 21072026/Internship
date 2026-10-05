import Link from 'next/link';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { profileFieldAnchor, type ProfileCompleteness } from '@/lib/profileCompleteness';
import type { Dictionary } from '@/i18n/dictionaries';

type Labels = Dictionary['portal']['profileProgress'];

/**
 * The profile completeness meter (light gamification, /portal + /portal/profile).
 *
 * Presentational only and hook-free, so the server dashboard (server
 * dictionary) and the client ProfileForm (`useT()`) render the same markup.
 * The number comes from `profileCompleteness()` — never computed here.
 *
 *   variant="dashboard" — renders NOTHING at 100%: a finished profile needs no
 *                         card on the summary page. Links go to /portal/profile.
 *   variant="profile"   — at 100% collapses to one quiet line; links are
 *                         in-page anchors to the field itself.
 *
 * Deliberately quiet: no confetti, no points, no "you beat N% of users".
 */
export function ProfileProgressMeter({
  completeness,
  labels,
  variant,
}: {
  completeness: ProfileCompleteness;
  labels: Labels;
  variant: 'dashboard' | 'profile';
}) {
  const { percent, missing } = completeness;

  if (missing.length === 0) {
    if (variant === 'dashboard') return null;
    return (
      <p
        data-testid="profile-progress-complete"
        className="mb-6 flex max-w-2xl items-center gap-2 text-sm text-gray-600 dark:text-gray-300"
      >
        <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
        {labels.complete}
      </p>
    );
  }

  const hrefFor = (key: (typeof missing)[number]) =>
    variant === 'dashboard' ? `/portal/profile#${profileFieldAnchor(key)}` : `#${profileFieldAnchor(key)}`;
  const label = labels.percentLabel.replace('{p}', String(percent));

  return (
    <section
      data-testid="profile-progress"
      aria-labelledby={`profile-progress-title-${variant}`}
      className={`mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5 dark:border-gray-800 dark:bg-gray-900 ${variant === 'profile' ? 'max-w-2xl' : ''}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`profile-progress-title-${variant}`} className="font-semibold text-gray-900 dark:text-gray-100">
          {labels.title}
        </h2>
        <span data-testid="profile-progress-percent" className="text-sm font-medium tabular-nums text-gray-700 dark:text-gray-200">
          {label}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={labels.progressAria}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label}
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
      >
        <div className="h-full rounded-full bg-blue-600 dark:bg-blue-400" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{labels.hint}</p>
      <ul className="mt-2 flex flex-wrap gap-2" data-testid="profile-progress-missing">
        {missing.map((key) => (
          <li key={key}>
            <Link
              href={hrefFor(key)}
              data-testid={`profile-progress-item-${key}`}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-800 transition-colors hover:border-blue-400 hover:text-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:border-gray-700 dark:text-gray-100 dark:hover:border-blue-400 dark:hover:text-blue-200"
            >
              {labels.fields[key]}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      {variant === 'dashboard' && (
        <Link
          href="/portal/profile"
          className="mt-3 inline-block text-sm font-medium text-blue-700 hover:underline dark:!text-blue-300"
        >
          {labels.editCta}
        </Link>
      )}
    </section>
  );
}
