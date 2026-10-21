'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import type { HealthBand, HealthReason } from '@/lib/relationHealth';

// The relationship health badge (#1904): band chip, score, a 30-day sparkline
// and the reasons on hover/focus. PURELY PRESENTATIONAL — it takes what
// GET /api/relation-health returns (the same computation as /admin/health,
// #1902) and fetches nothing; `useRelationHealth` below is the one reader the
// three mount points share. The sparkline is the product's CSS bars inside a
// pinned-height track (a percentage height needs a definite parent), no
// charting library. The reason labels are the attention queue's own strings.

export interface TrendPoint {
  day: string;
  score: number | null;
  band: HealthBand;
}

export interface HealthBadgeProps {
  score: number | null;
  band: HealthBand;
  reasons: HealthReason[];
  trend: TrendPoint[];
  testId?: string;
}

export type RelationHealth = ({ excluded?: false } & { score: number | null; band: HealthBand; reasons: HealthReason[]; series: TrendPoint[]; trend30: number | null }) | { excluded: true };

const BAND_VARIANT: Record<HealthBand, 'success' | 'warning' | 'danger'> = { HEALTHY: 'success', WATCH: 'warning', AT_RISK: 'danger' };
const BAND_BAR: Record<HealthBand, string> = { HEALTHY: 'bg-green-500', WATCH: 'bg-amber-500', AT_RISK: 'bg-red-500' };
const TRACK_PX = 20;

export function HealthBadge({ score, band, reasons, trend, testId = 'health-badge' }: HealthBadgeProps) {
  const t = useT();
  const h = t.adminHealth;
  const reasonLabel: Record<HealthReason, string> = {
    inactive: t.mentor.attention.inactive,
    overdue: t.mentor.attention.overdue,
    unanswered_question: t.mentor.attention.unansweredQuestion,
    pending_meeting: t.mentor.attention.pendingMeeting,
    no_open_goal: t.mentor.attention.noOpenGoal,
    missing_weekly_reports: t.weeklyReports.missingAttention,
    stage_stalled: h.stageStalled,
  };
  const bandLabel = band === 'AT_RISK' ? h.atRisk : band === 'WATCH' ? h.watch : h.healthy;
  const reasonText = reasons.map((r) => reasonLabel[r]).join(' · ');

  return (
    <span className="group relative inline-flex items-center gap-2" data-testid={testId} data-band={band}>
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        aria-label={`${h.title}: ${bandLabel}${score !== null ? ` ${score}` : ''}${reasonText ? ` — ${reasonText}` : ''}`}
      >
        <Badge variant={BAND_VARIANT[band]} data-testid={`${testId}-band`}>{bandLabel}</Badge>
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100" data-testid={`${testId}-score`}>{score ?? h.noScore}</span>
        {trend.length > 0 && (
          <span className="flex w-16 items-end gap-px" style={{ height: TRACK_PX }} aria-hidden="true" data-testid={`${testId}-spark`}>
            {trend.map((p) => (
              <span key={p.day} className={`block min-w-[2px] flex-1 rounded-sm ${BAND_BAR[p.band]}`} style={{ height: `${Math.max(p.score ?? 0, 4)}%` }} />
            ))}
          </span>
        )}
      </button>
      <span
        role="tooltip"
        className="invisible absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 shadow-lg group-focus-within:visible group-hover:visible dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        data-testid={`${testId}-tooltip`}
      >
        {reasons.length > 0 ? (
          <ul className="mb-2 list-disc space-y-0.5 pl-4">
            {reasons.map((r) => <li key={r}>{reasonLabel[r]}</li>)}
          </ul>
        ) : null}
        <span className="block text-gray-500 dark:text-gray-400">{h.howLead}</span>
      </span>
    </span>
  );
}

/** Health for a set of relation ids, from GET /api/relation-health (≤100 per call). */
export function useRelationHealth(ids: string[]): Record<string, RelationHealth> {
  const key = [...new Set(ids)].sort().join(',');
  const [health, setHealth] = useState<Record<string, RelationHealth>>({});
  useEffect(() => {
    if (!key) return;
    let live = true;
    const all = key.split(',');
    const chunks = Array.from({ length: Math.ceil(all.length / 100) }, (_, i) => all.slice(i * 100, i * 100 + 100));
    Promise.all(
      chunks.map((chunk) =>
        fetch(`/api/relation-health?ids=${encodeURIComponent(chunk.join(','))}`)
          .then((r) => (r.ok ? r.json() : { health: {} }))
          .then((b) => (b.health ?? {}) as Record<string, RelationHealth>)
          .catch(() => ({}) as Record<string, RelationHealth>),
      ),
    ).then((parts) => {
      if (live) setHealth(Object.assign({}, ...parts));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return health;
}

/** A badge for one relation, or nothing while loading / when it is not scored. */
export function RelationHealthBadge({ health, testId }: { health: RelationHealth | undefined; testId?: string }) {
  if (!health || health.excluded) return null;
  return <HealthBadge score={health.score} band={health.band} reasons={health.reasons} trend={health.series} testId={testId} />;
}
