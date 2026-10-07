'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { Archive, Check, Circle, Lock, Pencil, Trash2, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { TEXT_LIMITS } from '@/lib/textLimits';
import {
  DEFAULT_GOAL_VISIBILITY,
  GOAL_PROGRESS_MAX,
  GOAL_PROGRESS_MIN,
  GOAL_VISIBILITIES,
  type GoalVisibility,
} from '@/lib/goalVisibilityRule';

const ARCHIVE_PAGE_SIZE = 10;

interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: 'OPEN' | 'DONE';
  dueDate: string | null;
  createdAt: string;
  createdByRole: string | null;
  // #1858
  successCriteria: string | null;
  targetDate: string | null;
  progress: number | null;
  visibility: string;
}

/** The optional depth of a goal (#1858), shared by the add form and the inline editor. */
interface GoalDetails {
  successCriteria: string;
  targetDate: string;
  progress: string;
  visibility: GoalVisibility;
}

const EMPTY_DETAILS: GoalDetails = { successCriteria: '', targetDate: '', progress: '', visibility: DEFAULT_GOAL_VISIBILITY };

function detailsOf(g: Goal): GoalDetails {
  return {
    successCriteria: g.successCriteria ?? '',
    targetDate: g.targetDate ? g.targetDate.slice(0, 10) : '',
    progress: g.progress === null ? '' : String(g.progress),
    visibility: (GOAL_VISIBILITIES as readonly string[]).includes(g.visibility) ? (g.visibility as GoalVisibility) : DEFAULT_GOAL_VISIBILITY,
  };
}

/** '' → null, otherwise a whole number inside the 0–100 range. */
function parseProgress(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(GOAL_PROGRESS_MAX, Math.max(GOAL_PROGRESS_MIN, n));
}

