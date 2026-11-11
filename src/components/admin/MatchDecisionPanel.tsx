'use client';

import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { MatchScoreBreakdown } from '@/components/matching/MatchScoreBreakdown';
import type { MatchBreakdownEntry } from '@/lib/matching/types';
import { useT } from '@/i18n/client';

interface Decision {
  id: string;
  source: 'ADMIN_DIRECT' | 'REQUEST_APPROVAL' | 'MENTOR_ACCEPT' | 'BULK_ROUND' | 'MENTEE_PREFERENCE';
  score: number | null;
  breakdown: MatchBreakdownEntry[];
  blockedBy: string[];
  ruleSetVersion: number | null;
  suggestedRank: number | null;
  overrodeSuggestion: boolean;
  note: string | null;
  decidedAt: string;
  decidedByName: string | null;
}

// The pairing's audit record (#1789) on the relation detail view: the score
// and rule rows frozen at decision time, the rule set version, who decided,
// whether that overrode the shown ranking, and their note. The route decides
// who may read it (`audit.read`); this card simply draws nothing otherwise.
export function MatchDecisionPanel({ relationId }: { relationId: string }) {
  const t = useT();
  const d = t.matchDecision;
  const [rows, setRows] = useState<Decision[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/match-decisions?relationId=${encodeURIComponent(relationId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (alive) setRows(body?.decisions ?? []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [relationId]);

  if (!rows || rows.length === 0) return null;
  return (
    <Card data-testid="match-decision-panel">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-blue-600" aria-hidden />
          <CardTitle>{d.title}</CardTitle>
        </div>
      </CardHeader>
      <div className="space-y-4">
        {rows.map((r) => (
          <div key={r.id} className="space-y-2" data-testid={`match-decision-${r.id}`}>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">{d.sources[r.source] ?? r.source}</span>
              {' · '}
              {d.decidedBy.replace('{name}', r.decidedByName ?? '—')}
              {' · '}
              <RelativeTime date={r.decidedAt} />
              {r.ruleSetVersion != null && <span className="text-gray-500"> · {d.ruleSetVersion.replace('{n}', String(r.ruleSetVersion))}</span>}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400" data-testid="match-decision-ranking">
              {r.suggestedRank == null && !r.overrodeSuggestion
                ? d.notFromList
                : r.overrodeSuggestion
                  ? r.suggestedRank == null
                    ? d.overrodeOffList
                    : d.overrode.replace('{rank}', String(r.suggestedRank))
                  : d.topPick}
            </p>
            {r.score != null && <MatchScoreBreakdown score={r.score} breakdown={r.breakdown} blockedBy={r.blockedBy} />}
            {r.note && (
              <p className="whitespace-pre-line rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-800 dark:text-gray-200" data-testid="match-decision-note">
                {r.note}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
