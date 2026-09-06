'use client';

/**
 * MatchScoreBreakdown (#1785) — the human-readable half of the match score.
 *
 * Purely presentational: it renders from props and does nothing else. No
 * `fetch()`, no Prisma, no server imports — the score is computed by
 * `scoreMatch()` (#1781) and handed in, so this component can also be used to
 * preview a rule set client-side.
 *
 * COMPLIANCE, not decoration. Ranking candidates for a hiring outcome is a
 * high-risk automated decision under the EU AI Act, and the per-rule rows plus
 * the "not a prediction" footer are what keep the ranking explainable and
 * contestable. Consequences for anyone editing this file:
 *   • there is deliberately NO variant that shows the number on its own;
 *   • the footer is unconditional in full mode;
 *   • the score is deterministic rule arithmetic and is never labelled "AI";
 *   • a blocked pair is a different OUTCOME from a low score and is rendered as
 *     one — red, named, and above everything else.
 *
 * Dark mode: the tinted `bg-*-50` panels rely on the compound overrides in
 * `src/app/globals.css` (mid-tone accent text on a retinted box), and the
 * accent text sitting directly on the white card is covered by the
 * `.match-score` block added there for this component.
 */

import { Ban, Check, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import type { MatchBreakdownEntry, MatchScore } from '@/lib/matching/types';

export interface MatchScoreBreakdownProps extends MatchScore {
  /** One-line form for a list row. Full form (ring + rules) is the default. */
  compact?: boolean;
  className?: string;
}

type Tier = 'blocked' | 'strong' | 'partial' | 'weak';

/** Green ≥ 70, amber 40-69, grey < 40 — and red whenever anything blocks. */
function tierOf(score: number, blockedBy: string[]): Tier {
  if (blockedBy.length > 0) return 'blocked';
  if (score >= 70) return 'strong';
  if (score >= 40) return 'partial';
  return 'weak';
}

const PILL_VARIANT: Record<Tier, 'success' | 'warning' | 'default' | 'danger'> = {
  strong: 'success',
  partial: 'warning',
  weak: 'default',
  blocked: 'danger',
};

/** Ring + tier-label colour. Dark shades come from the `.match-score` block. */
const TIER_TEXT: Record<Tier, string> = {
  strong: 'text-green-700',
  partial: 'text-amber-700',
  weak: 'text-gray-500',
  blocked: 'text-red-700',
};

const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/** Points are displayed to one decimal at most — "12.5 pts", never "12.4999". */
const fmtPoints = (n: number) => String(Math.round(n * 10) / 10);

export function MatchScoreBreakdown({
  score,
  breakdown,
  blockedBy,
  compact = false,
  className,
}: MatchScoreBreakdownProps) {
  const t = useT();
  const m = t.matchScore;
  const dimensionNames = m.dimensions as Record<string, string>;
  const kindNames = m.kinds as Record<string, string>;

  /** Unknown dimensions fall back to their raw key rather than vanishing. */
  const dimLabel = (dimension: string) => dimensionNames[dimension] ?? dimension;

  const pct = clampPct(score);
  const tier = tierOf(pct, blockedBy);
  const srScore = m.srScore.replace('{n}', String(pct));

  if (compact) {
    // One list row at 320px: the pill never shrinks, the label truncates.
    // Blocked shows the blocking rule instead of the top factor — on a narrow
    // row that is the one thing a coordinator has to see.
    const secondary = blockedBy.length > 0 ? dimLabel(blockedBy[0]) : topFactorLabel(breakdown, dimLabel);
    return (
      <span
        data-testid="match-score-compact"
        data-tier={tier}
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap ${className ?? ''}`}
        title={blockedBy.length > 0 ? `${m.tiers.blocked}: ${secondary}` : srScore}
      >
        <Badge variant={PILL_VARIANT[tier]} className="shrink-0 tabular-nums">
          {blockedBy.length > 0 && <Ban className="h-3 w-3" aria-hidden="true" />}
          {pct}%
        </Badge>
        {secondary && (
          <span className="min-w-0 truncate text-xs text-gray-600 dark:text-gray-400">{secondary}</span>
        )}
        <span className="sr-only">
          {srScore}
          {blockedBy.length > 0 ? ` — ${m.tiers.blocked}: ${blockedBy.map(dimLabel).join(', ')}` : ''}
        </span>
      </span>
    );
  }

  // Full mode. Blocking rules come first everywhere: their own red panel above
  // the list, and their rows hoisted to the top of it.
  const blockedSet = new Set(blockedBy);
  const rows = [
    ...breakdown.filter((e) => blockedSet.has(e.dimension)),
    ...breakdown.filter((e) => !blockedSet.has(e.dimension)),
  ];

  return (
    <Card padding="sm" className={`match-score ${className ?? ''}`} data-testid="match-score" data-tier={tier}>
      <div className="flex items-center gap-4">
        <ScoreRing pct={pct} tier={tier} label={srScore} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{m.title}</p>
          <p className={`flex items-center gap-1.5 text-base font-semibold ${TIER_TEXT[tier]}`}>
            {tier === 'blocked' && <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {m.tiers[tier]}
          </p>
        </div>
      </div>

      {blockedBy.length > 0 && (
        <div
          data-testid="match-score-blocked"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-red-800">
            <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
            {m.blockedTitle}
          </p>
          <ul className="mt-2 space-y-1">
            {blockedBy.map((dimension) => (
              <li key={dimension} className="text-sm text-red-700">
                {dimLabel(dimension)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-red-700">{m.blockedHelp}</p>
        </div>
      )}

      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {m.rulesTitle}
      </p>

      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{m.noRules}</p>
      ) : (
        <ul className="mt-1 divide-y divide-gray-100" data-testid="match-score-rules">
          {rows.map((entry) => (
            <RuleRow
              key={`${entry.dimension}-${entry.kind}`}
              entry={entry}
              blocking={blockedSet.has(entry.dimension)}
              label={dimLabel(entry.dimension)}
              kindLabel={kindNames[entry.kind] ?? entry.kind}
              strings={{
                matched: m.matched,
                notMatched: m.notMatched,
                weightValue: m.weightValue,
                pointsValue: m.pointsValue,
              }}
            />
          ))}
        </ul>
      )}

      {/* Required, unconditional, never behind a prop — see the header note. */}
      <p
        data-testid="match-score-footer"
        className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:text-gray-400"
      >
        {m.footer}
      </p>
    </Card>
  );
}

function topFactorLabel(breakdown: MatchBreakdownEntry[], dimLabel: (d: string) => string): string {
  const top = breakdown.reduce<MatchBreakdownEntry | null>(
    (best, e) => (e.passed && (!best || e.contribution > best.contribution) ? e : best),
    null
  );
  return top ? dimLabel(top.dimension) : '';
}

function ScoreRing({ pct, tier, label }: { pct: number; tier: Tier; label: string }) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="relative h-[72px] w-[72px] shrink-0">
      <svg viewBox="0 0 72 72" className={`h-full w-full -rotate-90 ${TIER_TEXT[tier]}`} role="img" aria-label={label}>
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="none"
          strokeWidth="6"
          className="stroke-gray-200 dark:stroke-gray-700"
        />
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100"
      >
        {pct}%
      </span>
    </div>
  );
}

function RuleRow({
  entry,
  blocking,
  label,
  kindLabel,
  strings,
}: {
  entry: MatchBreakdownEntry;
  blocking: boolean;
  label: string;
  kindLabel: string;
  strings: { matched: string; notMatched: string; weightValue: string; pointsValue: string };
}) {
  const weighted = entry.kind === 'WEIGHTED';

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-testid={`match-rule-${entry.dimension}`}>
      <span className="mt-0.5 shrink-0" title={entry.passed ? strings.matched : strings.notMatched}>
        {entry.passed ? (
          <Check className="h-4 w-4 text-green-700" aria-hidden="true" />
        ) : blocking ? (
          <Ban className="h-4 w-4 text-red-700" aria-hidden="true" />
        ) : (
          <X className="h-4 w-4 text-gray-400" aria-hidden="true" />
        )}
        <span className="sr-only">{entry.passed ? strings.matched : strings.notMatched}</span>
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={`text-sm font-medium ${blocking ? 'text-red-700' : 'text-gray-900 dark:text-gray-100'}`}
        >
          {label}
        </span>
        {!weighted && (
          <Badge variant={blocking ? 'danger' : 'default'} className="ml-2 align-middle">
            {kindLabel}
          </Badge>
        )}
        {entry.detail.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {entry.detail.map((d) => (
              <Badge key={d} variant={entry.passed ? 'success' : 'default'}>
                {d}
              </Badge>
            ))}
          </span>
        )}
      </span>

      <span className="shrink-0 text-right">
        {weighted && (
          <span className="block text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {strings.weightValue.replace('{n}', String(entry.weight))}
          </span>
        )}
        <span
          className={`block text-sm font-semibold tabular-nums ${
            entry.contribution > 0 ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'
          }`}
        >
          {strings.pointsValue.replace('{n}', fmtPoints(entry.contribution))}
        </span>
      </span>
    </li>
  );
}

export default MatchScoreBreakdown;
