import { Target, Users } from 'lucide-react';
import type { Dictionary } from '@/i18n/dictionaries';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import type { SalesTargetView } from '@/lib/salesTarget';

// The won-this-month card and the team leaderboard on /sales (MARKETING only).
// Server-rendered from `loadSalesTargetView()`; the page decides the vertical.
// Every number here is a count of recorded stage moves — no points, no badges,
// no deal values, and nothing about how much anyone logged.

export function SalesTargetCards({ view, t, viewerId }: { view: SalesTargetView; t: Dictionary; viewerId: string }) {
  const s = t.sales;
  const { own, leaderboard } = view;
  const headline =
    own.target !== null
      ? s.target.progress.replace('{n}', String(own.won)).replace('{target}', String(own.target))
      : s.target.count.replace('{n}', String(own.won));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
      <Card data-testid="sales-target-card">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 shrink-0 bg-blue-100 rounded-xl flex items-center justify-center">
            <Target className="h-6 w-6 text-blue-600" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-gray-500">{s.target.title}</h2>
            <p className="text-lg font-semibold text-gray-900 mt-0.5" data-testid="sales-target-headline">{headline}</p>
            {own.target !== null && own.percent !== null && (
              <>
                <div
                  role="progressbar"
                  aria-label={s.target.progressLabel}
                  aria-valuemin={0}
                  aria-valuemax={own.target}
                  aria-valuenow={Math.min(own.won, own.target)}
                  aria-valuetext={headline}
                  className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-gray-100"
                  data-testid="sales-target-progress"
                >
                  <div
                    className={`h-full rounded-full ${own.reached ? 'bg-green-600' : 'bg-blue-600'}`}
                    style={{ width: `${own.percent}%` }}
                  />
                </div>
                {own.reached && (
                  <p className="mt-2 text-sm font-medium text-green-700 dark:!text-green-300" data-testid="sales-target-reached">
                    {s.target.reached}
                  </p>
                )}
              </>
            )}
            <p className="mt-2 text-xs text-gray-500">{s.target.hint}</p>
          </div>
        </div>
      </Card>

      {leaderboard && (
        <Card data-testid="sales-leaderboard">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-gray-500" aria-hidden="true" />
              {s.leaderboard.title}
            </CardTitle>
            <CardDescription>{s.leaderboard.subtitle}</CardDescription>
          </CardHeader>
          {leaderboard.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="sales-leaderboard-empty">{s.leaderboard.empty}</p>
          ) : (
            <div className="max-h-80 overflow-y-auto" tabIndex={0} role="region" aria-label={s.leaderboard.title}>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th scope="col" className="py-2 pr-3 font-medium w-12">{s.leaderboard.rank}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{s.leaderboard.name}</th>
                    <th scope="col" className="py-2 font-medium text-right">{s.leaderboard.won}</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((e) => {
                    const me = e.userId === viewerId;
                    return (
                      <tr
                        key={e.userId}
                        className={`border-b border-gray-100 last:border-0 ${me ? 'font-semibold' : ''}`}
                        data-testid={`sales-leaderboard-row-${e.userId}`}
                        aria-current={me ? 'true' : undefined}
                      >
                        <td className="py-2 pr-3 tabular-nums text-gray-500">{e.rank}</td>
                        <td className="py-2 pr-3 text-gray-900 break-words">
                          {e.name}
                          {me && <span className="ml-1 text-gray-500 font-normal">{s.leaderboard.you}</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums text-gray-900">{e.won}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-gray-500" data-testid="sales-leaderboard-visibility">
            {view.leaderboardForReps ? s.leaderboard.sharedWithTeam : s.leaderboard.adminOnly}
          </p>
        </Card>
      )}
    </div>
  );
}
