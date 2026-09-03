import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { Card } from '@/components/ui/Card';
import { formatDuration, getOwnMenteeActivity } from '@/lib/activityReport';
import { hasConsent } from '@/lib/consent';

const ALLOWED_DAYS = [1, 7, 30];

// The mentee's own view of the activity report that already exists about them
// (#1915). We collect this data with their consent and show it to their mentor
// and their admin; not showing it to them is a transparency gap before it is a
// product gap.
//
// Deliberately NOT `ActivityReportView`: that component ranks mentees most-
// active-first and flags the quiet ones "Inactive", which is exactly the
// judgement a self-view must not make. Nothing here compares the reader to
// anybody else — no score, no percentile, no streak — and nothing here is
// gated on a plan.
export default async function PortalInsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  const { t } = await getServerDictionary();
  const p = t.portalInsights;

  const sp = await searchParams;
  const days = ALLOWED_DAYS.includes(Number(sp.days)) ? Number(sp.days) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Same three calls the API route makes, server-side, so the first paint needs
  // no client fetch. The subject is the session's own id — the page, like the
  // route, takes no mentee id.
  const activity = await getOwnMenteeActivity(session.user.id, since);
  const trackingConsent = await hasConsent(session.user.id, 'ACTIVITY_TRACKING');

  return (
    <div data-testid="portal-insights">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{p.title}</h1>
          <p className="text-gray-500 mt-1">{p.subtitle}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 p-1 self-start">
          {ALLOWED_DAYS.map((d) => (
            <Link
              key={d}
              href={`/portal/insights?days=${d}`}
              className={`px-3 py-1.5 rounded-md text-sm ${
                days === d
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {(p.range as Record<string, string>)[`d${d}`]}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <h2 className="text-sm font-medium text-gray-500 mb-3">{p.mentorshipTitle}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Metric label={p.metrics.goalsDone} value={activity?.goalsCompleted ?? 0} />
          <Metric label={p.metrics.goalsOpen} value={activity?.goalsOpen ?? 0} />
          <Metric label={p.metrics.meetings} value={activity?.meetings ?? 0} />
          <Metric label={p.metrics.interactions} value={activity?.interactions ?? 0} />
          <Metric label={p.metrics.pipeline} value={activity?.pipelineChanges ?? 0} />
          <Metric
            label={p.metrics.messages}
            value={`${activity?.messagesSent ?? 0}/${activity?.messagesReceived ?? 0}`}
          />
        </div>
      </Card>

      {trackingConsent && activity ? (
        <Card className="mt-4" data-testid="portal-insights-tracking">
          <h2 className="text-sm font-medium text-gray-500 mb-3">{p.trackingTitle}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Metric label={p.metrics.timeOnSite} value={formatDuration(activity.timeOnSiteSec)} />
            <Metric label={p.metrics.pages} value={activity.pageViews} />
          </div>
          {activity.topPages.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
              <p className="text-xs font-medium text-gray-500 mb-1.5">{p.topPages}</p>
              <ul className="flex flex-wrap gap-2">
                {activity.topPages.map((page) => (
                  <li
                    key={page.path}
                    className="text-xs bg-gray-50 dark:bg-gray-800 rounded px-2 py-1 text-gray-600 dark:text-gray-300"
                  >
                    <span className="font-mono">{page.path}</span>
                    <span className="text-gray-400">
                      {' '}
                      · {page.views}× · {formatDuration(page.seconds)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ) : (
        // Consent off: say so. Zeros here would read as "you did nothing",
        // which is a lie about a person rather than an absence of data.
        <div
          data-testid="portal-insights-no-consent"
          className="mt-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3"
        >
          <p className="text-sm font-medium text-amber-900">{p.trackingOffTitle}</p>
          <p className="text-sm text-amber-800 mt-1">{p.trackingOffBody}</p>
          <Link href="/account" className="text-sm text-amber-900 underline mt-2 inline-block">
            {p.trackingOffCta}
          </Link>
        </div>
      )}

      <p className="text-xs text-gray-400 mt-4">{p.privacyNote}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2">
      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{value}</p>
      <p className="text-[11px] text-gray-500 leading-tight">{label}</p>
    </div>
  );
}
