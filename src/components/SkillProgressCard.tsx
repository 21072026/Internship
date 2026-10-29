import { ArrowRight, BadgeCheck, TrendingUp } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import type { SkillProgressView } from '@/lib/skillLevels';

interface Labels {
  progressTitle: string;
  progressHint: string;
  progressAria: string;
  confirmed: string;
  verifiedTitle: string;
}

// The mentee's own progression strip (#1822): per rated skill, the level they
// started at and the level now, with the mark when it was confirmed in the
// programme. Server-rendered from `skillProgressOf()`; renders nothing until
// a skill is rated, so an empty card never asks for attention.
export function SkillProgressCard({ rows, t }: { rows: SkillProgressView[]; t: Labels }) {
  if (rows.length === 0) return null;
  return (
    <Card data-testid="skill-progress">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-blue-600" aria-hidden />
          {t.progressTitle}
        </CardTitle>
      </CardHeader>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t.progressHint}</p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {rows.map((r) => {
          const grew = r.now > r.start;
          return (
            <li
              key={r.skillId}
              className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm"
              data-testid={`skill-progress-${r.skillId}`}
            >
              <span className="truncate text-gray-800 dark:text-gray-100">
                {r.label}
                {r.verified && (
                  <span title={t.verifiedTitle} className="ml-1 inline-flex align-text-bottom">
                    <BadgeCheck className="h-4 w-4 text-green-600 dark:text-green-400" aria-label={t.confirmed} />
                  </span>
                )}
              </span>
              <span
                className={`flex items-center gap-1 font-medium tabular-nums ${grew ? 'text-green-700 dark:text-green-400' : 'text-gray-700 dark:text-gray-200'}`}
                aria-label={t.progressAria.replace('{start}', String(r.start)).replace('{now}', String(r.now))}
              >
                <span aria-hidden>{r.start}</span>
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                <span aria-hidden>{r.now}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400" aria-hidden>/5</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
