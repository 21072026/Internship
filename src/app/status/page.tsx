import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/pageMetadata';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { GITHUB_URL } from '@/components/landing/links';
import { formatDate, formatDateTime } from '@/lib/relativeTime';
import { statusReport } from '@/lib/statusSample';
import { STATUS_INCIDENTS } from '@/lib/statusIncidents';
import { slaTarget, type ComponentState, type DayState, type StatusReport } from '@/lib/statusRule';
import { logger } from '@/lib/logger';

// Read per request: the component rows must change without a deploy (#1604).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.statusPage.title, description: t.statusPage.subtitle }));
}

const STATE_DOT: Record<ComponentState, string> = {
  operational: 'bg-green-600',
  degraded: 'bg-amber-500',
  down: 'bg-red-600',
  unknown: 'bg-gray-400',
};

const DAY_BAR: Record<DayState, string> = {
  up: 'bg-green-600',
  partial: 'bg-amber-500',
  down: 'bg-red-600',
  nodata: 'bg-gray-200 dark:bg-gray-700',
};

/**
 * /status (#1604) — public, no session. What it may show is fixed by
 * `src/lib/statusRule.ts`: up / degraded / down per component and the 90-day
 * figures, never a version, sha, host, port or error text — the HEALTH_TOKEN
 * gate on /api/health (#897) is not bypassed, because this page never calls
 * /api/health: it reads the samples the `status.sample` job wrote.
 *
 * If the database cannot be read, the page still renders and says the state is
 * unknown — a status page that 500s during an outage is the one failure it
 * exists to avoid.
 */
export default async function StatusPage() {
  const { t, locale } = await getServerDictionary();
  const p = t.statusPage;

  let report: StatusReport | null = null;
  try {
    report = await statusReport();
  } catch (e) {
    logger.warning('status_page.read_failed', { error: e instanceof Error ? e.name : 'unknown' });
  }
  const sla = slaTarget(process.env.STATUS_SLA_TARGET);
  const overall: ComponentState = report?.overall ?? 'unknown';
  const lang = (locale === 'tr' || locale === 'de' ? locale : 'en') as 'en' | 'tr' | 'de';
  const pct = (n: number | null) => (n === null ? p.noData : `${n.toFixed(n === 100 ? 0 : 2)} %`);

  return (
    <PublicShell breadcrumb={{ name: p.title, path: '/status' }}>
      <div className="max-w-4xl mx-auto my-12 px-4" data-testid="status-page">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{p.title}</h1>
          <p className="mt-2 text-base text-gray-600 dark:text-gray-300">{p.subtitle}</p>
        </header>

        <section
          data-testid="status-overall"
          data-state={overall}
          className="mb-8 flex items-center gap-3 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5"
        >
          <span className={`h-3 w-3 rounded-full flex-shrink-0 ${STATE_DOT[overall]}`} aria-hidden="true" />
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{p.overall[overall]}</p>
        </section>

        <section className="mb-10" data-testid="status-components">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">{p.componentsTitle}</h2>
          <ul className="divide-y divide-gray-200 dark:divide-gray-800 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            {(report?.components ?? (['web', 'mail', 'jobs'] as const).map((key) => ({ key, state: 'unknown' as const, uptimePct: null }))).map((c) => (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 px-5 py-4" data-testid={`status-component-${c.key}`} data-state={c.state}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.components[c.key]}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {p.uptimeLabel}: {pct(c.uptimePct)}
                  </p>
                </div>
                <span className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                  <span className={`h-2.5 w-2.5 rounded-full ${STATE_DOT[c.state]}`} aria-hidden="true" />
                  {p.state[c.state]}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-10" data-testid="status-history">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{p.historyTitle}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
            {p.historyUptime.replace('{pct}', pct(report?.uptimePct ?? null))}
            {report?.since ? ` ${p.historySince.replace('{date}', formatDate(report.since, locale))}` : ''}
          </p>
          {report && (
            <div className="flex gap-px h-8" role="img" aria-label={p.historyAria}>
              {report.days.map((d) => (
                <span key={d.date} title={`${d.date} · ${p.day[d.state]}`} className={`flex-1 rounded-sm ${DAY_BAR[d.state]}`} />
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{p.measurement}</p>
        </section>

        <section className="mb-10" data-testid="status-incidents">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">{p.incidentsTitle}</h2>
          {STATUS_INCIDENTS.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">{p.noIncidents}</p>
          ) : (
            <ol className="space-y-4">
              {STATUS_INCIDENTS.map((i) => (
                <li key={i.id} className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {i.severity} · {i.title[lang]}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatDateTime(i.startedAt, locale)} – {i.resolvedAt ? formatDateTime(i.resolvedAt, locale) : p.ongoing}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {i.updates.map((u) => (
                      <li key={u.at} className="text-sm text-gray-600 dark:text-gray-300">
                        <span className="text-xs text-gray-500 dark:text-gray-400">{formatDateTime(u.at, locale)}</span> — {u.text[lang]}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="mb-10" data-testid="status-commitment">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{p.commitmentTitle}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="status-sla">
            {sla ? p.commitmentSet.replace('{pct}', sla) : p.commitmentUnset}
          </p>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <a className="text-blue-700 dark:text-blue-400 underline" href={`${GITHUB_URL}/blob/main/docs/sla.md`} target="_blank" rel="noopener noreferrer">
                {p.slaLink}
              </a>
            </li>
            <li>
              <a className="text-blue-700 dark:text-blue-400 underline" href={`${GITHUB_URL}/blob/main/docs/incident-response.md`} target="_blank" rel="noopener noreferrer">
                {p.incidentProcessLink}
              </a>
            </li>
          </ul>
        </section>
      </div>
    </PublicShell>
  );
}
