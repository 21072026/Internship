'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  EVALUATION_EDIT_WINDOW_DAYS,
  criteriaForScores,
  defaultCriteria,
  type ResolvedCriterion,
} from '@/lib/evaluation';
import { useCriteria, useCriterionLabel } from '@/lib/evaluationCriteriaClient';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';

interface Evaluation {
  id: string;
  type: 'INTERIM' | 'FINAL';
  scores: Record<string, number>;
  comment: string | null;
  direction: 'MENTOR_ON_MENTEE' | 'MENTEE_ON_MENTOR';
  createdAt: string;
  // When this record was corrected inside its window (#1893); null unless a
  // PATCH actually rewrote it, so no other write can mislabel it.
  correctedAt?: string | null;
  canDelete?: boolean;
  // Offered only inside the correction window; the PATCH route decides.
  canEdit?: boolean;
  // The rubric this was scored against (#822); null means the built-ins.
  templateId?: string | null;
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
  // The criteria of every rubric these evaluations were written against —
  // retired ones included, so an old record keeps its own labels (#822).
  const [templates, setTemplates] = useState<Record<string, ResolvedCriterion[]>>({});
  const [scores, setScores] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [type, setType] = useState<'INTERIM' | 'FINAL'>('INTERIM');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Correcting one existing record in place (#1893).
  const [editId, setEditId] = useState<string | null>(null);
  const [editScores, setEditScores] = useState<Record<string, number>>({});
  const [editComment, setEditComment] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // What the form asks for: the tenant's own framework when it defined one,
  // otherwise the built-in four.
  const formCriteria = useCriteria(audience === 'MENTOR' ? 'MENTOR' : 'MENTEE');
  const criterionLabel = useCriterionLabel();

  const load = useCallback(async () => {
    const res = await fetch(`/api/evaluations?relationId=${relationId}`);
    if (res.ok) {
      const data = await res.json();
      setItems(data.evaluations ?? []);
      setTemplates(data.templates ?? {});
    }
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, scores, comment, type }),
      });
      if (res.ok) { setScores({}); setComment(''); setType('INTERIM'); await load(); }
      else setError(t.common.error);
    } catch (err) {
      console.error('[evaluations] submit failed', err);
      setError(t.common.error);
    } finally {
      setSaving(false);
    }
  };

  // Picking the blank option clears the criterion instead of sending 0: the
  // route validates 1..5, so a 0 would come back as an opaque 400.
  const withScore = (current: Record<string, number>, key: string, raw: string) => {
    const next = { ...current };
    if (raw === '') delete next[key];
    else next[key] = Number(raw);
    return next;
  };

  // Correcting a mistyped score rather than deleting and rewriting the record.
  // The route re-checks author, window and testimonial state; opening the form
  // here is not the permission.
  const startEdit = (ev: Evaluation) => {
    setEditId(ev.id);
    setEditScores({ ...ev.scores });
    setEditComment(ev.comment ?? '');
    setError(null);
  };

  const saveEdit = async () => {
    if (!editId || savingEdit) return;
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`/api/evaluations/${editId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores: editScores, comment: editComment }),
      });
      if (res.ok) { setEditId(null); await load(); }
      else {
        const body = await res.json().catch(() => ({}));
        setError(
          body.code === 'edit_window_closed'
            ? t.evaluation.editWindowClosed.replace('{n}', String(EVALUATION_EDIT_WINDOW_DAYS))
            : t.common.error
        );
      }
    } catch (err) {
      console.error('[evaluations] edit failed', err);
      setError(t.common.error);
    } finally {
      setSavingEdit(false);
    }
  };

  // Removing an evaluation recorded by mistake. The server re-checks that the
  // caller is its author (or an admin); this only hides the button.
  const remove = (id: string) => setDeleteId(id);

  const confirmRemove = async () => {
    if (!deleteId || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/evaluations/${deleteId}`, { method: 'DELETE' });
      if (res.ok) await load();
      else setError(t.common.error);
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  };

  // A record's own rubric: the template it was stamped with, else the built-ins
  // for its direction.
  const rubricFor = (ev: Evaluation): ResolvedCriterion[] =>
    (ev.templateId && templates[ev.templateId]) ||
    defaultCriteria(ev.direction === 'MENTEE_ON_MENTOR' ? 'MENTOR' : 'MENTEE');
  const typeLabel = (ty: string) => (ty === 'FINAL' ? t.evaluation.final : t.evaluation.interim);

  // What the correction form asks for: the whole rubric of the record's own era,
  // not just the criteria that happen to carry a score — a criterion left empty
  // by mistake is exactly the kind of thing being corrected here — plus any
  // orphaned key, so a correction never silently drops one.
  const editableCriteria = (ev: Evaluation): ResolvedCriterion[] => {
    const own = rubricFor(ev);
    const orphans = criteriaForScores(own, ev.scores).filter((c) => !own.some((o) => o.key === c.key));
    return [...own, ...orphans];
  };

  return (
    <>
    <Card>
      <CardHeader><CardTitle>{audience === 'MENTOR' ? t.evaluation.titleMentor : t.evaluation.title}</CardTitle></CardHeader>

      {!readOnly && (
        <form onSubmit={submit} className="space-y-3 mb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {formCriteria.map((c) => (
              <label key={c.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-700">{criterionLabel(c)}</span>
                <select
                  value={scores[c.key] ?? ''}
                  onChange={(e) => setScores({ ...scores, [c.key]: Number(e.target.value) })}
                  className="min-h-11 min-w-11 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="">–</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <span className="text-sm text-gray-700">{t.evaluation.type}:</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'INTERIM' | 'FINAL')}
              className="min-h-11 min-w-11 rounded-lg border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="INTERIM">{t.evaluation.interim}</option>
              <option value="FINAL">{t.evaluation.final}</option>
            </select>
          </label>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder={t.evaluation.comment}
            showCounter
          />
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
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
            // Scores whose criterion no longer exists anywhere are still shown
            // (by key) rather than silently dropped.
            const crit = criteriaForScores(rubricFor(ev), ev.scores);
            return (
              <div key={ev.id} className="rounded-lg border border-gray-100 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Badge variant={ev.type === 'FINAL' ? 'success' : 'info'}>{typeLabel(ev.type)}</Badge>
                  {ev.direction === 'MENTEE_ON_MENTOR' && <Badge variant="purple">{t.evaluation.onMentor}</Badge>}
                  {ev.canEdit && editId !== ev.id && (
                    <button
                      type="button"
                      onClick={() => startEdit(ev)}
                      aria-label={t.evaluation.edit}
                      title={t.evaluation.edit}
                      data-testid="evaluation-edit"
                      className="ml-auto text-gray-300 hover:text-blue-600 dark:text-gray-600 dark:hover:text-blue-400"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  {ev.canDelete && (
                    <button
                      type="button"
                      onClick={() => remove(ev.id)}
                      aria-label={t.evaluation.delete}
                      title={t.evaluation.delete}
                      data-testid="evaluation-delete"
                      className={`${ev.canEdit && editId !== ev.id ? '' : 'ml-auto '}text-gray-300 hover:text-red-600 dark:text-gray-600 dark:hover:text-red-400`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {editId === ev.id ? (
                  <div className="space-y-3">
                    {/* The record's own rubric, so a retired criterion stays
                        correctable instead of vanishing on save (#822). */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {editableCriteria(ev).map((c) => (
                        <label key={c.key} className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-gray-700">{criterionLabel(c)}</span>
                          <select
                            value={editScores[c.key] ?? ''}
                            data-testid={`evaluation-edit-score-${c.key}`}
                            onChange={(e) => setEditScores(withScore(editScores, c.key, e.target.value))}
                            className="min-h-11 min-w-11 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
                          >
                            <option value="">–</option>
                            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                    <Textarea
                      value={editComment}
                      onChange={(e) => setEditComment(e.target.value)}
                      rows={2}
                      maxLength={2000}
                      placeholder={t.evaluation.comment}
                      showCounter
                    />
                    <p className="text-xs text-gray-500">
                      {t.evaluation.editHint.replace('{n}', String(EVALUATION_EDIT_WINDOW_DAYS))}
                    </p>
                    {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
                    <div className="flex items-center gap-2">
                      <Button type="button" size="sm" loading={savingEdit} onClick={saveEdit} data-testid="evaluation-edit-save">
                        {t.evaluation.saveEdit}
                      </Button>
                      <Button type="button" size="sm" variant="secondary" onClick={() => setEditId(null)}>
                        {t.common.cancel}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      {crit.map((c) => (
                        <span key={c.key} className="text-gray-700">{criterionLabel(c)}: <strong>{ev.scores[c.key]}/5</strong></span>
                      ))}
                    </div>
                    {ev.comment && <p className="text-sm text-gray-600 mt-1.5 whitespace-pre-wrap">{ev.comment}</p>}
                    <p className="text-xs text-gray-400 mt-1">
                      {relativeTime(ev.createdAt, locale)}
                      {ev.correctedAt && ` · ${t.evaluation.editedAt.replace('{when}', relativeTime(ev.correctedAt, locale))}`}
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
    <ConfirmDialog
      open={deleteId !== null}
      message={t.evaluation.confirmDelete}
      cancelLabel={t.common.cancel}
      confirmLabel={t.evaluation.delete}
      variant="danger"
      loading={deleting}
      onConfirm={confirmRemove}
      onCancel={() => setDeleteId(null)}
    />
    </>
  );
}