// Goal setting + tracking for a mentorship relation. Read-only viewers (e.g. a
// company observer) only see progress; participants can add/toggle/remove.
// The sharing scope is rendered here but ENFORCED in /api/goals (#1858): a
// goal the viewer may not see never reaches this component.
export function GoalsPanel({ relationId, readOnly = false }: { relationId: string; readOnly?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const criteriaId = useId();
  const editCriteriaId = useId();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [details, setDetails] = useState<GoalDetails>(EMPTY_DETAILS);
  const [showDetails, setShowDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [showArchive, setShowArchive] = useState(false);
  const [showAllArchived, setShowAllArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editDetails, setEditDetails] = useState<GoalDetails>(EMPTY_DETAILS);
  const [editSaving, setEditSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/goals?relationId=${relationId}`);
    if (res.ok) setGoals((await res.json()).goals ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const visibilityOptions = [
    { value: 'PAIR', label: t.goals.visibilityPair },
    { value: 'PROGRAM', label: t.goals.visibilityProgram },
    { value: 'PRIVATE', label: t.goals.visibilityPrivate },
  ];

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const progress = parseProgress(details.progress);
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relationId,
          title,
          dueDate: dueDate || undefined,
          successCriteria: details.successCriteria.trim() || undefined,
          targetDate: details.targetDate || undefined,
          progress: progress === null ? undefined : progress,
          visibility: details.visibility,
        }),
      });
      if (res.ok) { setTitle(''); setDueDate(''); setDetails(EMPTY_DETAILS); await load(); }
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (g: Goal) => {
    await fetch(`/api/goals/${g.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: g.status === 'DONE' ? 'OPEN' : 'DONE' }),
    });
    await load();
  };

  const remove = (g: Goal) => setPendingDelete({ id: g.id, title: g.title });

  const confirmRemove = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await fetch(`/api/goals/${pendingDelete.id}`, { method: 'DELETE' });
      await load();
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const startEdit = (g: Goal) => {
    setEditingId(g.id);
    setEditTitle(g.title);
    setEditDueDate(g.dueDate ? g.dueDate.slice(0, 10) : '');
    setEditDetails(detailsOf(g));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
    setEditDueDate('');
    setEditDetails(EMPTY_DETAILS);
  };

  const saveEdit = async (g: Goal) => {
    if (!editTitle.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/goals/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          dueDate: editDueDate || null,
          successCriteria: editDetails.successCriteria.trim() || null,
          targetDate: editDetails.targetDate || null,
          progress: parseProgress(editDetails.progress),
          // Only the author may change the scope (the route refuses anyone
          // else); sending it unchanged is a no-op for everybody.
          visibility: editDetails.visibility,
        }),
      });
      if (res.ok) {
        cancelEdit();
        await load();
      }
    } finally {
      setEditSaving(false);
    }
  };

  const sortGoals = (items: Goal[]) => [...items].sort((a, b) => {
    const difference = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return sortOrder === 'oldest' ? difference : -difference;
  });
  const activeGoals = sortGoals(goals.filter((g) => g.status === 'OPEN'));
  const archivedGoals = sortGoals(goals.filter((g) => g.status === 'DONE'));

  // The optional fields, as one block the add form and the editor both show.
  const detailFields = (
    value: GoalDetails,
    onChange: (next: GoalDetails) => void,
    idPrefix: string,
    testPrefix: string,
  ) => (
    <div className="w-full space-y-2" data-testid={`${testPrefix}-details`}>
      <div>
        <label htmlFor={`${idPrefix}-criteria`} className="mb-1 block text-sm font-medium text-gray-700">
          {t.goals.successCriteria}
        </label>
        <Textarea
          id={`${idPrefix}-criteria`}
          rows={2}
          value={value.successCriteria}
          placeholder={t.goals.successCriteriaHint}
          maxLength={TEXT_LIMITS.goalSuccessCriteria}
          showCounter
          onChange={(e) => onChange({ ...value, successCriteria: e.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Input
            id={`${idPrefix}-target`}
            label={t.goals.targetDate}
            type="date"
            value={value.targetDate}
            onChange={(e) => onChange({ ...value, targetDate: e.target.value })}
          />
        </div>
        <div className="w-28">
          <Input
            id={`${idPrefix}-progress`}
            label={t.goals.progress}
            type="number"
            inputMode="numeric"
            min={GOAL_PROGRESS_MIN}
            max={GOAL_PROGRESS_MAX}
            step={5}
            value={value.progress}
            onChange={(e) => onChange({ ...value, progress: e.target.value })}
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <Select
            id={`${idPrefix}-visibility`}
            label={t.goals.visibility}
            value={value.visibility}
            options={visibilityOptions}
            onChange={(e) => onChange({ ...value, visibility: e.target.value as GoalVisibility })}
          />
        </div>
      </div>
    </div>
  );

  const goalRow = (g: Goal, editable: boolean) => (
    <div key={g.id} data-testid={`goal-${g.id}`} data-visibility={g.visibility} className="flex items-start gap-2 text-sm">
      <button
        onClick={() => !readOnly && toggle(g)}
        disabled={readOnly || editingId === g.id}
        aria-label={g.status === 'DONE' ? t.goals.markOpen : t.goals.markDone}
        className={`mt-0.5 ${g.status === 'DONE' ? 'text-green-600' : 'text-gray-300 hover:text-gray-500'}`}
      >
        {g.status === 'DONE' ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
      </button>
      <span className="flex-1 min-w-0">
        {editingId === g.id ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[160px] flex-1">
                <Input
                  label={t.goals.goalTitle}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="w-40">
                <Input
                  label={t.goals.dueDate}
                  type="date"
                  value={editDueDate}
                  onChange={(e) => setEditDueDate(e.target.value)}
                />
              </div>
            </div>
            {detailFields(editDetails, setEditDetails, `${editCriteriaId}-${g.id}`, 'edit-goal')}
            <div className="flex gap-2">
              <Button type="button" size="sm" loading={editSaving} disabled={!editTitle.trim()} onClick={() => saveEdit(g)}>
                {t.common.save}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={editSaving} onClick={cancelEdit}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <span className="flex flex-wrap items-center gap-x-2">
              <span className={g.status === 'DONE' ? 'line-through text-gray-400' : 'text-gray-800'}>{g.title}</span>
              {g.visibility === 'PRIVATE' && (
                <span
                  data-testid="goal-visibility-badge"
                  className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600"
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  {t.goals.privateBadge}
                </span>
              )}
              {g.visibility === 'PROGRAM' && (
                <span
                  data-testid="goal-visibility-badge"
                  className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700"
                >
                  <Users className="h-3 w-3" aria-hidden="true" />
                  {t.goals.programBadge}
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-gray-400">
              {g.createdByRole === 'MENTOR' && <span>{t.goals.byMentor}</span>}
              {g.createdByRole === 'MENTEE' && <span>{t.goals.byMentee}</span>}
              <span>· <RelativeTime date={g.createdAt} /></span>
              {g.targetDate && <span data-testid="goal-target-date">· {t.goals.targetDate}: {formatDate(g.targetDate, locale)}</span>}
              {g.dueDate && <span>· {t.goals.dueDate}: {formatDate(g.dueDate, locale)}</span>}
            </span>
            {g.successCriteria && (
              <p data-testid="goal-success-criteria" className="mt-1 whitespace-pre-line text-xs text-gray-600">
                <span className="font-medium text-gray-500">{t.goals.successCriteria}: </span>
                {g.successCriteria}
              </p>
            )}
            {g.progress !== null && (
              <div className="mt-1.5 flex items-center gap-2">
                <div
                  role="progressbar"
                  aria-label={t.goals.progress}
                  aria-valuemin={GOAL_PROGRESS_MIN}
                  aria-valuemax={GOAL_PROGRESS_MAX}
                  aria-valuenow={g.progress}
                  aria-valuetext={t.goals.progressPercent.replace('{n}', String(g.progress))}
                  data-testid="goal-progress"
                  className="h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-gray-100"
                >
                  <div className="h-full rounded-full bg-emerald-600" style={{ width: `${g.progress}%` }} />
                </div>
                <span className="text-[11px] text-gray-500" data-testid="goal-progress-value">
                  {t.goals.progressPercent.replace('{n}', String(g.progress))}
                </span>
              </div>
            )}
          </>
        )}
      </span>
      {!readOnly && editingId !== g.id && (
        <>
          {editable && (
            <button type="button" onClick={() => startEdit(g)} aria-label={t.common.edit} className="mt-0.5 text-gray-300 hover:text-blue-600">
              <Pencil className="h-4 w-4" />
            </button>
          )}
        <button onClick={() => remove(g)} aria-label={t.common.delete} className="mt-0.5 text-gray-300 hover:text-red-600">
          <Trash2 className="h-4 w-4" />
        </button>
        </>
      )}
    </div>
  );

  return (
    <>
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t.goals.title}</CardTitle>
          <div className="flex items-center gap-2">
            <div className="w-36">
              <Select
                aria-label={t.goals.sortBy}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest')}
                className="py-1.5 pl-3 pr-8"
                options={[
                  { value: 'newest', label: t.goals.newestFirst },
                  { value: 'oldest', label: t.goals.oldestFirst },
                ]}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant={showArchive ? 'secondary' : 'outline'}
              aria-expanded={showArchive}
              onClick={() => {
                setShowArchive((shown) => !shown);
                setShowAllArchived(false);
              }}
            >
              <Archive className="h-4 w-4" />
              {t.goals.archive}
            </Button>
          </div>
        </div>
      </CardHeader>

      {goals.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-4 text-xs text-gray-500" data-testid="goals-counters">
          <span data-testid="goals-active-count">{t.goals.activeCount}: {activeGoals.length}</span>
          <span data-testid="goals-completed-count">{t.goals.completedCount}: {archivedGoals.length}</span>
        </div>
      )}

      {activeGoals.length === 0 ? (
        <p className="text-sm text-gray-400 mb-4">{goals.length === 0 ? t.goals.none : t.goals.noneActive}</p>
      ) : (
        <div data-testid="active-goals" className="space-y-2 mb-4">
          {activeGoals.map((g) => goalRow(g, true))}
        </div>
      )}

      {!readOnly && (
        <form onSubmit={add} className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[160px]"><Input label={t.goals.newGoal} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="w-40"><Input label={t.goals.dueDate} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
            <Button type="submit" size="sm" loading={saving} disabled={!title.trim()}>{t.goals.add}</Button>
          </div>
          <button
            type="button"
            className="text-xs text-blue-600 hover:underline"
            aria-expanded={showDetails}
            aria-controls={`${criteriaId}-details`}
            onClick={() => setShowDetails((shown) => !shown)}
          >
            {showDetails ? t.goals.fewerFields : t.goals.moreFields}
          </button>
          {showDetails && (
            <div id={`${criteriaId}-details`}>
              {detailFields(details, setDetails, criteriaId, 'new-goal')}
            </div>
          )}
        </form>
      )}

      {showArchive && (
        <section className="mt-6 border-t border-gray-200 pt-4" data-testid="goals-archive">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">{t.goals.archive}</h3>
          {archivedGoals.length === 0 ? (
            <p className="text-sm text-gray-400">{t.goals.noneArchived}</p>
          ) : (
            <>
              <div className="space-y-2">
                {(showAllArchived ? archivedGoals : archivedGoals.slice(0, ARCHIVE_PAGE_SIZE)).map((g) => goalRow(g, false))}
              </div>
              {archivedGoals.length > ARCHIVE_PAGE_SIZE && (
                <div className="mt-3">
                  <Button type="button" size="sm" variant="outline" onClick={() => setShowAllArchived((shown) => !shown)}>
                    {showAllArchived ? t.goals.showLess : t.goals.showAll}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </Card>
    <ConfirmDialog
      open={pendingDelete !== null}
      message={pendingDelete ? t.goals.confirmDelete.replace('{title}', pendingDelete.title) : ''}
      cancelLabel={t.common.cancel}
      confirmLabel={t.common.delete}
      variant="danger"
      loading={deleting}
      onConfirm={confirmRemove}
      onCancel={() => setPendingDelete(null)}
    />
    </>
  );
}
