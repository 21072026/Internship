'use client';

// One interview panel: your own scorecard, and — only once the panel is done —
// everyone else's side by side with the divergence the calibration conversation
// should start from (#824).
//
// Everything gated here is ALSO gated on the server. This component never
// receives another interviewer's scores until it is allowed to, so hiding is
// not what protects them; the API is (#740 is the reason that sentence is in
// this file).

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CheckCircle2, Circle, Lock, TriangleAlert, UserRoundX } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { useCriterionLabel } from '@/lib/evaluationCriteriaClient';
import { DIVERGENCE_THRESHOLD, type CriterionDivergence } from '@/lib/interviewPanel';
import type { ResolvedCriterion } from '@/lib/evaluation';

interface PanelData {
  panel: {
    id: string;
    title: string | null;
    subjectName: string | null;
    // Blind review (#819): the identity is withheld server-side until this
    // viewer has submitted their own scorecard.
    blind: boolean;
    blindLabel: string | null;
    scheduledAt: string | null;
    closedAt: string | null;
    complete: boolean;
    canClose: boolean;
  };
  criteria: ResolvedCriterion[];
  roster: { userId: string; name: string | null; submittedAt: string | null; isMe: boolean }[];
  own: { scores: Record<string, number>; comment: string | null; submittedAt: string | null } | null;
  revealed: boolean;
  scorecards: { authorId: string; authorName: string | null; scores: Record<string, number>; comment: string | null }[];
  divergence: CriterionDivergence[];
  average: number | null;
}

