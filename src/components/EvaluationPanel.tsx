'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EVAL_CRITERIA, MENTOR_CRITERIA } from '@/lib/evaluation';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';

interface Evaluation {
  id: string;
  type: 'INTERIM' | 'FINAL';
  scores: Record<string, number>;
  comment: string | null;
  direction: 'MENTOR_ON_MENTEE' | 'MENTEE_ON_MENTOR';
  createdAt: string;
}

// Shows a relation's evaluation history. When not read-only, the current user
// can add one. `audience='MENTOR'` means the author evaluates the *mentor*
// (mentee → mentor); otherwise the mentee is being evaluated.
export function EvaluationPanel({
  relationId,
  readOnly = false,
  audience = 'MENTEE',
}: {
  relationId: string;
  readOnly?: boolean;
  audience?: 'MENTEE' | 'MENTOR';
}) {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<Evaluation[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [type, setType] = useState<'INTERIM' | 'FINAL'>('INTERIM');
  const [saving, setSaving] = useState(false);

  const formCriteria = audience === 'MENTOR' ? MENTOR_CRITERIA : EVAL_CRITERIA;

  const load = useCallback(async () => {
    const res = await fetch(`/api/evaluations?relationId=${relationId}`);
    if (res.ok) setItems((await res.json()).evaluations ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, scores, comment, type }),
      });
      if (res.ok) { setScores({}); setComment(''); setType('INTERIM'); await load(); }
    } finally {
      setSaving(false);
    }
  };

  const label = (c: string) => (t.evaluation.criteria as Record<string, string>)[c] ?? c;
  const typeLabel = (ty: string) => (ty === 'FINAL' ? t.evaluation.final : t.evaluation.interim);

  return (
    <Card>
      <CardHeader><CardTitle>{audience === 'MENTOR' ? t.evaluation.titleMentor : t.evaluation.title}</CardTitle></CardHeader>

      {!readOnly && (
        <form onSubmit={submit} className="space-y-3 mb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {formCriteria.map((c) => (
              <label key={c} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-700">{label(c)}</span>
                <select
                  value={scores[c] ?? ''}
                  onChange={(e) => setScores({ ...scores, [c]: Number(e.target.value) })}
                  className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="">–</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700">{t.evaluation.type}:</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'INTERIM' | 'FINAL')}
              className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="INTERIM">{t.evaluation.interim}</option>
              <option value="FINAL">{t.evaluation.final}</option>
            </select>
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder={t.evaluation.comment}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <Button type="submit" size="sm" loading={saving} disabled={Object.keys(scores).length === 0}>
            {t.evaluation.add}
          </Button>
        </form>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-gray-400">{t.evaluation.none}</p>
      ) : (
        <div className="space-y-3">
          {(() => {
            // Average score per evaluation (oldest→newest) for a quick trend.
            const avg = (ev: Evaluation) => {
              const vals = Object.values(ev.scores).filter((n) => typeof n === 'number');
              return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
            };
            const onMentee = items.filter((e) => e.direction === 'MENTOR_ON_MENTEE');
            if (onMentee.length === 0) return null;
            const series = [...onMentee].reverse().map(avg);
            const latest = series[series.length - 1];
            return (
              <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-600">{t.evaluation.averageScore}</span>
                  <span className="text-sm font-semibold text-gray-900">{latest.toFixed(1)}/5</span>
                </div>
                <div className="flex items-end gap-1 h-10">
                  {series.map((v, i) => (
                    <div key={i} className="flex-1 bg-blue-400 rounded-t" style={{ height: `${(v / 5) * 100}%` }} title={`${v.toFixed(1)}/5`} />
                  ))}
                </div>
              </div>
            );
          })()}
          {items.map((ev) => {
            const crit = ev.direction === 'MENTEE_ON_MENTOR' ? MENTOR_CRITERIA : EVAL_CRITERIA;
            return (
              <div key={ev.id} className="rounded-lg border border-gray-100 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Badge variant={ev.type === 'FINAL' ? 'success' : 'info'}>{typeLabel(ev.type)}</Badge>
                  {ev.direction === 'MENTEE_ON_MENTOR' && <Badge variant="purple">{t.evaluation.onMentor}</Badge>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {crit.filter((c) => ev.scores[c]).map((c) => (
                    <span key={c} className="text-gray-700">{label(c)}: <strong>{ev.scores[c]}/5</strong></span>
                  ))}
                </div>
                {ev.comment && <p className="text-sm text-gray-600 mt-1.5 whitespace-pre-wrap">{ev.comment}</p>}
                <p className="text-xs text-gray-400 mt-1">{relativeTime(ev.createdAt, locale)}</p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
