import { Lock, Sprout } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { Dictionary } from '@/i18n/dictionaries';
import type { MentorImpactSummary } from '@/lib/mentorImpact';

// The mentor's private "your impact" card (light gamification, 2026-10). Four
// true counts from src/lib/mentorImpactRule.ts — no points, no badges, no rank.
// The caller renders nothing when getMentorImpact() returns null (no relations
// yet, or a vertical without mentorship): an empty card full of zeros would be
// motivation copy, not a fact.

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

function Stat({ testId, value, label }: { testId: string; value: number; label: string }) {
  return (
    <div data-testid={testId} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid={`${testId}-value`}>
        {value}
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-300">{label}</p>
    </div>
  );
}

function Reached({
  testId,
  value,
  total,
  label,
  ofTotal,
}: {
  testId: string;
  value: number;
  total: number;
  label: string;
  ofTotal: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const text = fill(ofTotal, { n: value, total });
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-gray-700 dark:text-gray-200">{label}</span>
        <span className="font-semibold text-gray-900 dark:text-gray-100 whitespace-nowrap" data-testid={`${testId}-value`}>
          {text}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
        aria-valuetext={text}
        className="mt-1.5 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden"
      >
        <div className="h-full rounded-full bg-emerald-600 dark:bg-emerald-400" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function MentorImpactCard({ impact, t }: { impact: MentorImpactSummary; t: Dictionary }) {
  const L = t.mentorImpact;
  // A tenant that named its finished stage gets its own word; the built-in
  // catalogue keeps our translated "Hired" (same split as OutcomeStageKeys).
  const outcomeLabel = impact.finishedLabelIsCustom
    ? fill(L.reachedOutcomeCustom, { stage: impact.finishedLabel })
    : L.reachedOutcome;

  return (
    <Card className="mb-8" data-testid="mentor-impact-card" role="region" aria-labelledby="mentor-impact-title">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <Sprout className="h-5 w-5 text-emerald-700" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 id="mentor-impact-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {L.title}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 flex items-start gap-1.5 mt-0.5">
            <Lock className="h-3.5 w-3.5 flex-shrink-0 mt-[3px]" aria-hidden="true" />
            <span>{L.privateNote}</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <Stat testId="mentor-impact-mentored" value={impact.mentored} label={L.mentored} />
        <Stat testId="mentor-impact-active" value={impact.active} label={L.active} />
      </div>

      <div className="space-y-3">
        {impact.reachedInternship !== null && (
          <Reached
            testId="mentor-impact-internship"
            value={impact.reachedInternship}
            total={impact.mentored}
            label={L.reachedInternship}
            ofTotal={L.ofTotal}
          />
        )}
        <Reached
          testId="mentor-impact-outcome"
          value={impact.reachedOutcome}
          total={impact.mentored}
          label={outcomeLabel}
          ofTotal={L.ofTotal}
        />
      </div>

      <p className="mt-4 text-xs text-gray-600 dark:text-gray-400">{L.footnote}</p>
    </Card>
  );
}
