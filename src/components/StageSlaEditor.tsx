'use client';

// Per-stage service levels (#817).
//
// The deadline field, the overdue column and the mentor reminder all existed
// before this — but the deadline had to be typed in per candidate, so in
// practice nothing was ever overdue. This is where an organisation states the
// rule once and every stage move applies it.

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Clock } from 'lucide-react';
import { useT } from '@/i18n/client';
import { DEFAULT_BOARD_WIP_LIMIT } from '@/lib/boardWip';

interface StageRow {
  key: string;
  label: string;
  isOffPath: boolean;
  isTerminal: boolean;
  days: number | null;
  // Board WIP limit for this stage (#1439): null = inherit the org-wide
  // number, 0 = never warn about this stage.
  wipLimit: number | null;
  // The ladder's second rung (#1722): days after the breach before the org's
  // administrators are told. null = only the mentor is reminded.
  escalateAfterDays: number | null;
  // In an override scope: the rung this row falls back to without its own (#3204).
  inheritedEscalateAfterDays?: number | null;
  // Override scopes (#1640): what applies here, and what would without this
  // scope's own row. Server-resolved — the precedence lives in stageSlaRule.ts.
  effective?: ResolvedSla | null;
  inherited?: ResolvedSla | null;
}

interface ResolvedSla {
  days: number;
  source: 'mentorCohort' | 'mentor' | 'cohort' | 'org';
}

interface Option {
  id: string;
  name: string;
}

