import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { formatDuration, type MenteeActivity } from '@/lib/activityReport';
import { relativeTime } from '@/lib/relativeTime';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';

const RANGES = [1, 7, 30] as const;

// Presentational, server-rendered report body shared by the mentor and admin
// activity pages. `basePath` is where the range links point (?days=…).
export function ActivityReportView({
  items,
  days,
  basePath,
  subtitle,
  t,
  locale,
}: {
  items: MenteeActivity[];
  days: number;
  basePath: string;
  subtitle: string;
  t: Dictionary;
  locale: Locale;
}) {
  const a = t.activityReport;

  const loginText = (m: MenteeActivity): string => {
    if (m.daysSinceLogin === null) return a.neverLoggedIn;
    if (m.daysSinceLogin <= 0) return a.loggedInToday;
    return a.daysSinceLogin.replace('{n}', String(m.daysSinceLogin));
  };

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
          <p className="text-gray-500 mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 p-1 self-start">
          {RANGES.map((d) => (
            <Link
              key={d}
              href={`${basePath}?days=${d}`}
              className={`px-3 py-1.5 rounded-md text-sm ${
                days === d ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {(a.range as Record<string, string>)[`d${d}`]}
            </Link>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <Card><p className="text-center py-10 text-gray-400">{a.noData}</p></Card>
      ) : (
        <div className="space-y-4">
          {items.map((m) => (
            <Card key={m.menteeId} className={m.active ? undefined : 'opacity-75'}>
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{m.menteeName}</span>
                  {!m.active && (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{a.inactive}</span>
                  )}
                </div>
                <span className={`text-xs ${m.daysSinceLogin !== null && m.daysSinceLogin >= 7 ? 'text-amber-700 dark:text-amber-400 font-medium' : 'text-gray-500'}`}>
                  {loginText(m)}
                  {m.lastLoginAt ? ` · ${relativeTime(m.lastLoginAt, locale)}` : ''}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                <Metric label={a.metrics.timeOnSite} value={formatDuration(m.timeOnSiteSec)} />
                <Metric label={a.metrics.pages} value={m.pageViews} />
                <Metric label={a.metrics.goalsDone} value={m.goalsCompleted} />
                <Metric label={a.metrics.interactions} value={m.interactions} />
                <Metric label={a.metrics.meetings} value={m.meetings} />
                <Metric label={a.metrics.pipeline} value={m.pipelineChanges} />
                <Metric label={a.metrics.messages} value={`${m.messagesSent}/${m.messagesReceived}`} />
              </div>

              {m.topPages.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                  <p className="text-xs font-medium text-gray-500 mb-1.5">{a.topPages}</p>
                  <ul className="flex flex-wrap gap-2">
                    {m.topPages.map((p) => (
                      <li key={p.path} className="text-xs bg-gray-50 dark:bg-gray-800 rounded px-2 py-1 text-gray-600 dark:text-gray-300">
                        <span className="font-mono">{p.path}</span>
                        <span className="text-gray-400"> · {p.views}× · {formatDuration(p.seconds)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-4">{a.privacyNote}</p>
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
