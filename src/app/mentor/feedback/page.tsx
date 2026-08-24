'use client';

import { useEffect, useMemo, useState } from 'react';
import { BarChart3, MessageSquareText, Star } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { MENTOR_CRITERIA, mentorFeedbackAverage, type MentorCriterion } from '@/lib/evaluation';
import { useLocale, useT } from '@/i18n/client';

interface ReceivedEvaluation {
  id: string;
  type: 'INTERIM' | 'FINAL';
  scores: Record<string, unknown>;
  comment: string | null;
  createdAt: string;
  direction: 'MENTEE_ON_MENTOR';
  mentee: { id: string; fullName: string };
}

export default function MentorFeedbackPage() {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<ReceivedEvaluation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/evaluations?received=1')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => setItems(data.evaluations ?? []))
      .catch((cause) => {
        console.error('[mentor/feedback]', cause);
        setError(t.common.error);
      })
      .finally(() => setLoading(false));
  }, [t.common.error]);

  const overall = mentorFeedbackAverage(items.map((item) => item.scores));
  const criterionAverages = MENTOR_CRITERIA.map((criterion) => ({
    criterion,
    average: mentorFeedbackAverage(items.map((item) => ({ [criterion]: item.scores[criterion] }))),
  }));
  const trend = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 6 }, (_, index) => {
      const month = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
      const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      const scores = items
        .filter((item) => {
          const createdAt = new Date(item.createdAt);
          return createdAt >= month && createdAt < nextMonth;
        })
        .map((item) => item.scores);
      return {
        key: `${month.getFullYear()}-${month.getMonth()}`,
        label: new Intl.DateTimeFormat(locale, { month: 'short' }).format(month),
        average: mentorFeedbackAverage(scores),
      };
    }).filter((month) => month.average !== null);
  }, [items, locale]);

  const feedback = t.mentorFeedback;
  const criterionLabel = (criterion: MentorCriterion) => t.evaluation.criteria[criterion];
  const typeLabel = (type: ReceivedEvaluation['type']) => type === 'FINAL' ? t.evaluation.final : t.evaluation.interim;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{feedback.title}</h1>
        <p className="mt-1 text-gray-500 dark:text-gray-400">{feedback.subtitle}</p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <Card><SkeletonRows rows={5} /></Card>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="mentor-feedback-empty">{feedback.none}</p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Card>
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-blue-500">
                  <Star className="h-6 w-6 text-white" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="mentor-feedback-overall">{overall !== null ? `${overall.toFixed(1)}/5` : '—'}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{feedback.overallAverage}</p>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-purple-500">
                  <MessageSquareText className="h-6 w-6 text-white" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{items.length}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{feedback.total}</p>
                </div>
              </div>
            </Card>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {criterionAverages.map(({ criterion, average }) => (
              <Card key={criterion}>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{average !== null ? `${average.toFixed(1)}/5` : '—'}</p>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{criterionLabel(criterion)}</p>
              </Card>
            ))}
          </div>

          {trend.length > 0 && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-blue-500" />
                  {feedback.trend}
                </CardTitle>
              </CardHeader>
              <div className="flex h-32 items-end gap-3" data-testid="mentor-feedback-trend">
                {trend.map((month) => (
                  <div key={month.key} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">{month.average!.toFixed(1)}</span>
                    <div className="w-full max-w-12 rounded-t bg-blue-400" style={{ height: `${(month.average! / 5) * 80}%` }} />
                    <span className="text-xs text-gray-400">{month.label}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>{feedback.listTitle}</CardTitle></CardHeader>
            <div className="space-y-3">
              {items.map((item) => {
                const average = mentorFeedbackAverage(item.scores);
                return (
                  <div key={item.id} className="rounded-lg border border-gray-100 p-3 dark:border-gray-800" data-testid="mentor-feedback-item">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">{item.mentee.fullName}</span>
                      <Badge variant={item.type === 'FINAL' ? 'success' : 'info'}>{typeLabel(item.type)}</Badge>
                      {average !== null && <span className="ml-auto text-sm font-semibold text-gray-700 dark:text-gray-300">{average.toFixed(1)}/5</span>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      {MENTOR_CRITERIA.filter((criterion) => typeof item.scores[criterion] === 'number').map((criterion) => (
                        <span key={criterion} className="text-gray-700 dark:text-gray-300">{criterionLabel(criterion)}: <strong>{String(item.scores[criterion])}/5</strong></span>
                      ))}
                    </div>
                    {item.comment && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-400">{item.comment}</p>}
                    <p className="mt-2 text-xs text-gray-400">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(item.createdAt))}</p>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
