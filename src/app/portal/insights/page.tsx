import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { Card } from '@/components/ui/Card';
import { formatDuration, getOwnMenteeActivity } from '@/lib/activityReport';
import { hasConsent } from '@/lib/consent';
import { insightsWindowFrom } from '@/lib/portalInsightsQuery';
import { PORTAL_INSIGHTS_DAYS, ymd } from '@/lib/portalInsightsWindow';
import { PortalInsightsExport } from '@/components/PortalInsightsExport';

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
  searchParams: Promise<{ days?: string; from?: string; to?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  const { t } = await getServerDictionary();
  const p = t.portalInsights;

  // A preset (`?days=`) or a date range (`?from=&to=`, #1909) — the same parse
  // as the API route, so the export covers exactly the period on screen.
  const sp = await searchParams;
  const period = insightsWindowFrom({ get: (name) => sp[name as keyof typeof sp] ?? null });

  // Same three calls the API route makes, server-side, so the first paint needs
  // no client fetch. The subject is the session's own id — the page, like the
  // route, takes no mentee id.
  const activity = await getOwnMenteeActivity(session.user.id, period.from, period.to);
  const trackingConsent = await hasConsent(session.user.id, 'ACTIVITY_TRACKING');

  // The export is the numbers on this screen, nothing more: the tracking rows
  // only when tracking is on, the same as the cards below.
  const exportRows: (string | number)[][] = [
    [p.exportPeriod, `${ymd(period.from)} – ${ymd(period.to)}`],
    [p.metrics.goalsDone, activity?.goalsCompleted ?? 0],
    [p.metrics.goalsOpen, activity?.goalsOpen ?? 0],
    [p.metrics.meetings, activity?.meetings ?? 0],
    [p.metrics.interactions, activity?.interactions ?? 0],
    [p.metrics.pipeline, activity?.pipelineChanges ?? 0],
    [p.metrics.messages, `${activity?.messagesSent ?? 0}/${activity?.messagesReceived ?? 0}`],
    ...(trackingConsent && activity
      ? [
          [p.metrics.timeOnSite, formatDuration(activity.timeOnSiteSec)],
          [p.metrics.pages, activity.pageViews],
        ]
      : []),
  ];

  return (
    <div data-testid="portal-insights">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{p.title}</h1>
          <p className="text-gray-500 mt-1">{p.subtitle}</p>
        </div>
        <div className="flex flex-col gap-2 self-start sm:items-end no-print">
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 p-1 self-start sm:self-end">
          {PORTAL_INSIGHTS_DAYS.map((d) => (
            <Link
              key={d}
              href={`/portal/insights?days=${d}`}
              className={`px-3 py-1.5 rounded-md text-sm ${
                period.days === d
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {(p.range as Record<string, string>)[`d${d}`]}
            </Link>
          ))}
        </div>
        <form method="get" action="/portal/insights" className="flex flex-wrap items-end gap-2" data-testid="portal-insights-range">
          <label className="text-xs text-gray-500">
            {p.rangeFrom}
            <input type="date" name="from" defaultValue={ymd(period.from)} className="mt-0.5 block rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100" data-testid="portal-insights-from" />
          </label>
          <label className="text-xs text-gray-500">
            {p.rangeTo}
            <input type="date" name="to" defaultValue={ymd(period.to)} className="mt-0.5 block rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100" data-testid="portal-insights-to" />
          </label>
          <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700" data-testid="portal-insights-apply">
            {p.rangeApply}
          </button>
        </form>
        <PortalInsightsExport
          filename={`my-activity-${ymd(period.from)}-${ymd(period.to)}`}
          columns={[p.exportMetric, p.exportValue]}
          rows={exportRows}
          exportLabel={p.exportXlsx}
          printLabel={p.print}
        />
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