export function InterviewPanelView({ panelId }: { panelId: string }) {
  const t = useT();
  const locale = useLocale();
  const criterionLabel = useCriterionLabel();
  const [data, setData] = useState<PanelData | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/interview-panels/${panelId}`);
    if (!res.ok) return;
    const d: PanelData = await res.json();
    setData(d);
    if (d.own) {
      setScores(d.own.scores ?? {});
      setComment(d.own.comment ?? '');
    }
  }, [panelId]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async (submit: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/interview-panels/${panelId}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores, comment, submit }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.details?.formErrors?.[0] || body.error || 'Failed');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
      setConfirmSubmit(false);
    }
  };

  const closePanel = async () => {
    setBusy(true);
    try {
      await fetch(`/api/interview-panels/${panelId}/close`, { method: 'POST' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const { panel, criteria, roster, own, revealed } = data;
  const isMember = roster.some((r) => r.isMe);
  const submitted = !!own?.submittedAt;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {panel.title || t.interviewPanel.title} ·{' '}
          {panel.blind ? (
            <span data-testid="blind-subject">
              {t.interviewPanel.blindLabelPrefix} #{panel.blindLabel}
            </span>
          ) : (
            panel.subjectName
          )}
        </h1>
        {panel.scheduledAt && <p className="text-gray-500 mt-1">{formatDateTime(panel.scheduledAt, locale)}</p>}
        {panel.blind && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 px-3 py-2.5">
            <UserRoundX className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-xs font-semibold text-indigo-800 dark:text-indigo-200">{t.interviewPanel.blindTitle}</p>
              <p className="text-sm text-indigo-900 dark:text-indigo-100 mt-0.5">{t.interviewPanel.blindHintCandidate}</p>
            </div>
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{t.interviewPanel.interviewers}</CardTitle>
            <Badge variant={panel.complete ? 'success' : 'default'} data-testid="panel-state">
              {panel.closedAt ? t.interviewPanel.closed : panel.complete ? t.interviewPanel.complete : t.interviewPanel.waiting}
            </Badge>
          </div>
        </CardHeader>
        {/* Who has scored is not a score — the panel cannot know when it is done
            without it, and it is the only thing shown before the reveal. */}
        <ul className="space-y-1.5" data-testid="panel-roster">
          {roster.map((r) => (
            <li key={r.userId} className="flex items-center gap-2 text-sm">
              {r.submittedAt ? (
                <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
              ) : (
                <Circle className="h-4 w-4 text-gray-300 flex-shrink-0" />
              )}
              <span className={r.submittedAt ? 'text-gray-800 dark:text-gray-200' : 'text-gray-400'}>{r.name}</span>
            </li>
          ))}
        </ul>
        {panel.canClose && (
          <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-3">
            <Button size="sm" variant="secondary" loading={busy} onClick={closePanel} data-testid="panel-close">
              {t.interviewPanel.close}
            </Button>
            <p className="mt-2 text-xs text-gray-500">{t.interviewPanel.closeHint}</p>
          </div>
        )}
      </Card>

      {isMember && (
        <Card>
          <CardHeader>
            <CardTitle>{t.interviewPanel.yourScorecard}</CardTitle>
          </CardHeader>
          <p className="text-sm text-gray-500 mb-4">
            {submitted ? t.interviewPanel.submittedHint : t.interviewPanel.blindHint}
          </p>
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {criteria.map((c) => (
              <label key={c.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-700 dark:text-gray-300">{criterionLabel(c)}</span>
                <select
                  value={scores[c.key] ?? ''}
                  disabled={submitted || busy}
                  data-testid={`score-${c.key}`}
                  onChange={(e) => setScores({ ...scores, [c.key]: Number(e.target.value) })}
                  className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm disabled:opacity-60"
                >
                  <option value="">–</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-3">
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              maxLength={2000}
              disabled={submitted || busy}
              placeholder={t.interviewPanel.comment}
              showCounter
            />
          </div>
          {!submitted && (
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="secondary" loading={busy} onClick={() => save(false)} data-testid="save-draft">
                {t.interviewPanel.saveDraft}
              </Button>
              <Button
                size="sm"
                loading={busy}
                disabled={Object.keys(scores).length === 0}
                onClick={() => setConfirmSubmit(true)}
                data-testid="submit-scores"
              >
                {t.interviewPanel.submitScores}
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t.interviewPanel.calibration}</CardTitle>
        </CardHeader>
        {!revealed ? (
          <div className="flex items-start gap-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5" data-testid="calibration-locked">
            <Lock className="h-4 w-4 text-gray-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {!panel.complete
                ? t.interviewPanel.hiddenUntilComplete
                : t.interviewPanel.hiddenUntilYouSubmit}
            </p>
          </div>
        ) : (
          <div data-testid="calibration">
            <p className="text-sm text-gray-500 mb-3">
              {t.interviewPanel.calibrationHint.replace('{n}', String(DIVERGENCE_THRESHOLD))}
            </p>
            {data.average !== null && (
              <p className="text-sm mb-4">
                <span className="text-gray-500">{t.interviewPanel.panelAverage}:</span>{' '}
                <strong className="text-gray-900 dark:text-gray-100">{data.average}/5</strong>
              </p>
            )}
            {data.divergence.every((d) => !d.flagged) && (
              <p className="text-sm text-green-700 dark:text-green-400 mb-3">{t.interviewPanel.agreed}</p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1.5 pr-3"> </th>
                    {data.scorecards.map((s) => (
                      <th key={s.authorId} className="py-1.5 pr-3 font-medium">{s.authorName}</th>
                    ))}
                    <th className="py-1.5"> </th>
                  </tr>
                </thead>
                <tbody>
                  {criteria.map((c) => {
                    const d = data.divergence.find((x) => x.key === c.key);
                    return (
                      <tr key={c.key} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="py-1.5 pr-3 text-gray-700 dark:text-gray-300">{criterionLabel(c)}</td>
                        {data.scorecards.map((s) => (
                          <td key={s.authorId} className="py-1.5 pr-3 text-gray-900 dark:text-gray-100">
                            {typeof s.scores?.[c.key] === 'number' ? `${s.scores[c.key]}/5` : '–'}
                          </td>
                        ))}
                        <td className="py-1.5">
                          {d?.flagged && (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
                              data-testid={`divergence-${c.key}`}
                            >
                              <TriangleAlert className="h-3.5 w-3.5" />
                              {t.interviewPanel.spread.replace('{n}', String(d.spread))}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data.scorecards.some((s) => s.comment) && (
              <div className="mt-4 space-y-3">
                {data.scorecards
                  .filter((s) => s.comment)
                  .map((s) => (
                    <div key={s.authorId} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
                      <p className="text-xs font-medium text-gray-600 dark:text-gray-400">{s.authorName}</p>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 whitespace-pre-wrap">{s.comment}</p>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmSubmit}
        message={t.interviewPanel.confirmSubmit}
        confirmLabel={t.interviewPanel.submitScores}
        cancelLabel={t.common.cancel}
        loading={busy}
        onConfirm={() => save(true)}
        onCancel={() => setConfirmSubmit(false)}
      />
    </div>
  );
}