export function StageSlaEditor() {
  const t = useT();
  const [rows, setRows] = useState<StageRow[]>([]);
  // The org-wide fallback, so an empty WIP box can show what it inherits
  // instead of looking unconfigured. null = the org switched warnings off.
  const [defaultWip, setDefaultWip] = useState<number | null>(DEFAULT_BOARD_WIP_LIMIT);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The scope being edited (#1640): both empty = the organisation's own rows.
  const [cohortId, setCohortId] = useState('');
  const [mentorId, setMentorId] = useState('');
  const [cohorts, setCohorts] = useState<Option[]>([]);
  const [mentors, setMentors] = useState<Option[]>([]);
  const isOverride = cohortId !== '' || mentorId !== '';

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (cohortId) qs.set('cohortId', cohortId);
    if (mentorId) qs.set('mentorId', mentorId);
    const query = qs.toString();
    const res = await fetch(`/api/admin/stage-sla${query ? `?${query}` : ''}`);
    if (res.ok) {
      const body = await res.json();
      setRows(body.stages ?? []);
      setDefaultWip(body.defaultWipLimit ?? null);
      setCohorts(body.cohorts ?? []);
      setMentors(body.mentors ?? []);
    }
  }, [cohortId, mentorId]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch('/api/admin/stage-sla', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cohortId: cohortId || null,
          mentorId: mentorId || null,
          slas: rows.map((r) => ({ stageKey: r.key, days: r.days, wipLimit: r.wipLimit, escalateAfterDays: r.escalateAfterDays })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.details?.formErrors?.[0] || body.error || 'Failed');
      setFlash(t.stageSla.saved);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const sourceLabel = (source: ResolvedSla['source']) =>
    ({
      org: t.stageSla.sourceOrg,
      cohort: t.stageSla.sourceCohort,
      mentor: t.stageSla.sourceMentor,
      mentorCohort: t.stageSla.sourceMentorCohort,
    })[source];

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-blue-600" />
          <CardTitle>{t.stageSla.title}</CardTitle>
        </div>
      </CardHeader>
      <p className="text-sm text-gray-500 mb-4">{t.stageSla.subtitle}</p>
      {(cohorts.length > 0 || mentors.length > 0) && (
        <div className="mb-4 flex flex-wrap items-end gap-3 text-sm" data-testid="stage-sla-scope">
          <span className="basis-full text-xs font-medium text-gray-600 dark:text-gray-400">{t.stageSla.scopeTitle}</span>
          {cohorts.length > 0 && (
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              {t.stageSla.scopeCohort}
              <select
                value={cohortId}
                onChange={(e) => setCohortId(e.target.value)}
                data-testid="stage-sla-cohort"
                className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
              >
                <option value="">{t.stageSla.allCohorts}</option>
                {cohorts.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}
          {mentors.length > 0 && (
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              {t.stageSla.scopeMentor}
              <select
                value={mentorId}
                onChange={(e) => setMentorId(e.target.value)}
                data-testid="stage-sla-mentor"
                className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
              >
                <option value="">{t.stageSla.allMentors}</option>
                {mentors.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          )}
          {isOverride && <p className="basis-full text-xs text-gray-500">{t.stageSla.overrideHint}</p>}
        </div>
      )}
      {flash && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{flash}</div>}
      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {/* Two numbers per stage since #1439 — the waiting rule and the board's
          column depth. Column headings rather than a unit label per input:
          with two boxes on a row, "Days" after the first one stopped saying
          which box it belonged to. */}
      <div className="flex items-center gap-3 text-xs text-gray-500 mb-1 px-1">
        <span className="flex-1" />
        <span className="w-20 sm:w-24">{t.stageSla.days}</span>
        <span className="w-20 sm:w-24">{t.stageSla.escalateAfter}</span>
        <span className="w-20 sm:w-24">{t.stageSla.wipLimit}</span>
      </div>
      <div className="space-y-2" data-testid="stage-sla-rows">
        {rows.map((r, i) => (
          /* Three number inputs (days, escalation, WIP — #1722) leave a phone's
             label ~50px, too narrow to say which stage it is: below sm the label
             takes its own line and the inputs wrap under it, right-aligned under
             their column headings (e2e/mobile-layout-coverage.spec.ts, the
             stage-SLA row case). w-20 there: "Eskalieren nach" overflowed w-16. */
          <div key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="basis-full sm:basis-auto flex-1 min-w-0 truncate text-gray-700 dark:text-gray-300">
              {r.label}
              {r.isOffPath && <span className="ml-2 text-xs text-gray-400">({t.stageSla.offPath})</span>}
              {isOverride && (r.effective || r.inherited) && (
                <span className="block text-xs text-gray-500" data-testid={`sla-effective-${r.key}`}>
                  {[
                    r.days != null && r.effective
                      ? t.stageSla.effective.replace('{scope}', sourceLabel(r.effective.source)).replace('{n}', String(r.effective.days))
                      : null,
                    r.inherited
                      ? t.stageSla.inheritedFrom.replace('{source}', sourceLabel(r.inherited.source)).replace('{n}', String(r.inherited.days))
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </span>
            <input
              type="number"
              min={0}
              max={365}
              value={r.days ?? ''}
              placeholder={isOverride && r.inherited ? t.stageSla.inherits.replace('{n}', String(r.inherited.days)) : t.stageSla.noRule}
              aria-label={`${r.label} — ${t.stageSla.days}`}
              data-testid={`sla-${r.key}`}
              onChange={(e) => {
                const v = e.target.value.trim();
                const days = v === '' ? null : Number(v);
                setRows((p) => p.map((row, j) => (j === i ? { ...row, days } : row)));
              }}
              className="ml-auto w-20 sm:w-24 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
            />
            <input
              type="number"
              min={0}
              max={365}
              value={r.escalateAfterDays ?? ''}
              placeholder={
                isOverride && r.inheritedEscalateAfterDays != null
                  ? t.stageSla.inherits.replace('{n}', String(r.inheritedEscalateAfterDays))
                  : t.stageSla.noRule
              }
              /* Escalation hangs off the service level: no days, no breach. */
              /* An override may carry its own rung or inherit one (#3204). */
              disabled={r.days == null || r.days <= 0}
              aria-label={`${r.label} — ${t.stageSla.escalateAfter}`}
              data-testid={`escalate-${r.key}`}
              onChange={(e) => {
                const v = e.target.value.trim();
                const escalateAfterDays = v === '' ? null : Number(v);
                setRows((p) => p.map((row, j) => (j === i ? { ...row, escalateAfterDays } : row)));
              }}
              className="w-20 sm:w-24 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm disabled:opacity-50"
            />
            <input
              type="number"
              min={0}
              max={9999}
              value={r.wipLimit ?? ''}
              /* The placeholder is what an empty box actually does: inherit the
                 org-wide number, or nothing at all when that is switched off. */
              placeholder={
                defaultWip == null
                  ? t.stageSla.wipLimitOff
                  : t.stageSla.wipLimitDefault.replace('{n}', String(defaultWip))
              }
              aria-label={`${r.label} — ${t.stageSla.wipLimit}`}
              data-testid={`wip-${r.key}`}
              disabled={isOverride}
              onChange={(e) => {
                const v = e.target.value.trim();
                const wipLimit = v === '' ? null : Number(v);
                setRows((p) => p.map((row, j) => (j === i ? { ...row, wipLimit } : row)));
              }}
              className="w-20 sm:w-24 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm disabled:opacity-50"
            />
          </div>
        ))}
      </div>

      <div className="mt-4">
        <Button size="sm" loading={saving} onClick={save} data-testid="stage-sla-save">
          {t.common.save}
        </Button>
      </div>
      <p className="mt-3 text-xs text-gray-500">{t.stageSla.calendarDays}</p>
      <p className="mt-1 text-xs text-gray-500">{t.stageSla.escalateHint}</p>
      <p className="mt-1 text-xs text-gray-500">{t.stageSla.wipLimitHint}</p>
      <p className="mt-1 text-xs text-gray-500">{t.stageSla.appliesOnMove}</p>
    </Card>
  );
}
