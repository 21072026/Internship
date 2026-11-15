import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { Trophy, Users, CalendarDays, Coins } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { hasSalesSurface } from '@/lib/salesSurface';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { salesTargetApplies, type RankedEntry } from '@/lib/salesTargetRule';
import { loadSalesTeamView, type StageCount, type WindowCounts } from '@/lib/salesTeam';
import { boardColumnTone } from '@/lib/boardColumnTone';
import { formatMinorAmount } from '@/lib/money';
import { getServerDictionary } from '@/i18n/server';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';

// The sales team page (#3779, MARKETING only): what the team follows, where it
// stands and who won what — for every rep of the tenant. Names and counts only;
// the numbers come from src/lib/salesTeam.ts and its rules from
// src/lib/salesTargetRule.ts; the open records are the team book's
// (src/lib/salesTeamBook.ts), whose gate is salesTeamReadAllowed(). A person's
// name opens their records on the team board (`/sales/board?view=team&owners=`,
// WP2b), which shares that gate.

export default async function SalesTeamPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/signin');
  // The second door (the layout is the first): a surface and a vertical check.
  const capabilities = await shellCapabilities(session.user.orgId);
  if (!hasSalesSurface(session.user.role, capabilities) || !salesTargetApplies(capabilities)) notFound();

  const { t, locale } = await getServerDictionary();
  const s = t.sales.team;
  const lb = t.sales.leaderboard;
  const view = await loadSalesTeamView(session, locale);
  // The team book's gate (salesTeamReadAllowed): the org setting is off for reps.
  if (!view) notFound();
  const keys = view.stages.map((x) => x.key);
  const fill = (text: string, values: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

  return (
    <div data-testid="sales-team">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.title}</h1>
        <p className="text-gray-500 mt-1">{s.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 mb-8">
        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 shrink-0 bg-blue-100 rounded-xl flex items-center justify-center">
              <Users className="h-6 w-6 text-blue-600" aria-hidden="true" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 tabular-nums" data-testid="sales-team-active">{view.activeTotal}</p>
              <p className="text-sm text-gray-500">{s.active}</p>
              <p className="mt-1 text-xs text-gray-500" data-testid="sales-team-overdue-total">
                {fill(s.overdueTeam, { n: view.overdueTotal })}
              </p>
            </div>
          </div>
        </Card>
        <WindowCard title={s.thisWeek} hint={s.weekHint} counts={view.week} labels={s} testId="sales-team-week" />
        <WindowCard title={s.thisMonth} counts={view.month} labels={s} testId="sales-team-month" />
        <Card data-testid="sales-team-value">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 shrink-0 bg-green-100 rounded-xl flex items-center justify-center">
              <Coins className="h-6 w-6 text-green-600" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-gray-500">{s.pipelineValue}</h2>
              {view.pipelineValue.length === 0 ? (
                <p className="text-sm text-gray-500 mt-1">{s.pipelineValueEmpty}</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {view.pipelineValue.map((v) => (
                    <li key={v.currency} data-testid={`sales-team-value-${v.currency}`}>
                      <span className="text-lg font-semibold text-gray-900 tabular-nums">{formatMinorAmount(v.totalMinor, v.currency, locale)}</span>
                      <span className="ml-2 text-xs text-gray-500">{fill(s.pipelineValueDeals, { n: v.deals })}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-gray-500">{s.pipelineValueHint}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="mb-8" data-testid="sales-team-stages">
        <CardHeader>
          <CardTitle>{s.stagesTitle}</CardTitle>
        </CardHeader>
        <ul className="space-y-2">
          {view.stages.map((st) => (
            <li key={st.key} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm" data-testid={`sales-team-stage-${st.key}`}>
              <span className="truncate text-gray-700" title={st.label}>{st.label}</span>
              <StageBar stage={st} total={view.activeTotal} tone={boardColumnTone(st.key, keys)} />
              <span className="tabular-nums font-medium text-gray-900 text-right" data-testid={`sales-team-stage-count-${st.key}`}>{st.count}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mb-8" data-testid="sales-team-reps">
        <CardHeader>
          <CardTitle>{s.repsTitle}</CardTitle>
        </CardHeader>
        {view.reps.length === 0 ? (
          <p className="text-sm text-gray-500">{s.repsEmpty}</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={s.repsTitle}>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th scope="col" className="py-2 pr-3 font-medium">{s.rep}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">{s.open}</th>
                  <th scope="col" className="py-2 pr-3 font-medium min-w-[8rem]">{s.distribution}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">{lb.wonWeek}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">{lb.wonMonth}</th>
                  {/* Per-person overdue counts: admins and the dispatcher only (canSeeRepOverdue). */}
                  {view.repOverdueVisible && <th scope="col" className="py-2 font-medium text-right">{s.overdue}</th>}
                </tr>
              </thead>
              <tbody>
                {view.reps.map((r) => {
                  const me = r.userId === session.user.id;
                  return (
                    <tr
                      key={r.userId}
                      className={`border-b border-gray-100 last:border-0 ${me ? 'font-semibold' : ''}`}
                      data-testid={`sales-team-rep-${r.userId}`}
                      aria-current={me ? 'true' : undefined}
                    >
                      <th scope="row" className="py-2 pr-3 text-gray-900 font-normal break-words">
                        {/* That person's records on the team board (WP2b, read-only for a colleague). */}
                        <Link
                          href={`/sales/board?view=team&owners=${encodeURIComponent(r.userId)}`}
                          className="text-blue-600 hover:underline"
                          data-testid="rep-board-link"
                        >
                          {r.name}
                        </Link>
                        {me && <span className="ml-1 text-gray-500">{lb.you}</span>}
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums text-gray-900" data-testid="rep-open">{r.open}</td>
                      <td className="py-2 pr-3">
                        <MiniDistribution stages={r.stages} total={r.open} keys={keys} fill={fill} barText={s.stageBar} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-gray-900" data-testid="rep-won-week">{r.wonWeek}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-gray-900" data-testid="rep-won-month">{r.wonMonth}</td>
                      {view.repOverdueVisible && (
                        <td className="py-2 text-right tabular-nums text-gray-900" data-testid="rep-overdue">{r.overdue}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {view.leaderboard && (
        <Card data-testid="sales-team-leaderboard">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-gray-500" aria-hidden="true" />
              {s.leaderboardTitle}
            </CardTitle>
            <CardDescription>{s.leaderboardHint}</CardDescription>
          </CardHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Ranking title={s.thisWeek} entries={view.leaderboard.week} viewerId={session.user.id} lb={lb} testId="sales-team-rank-week" />
            <Ranking title={s.thisMonth} entries={view.leaderboard.month} viewerId={session.user.id} lb={lb} testId="sales-team-rank-month" />
          </div>
          <p className="mt-3 text-xs text-gray-500">{view.leaderboardForReps ? lb.sharedWithTeam : lb.adminOnly}</p>
        </Card>
      )}
    </div>
  );
}

function WindowCard({
  title,
  hint,
  counts,
  labels,
  testId,
}: {
  title: string;
  hint?: string;
  counts: WindowCounts;
  labels: { newLeads: string; won: string; lost: string };
  testId: string;
}) {
  const rows: Array<[string, number, string]> = [
    [labels.newLeads, counts.newLeads, 'new'],
    [labels.won, counts.won, 'won'],
    [labels.lost, counts.lost, 'lost'],
  ];
  return (
    <Card data-testid={testId}>
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 shrink-0 bg-amber-100 rounded-xl flex items-center justify-center">
          <CalendarDays className="h-6 w-6 text-amber-600" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-gray-500">{title}</h2>
          <dl className="mt-1 grid grid-cols-3 gap-2">
            {rows.map(([label, n, key]) => (
              <div key={key}>
                <dt className="text-xs text-gray-500">{label}</dt>
                <dd className="text-lg font-semibold text-gray-900 tabular-nums" data-testid={`${testId}-${key}`}>{n}</dd>
              </div>
            ))}
          </dl>
          {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
        </div>
      </div>
    </Card>
  );
}

/** A stage's share of the active total. The number beside it carries the meaning; the bar is decoration. */
function StageBar({ stage, total, tone }: { stage: StageCount; total: number; tone: string }) {
  const pct = total > 0 ? Math.round((stage.count / total) * 100) : 0;
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
      <div
        className={`h-full rounded-full border ${tone}`}
        style={{ width: `${pct}%`, ...(stage.color ? { backgroundColor: stage.color, borderColor: stage.color } : {}) }}
      />
    </div>
  );
}

/** A rep's open records split by stage: a stacked bar, with the same split as text for assistive tech. */
function MiniDistribution({
  stages,
  total,
  keys,
  fill,
  barText,
}: {
  stages: StageCount[];
  total: number;
  keys: string[];
  fill: (text: string, values: Record<string, string | number>) => string;
  barText: string;
}) {
  if (total === 0 || stages.length === 0) return <span className="text-gray-500">–</span>;
  const text = stages.map((st) => fill(barText, { label: st.label, n: st.count, total })).join(', ');
  return (
    <>
      <div className="flex h-3 w-full min-w-[6rem] overflow-hidden rounded-full bg-gray-100" aria-hidden="true" title={text}>
        {stages.map((st) => (
          <div
            key={st.key}
            className={`h-full border-r last:border-r-0 ${boardColumnTone(st.key, keys)}`}
            style={{ width: `${(st.count / total) * 100}%`, ...(st.color ? { backgroundColor: st.color } : {}) }}
          />
        ))}
      </div>
      <span className="sr-only">{text}</span>
    </>
  );
}

function Ranking({
  title,
  entries,
  viewerId,
  lb,
  testId,
}: {
  title: string;
  entries: RankedEntry[];
  viewerId: string;
  lb: { rank: string; name: string; won: string; you: string };
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h3 className="text-sm font-semibold text-gray-700 mb-2">{title}</h3>
      <div className="max-h-80 overflow-y-auto" tabIndex={0} role="region" aria-label={title}>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th scope="col" className="py-2 pr-3 font-medium w-12">{lb.rank}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{lb.name}</th>
              <th scope="col" className="py-2 font-medium text-right">{lb.won}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const me = e.userId === viewerId;
              return (
                <tr key={e.userId} className={`border-b border-gray-100 last:border-0 ${me ? 'font-semibold' : ''}`} aria-current={me ? 'true' : undefined}>
                  <td className="py-2 pr-3 tabular-nums text-gray-500">{e.rank}</td>
                  <td className="py-2 pr-3 text-gray-900 break-words">
                    {e.name}
                    {me && <span className="ml-1 text-gray-500 font-normal">{lb.you}</span>}
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-900">{e.won}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
