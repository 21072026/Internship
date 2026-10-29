'use client';

// The nudge rule editor (#1686): trigger (a non-stage event or the daily scan),
// the segment as allowlisted condition rows, delay, channel, the per-person
// limits and the message in EN/TR/DE. The vocabulary is ./rule.ts's own lists,
// so the editor cannot offer a field or an operator the server would refuse;
// the server re-validates every save anyway (parseNudgeRuleInput).
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { ConditionRow, defaultConditionValue, type ConditionFieldDef, type ConditionValue } from '@/components/admin/ConditionRow';
import { NUDGE_CHANNELS, NUDGE_EVENT_TRIGGERS, NUDGE_LOCALES, SEGMENT_FIELDS, missingLocales, type NudgeEventTrigger } from '@/lib/nudges/rule';

export interface NudgeOptions {
  stages: { key: string; label: string; guarded: boolean }[];
  cohorts: { id: string; name: string }[];
  tags: { id: string; name: string }[];
}

export interface NudgeDraft {
  name: string;
  enabled: boolean;
  trigger: { kind: 'scan' } | { kind: 'event'; event: NudgeEventTrigger };
  segment: { conditions: ConditionValue[] };
  delayMinutes: number;
  channel: (typeof NUDGE_CHANNELS)[number];
  subjectEn: string; subjectTr: string; subjectDe: string;
  bodyEn: string; bodyTr: string; bodyDe: string;
  maxPerUserPer30Days: number;
  cooldownDays: number;
}

export const EMPTY_NUDGE: NudgeDraft = {
  name: '', enabled: false, trigger: { kind: 'scan' }, segment: { conditions: [] }, delayMinutes: 0, channel: 'EMAIL',
  subjectEn: '', subjectTr: '', subjectDe: '', bodyEn: '', bodyTr: '', bodyDe: '', maxPerUserPer30Days: 2, cooldownDays: 7,
};

const EVENT_LABEL_KEY: Record<NudgeEventTrigger, 'evMentorshipCreated' | 'evRelationCreated' | 'evInteractionLogged' | 'evEvaluationAdded' | 'evMeetingCompleted' | 'evLifecycleChanged'> = {
  'mentorship.created': 'evMentorshipCreated',
  'relation.created': 'evRelationCreated',
  'interaction.logged': 'evInteractionLogged',
  'evaluation.added': 'evEvaluationAdded',
  'meeting.completed': 'evMeetingCompleted',
  'mentorship.lifecycle_changed': 'evLifecycleChanged',
};

export function useEventLabel() {
  const t = useT();
  return (event: string) => (event in EVENT_LABEL_KEY ? t.nudges[EVENT_LABEL_KEY[event as NudgeEventTrigger]] : event);
}

const input = 'w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
const LANG_SUFFIX = { en: 'En', tr: 'Tr', de: 'De' } as const;

export function NudgeEditor({
  initial,
  options,
  ruleId,
  onSaved,
}: {
  initial: NudgeDraft;
  options: NudgeOptions;
  ruleId?: string;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  const eventLabel = useEventLabel();
  const [draft, setDraft] = useState<NudgeDraft>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const set = <K extends keyof NudgeDraft>(k: K, v: NudgeDraft[K]) => { setDraft((d) => ({ ...d, [k]: v })); setSavedNote(false); };

  const fields: ConditionFieldDef[] = useMemo(() => {
    const ops = (names: readonly string[]) =>
      names.map((o) => ({ value: o, label: t.nudges[`op${o[0].toUpperCase()}${o.slice(1)}` as 'opEq'] }));
    return [
      { value: 'role', label: t.nudges.fieldRole, ops: ops(SEGMENT_FIELDS.role.ops), input: 'select', options: [{ value: 'MENTEE', label: t.nudges.roleMENTEE }, { value: 'MENTOR', label: t.nudges.roleMENTOR }] },
      {
        value: 'stage', label: t.nudges.fieldStage, ops: ops(SEGMENT_FIELDS.stage.ops), input: 'multi',
        options: options.stages.map((s) => ({ value: s.key, label: s.guarded ? `${s.label} ${t.nudges.guardedStage}` : s.label })),
      },
      { value: 'daysInStage', label: t.nudges.fieldDaysInStage, ops: ops(SEGMENT_FIELDS.daysInStage.ops), input: 'number' },
      { value: 'daysSinceLastInteraction', label: t.nudges.fieldDaysSinceLastInteraction, ops: ops(SEGMENT_FIELDS.daysSinceLastInteraction.ops), input: 'number' },
      ...(options.cohorts.length ? [{ value: 'cohort', label: t.nudges.fieldCohort, ops: ops(SEGMENT_FIELDS.cohort.ops), input: 'multi' as const, options: options.cohorts.map((c) => ({ value: c.id, label: c.name })) }] : []),
      ...(options.tags.length ? [{ value: 'tag', label: t.nudges.fieldTag, ops: ops(SEGMENT_FIELDS.tag.ops), input: 'select' as const, options: options.tags.map((c) => ({ value: c.id, label: c.name })) }] : []),
      { value: 'hasNoMentor', label: t.nudges.fieldHasNoMentor, ops: ops(SEGMENT_FIELDS.hasNoMentor.ops), input: 'boolean' },
    ];
  }, [t, options]);

  const missing = missingLocales({ ...draft });
  const langName = { en: t.nudges.langEn, tr: t.nudges.langTr, de: t.nudges.langDe };

  const addCondition = () => {
    const def = fields[0];
    set('segment', { conditions: [...draft.segment.conditions, { field: def.value, op: def.ops[0].value, value: defaultConditionValue(def) }] });
  };

  const save = async () => {
    setBusy(true);
    setError('');
    const res = await fetch(ruleId ? `/api/admin/nudges/${encodeURIComponent(ruleId)}` : '/api/admin/nudges', {
      method: ruleId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A save never flips the switch: enabling is its own audited action.
      body: JSON.stringify(ruleId ? { ...draft, enabled: undefined } : draft),
    });
    setBusy(false);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(t.nudges.errorSave.replace('{reason}', (d.issues as string[] | undefined)?.join('; ') || d.error || String(res.status)));
      return;
    }
    setSavedNote(true);
    onSaved(ruleId ?? d.rule?.id);
  };

  const condLabels = { field: t.nudges.segment, op: t.nudges.segment, value: t.nudges.segment, remove: t.nudges.removeCondition, yes: t.nudges.yes, no: t.nudges.no };

  return (
    <div className="space-y-5" data-testid="nudge-editor">
      <label className="block text-sm">
        <span className="font-medium text-gray-700 dark:text-gray-300">{t.nudges.name}</span>
        <input className={input} data-testid="nudge-name" value={draft.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.nudges.trigger}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="nudge-trigger" checked={draft.trigger.kind === 'scan'} onChange={() => set('trigger', { kind: 'scan' })} data-testid="nudge-trigger-scan" />
          {t.nudges.kindScan}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="nudge-trigger" checked={draft.trigger.kind === 'event'} onChange={() => set('trigger', { kind: 'event', event: NUDGE_EVENT_TRIGGERS[0] })} data-testid="nudge-trigger-event" />
          {t.nudges.kindEvent}
        </label>
        {draft.trigger.kind === 'event' && (
          <select aria-label={t.nudges.event} className={`${input} max-w-sm`} value={draft.trigger.event}
            onChange={(e) => set('trigger', { kind: 'event', event: e.target.value as NudgeEventTrigger })}>
            {NUDGE_EVENT_TRIGGERS.map((ev) => <option key={ev} value={ev}>{eventLabel(ev)}</option>)}
          </select>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">{t.nudges.scopeNote}</p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.nudges.segment}</legend>
        {draft.segment.conditions.length === 0 && <p className="text-xs text-gray-500 dark:text-gray-400">{t.nudges.segmentEmpty}</p>}
        {draft.segment.conditions.map((c, i) => (
          <ConditionRow
            key={i}
            testId={`nudge-condition-${i}`}
            fields={fields}
            condition={c}
            labels={condLabels}
            onChange={(next) => set('segment', { conditions: draft.segment.conditions.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set('segment', { conditions: draft.segment.conditions.filter((_, j) => j !== i) })}
          />
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={addCondition} data-testid="nudge-add-condition">{t.nudges.addCondition}</Button>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">{t.nudges.channel}</span>
          <select className={input} value={draft.channel} onChange={(e) => set('channel', e.target.value as NudgeDraft['channel'])} data-testid="nudge-channel">
            {NUDGE_CHANNELS.map((c) => <option key={c} value={c}>{t.nudges[`channel${c}`]}</option>)}
          </select>
        </label>
        {draft.trigger.kind === 'event' && (
          <label className="block text-sm">
            <span className="font-medium text-gray-700 dark:text-gray-300">{t.nudges.delay}</span>
            <input type="number" min={0} max={43200} className={input} value={draft.delayMinutes}
              onChange={(e) => set('delayMinutes', Math.max(0, Math.trunc(Number(e.target.value) || 0)))} />
          </label>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.nudges.caps}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs text-gray-600 dark:text-gray-300">{t.nudges.maxPer30}
            <input type="number" min={1} max={10} className={input} value={draft.maxPerUserPer30Days}
              onChange={(e) => set('maxPerUserPer30Days', Math.min(10, Math.max(1, Math.trunc(Number(e.target.value) || 1))))} />
          </label>
          <label className="block text-xs text-gray-600 dark:text-gray-300">{t.nudges.cooldown}
            <input type="number" min={0} max={90} className={input} value={draft.cooldownDays}
              onChange={(e) => set('cooldownDays', Math.min(90, Math.max(0, Math.trunc(Number(e.target.value) || 0))))} />
          </label>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t.nudges.capsNote}</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.nudges.message}</legend>
        {missing.length > 0 && (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800" data-testid="nudge-missing-langs">
            {t.nudges.missingLangs.replace('{langs}', missing.map((l) => langName[l]).join(', '))}
          </p>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">{t.nudges.placeholderHint}</p>
        {NUDGE_LOCALES.map((l) => {
          const sk = `subject${LANG_SUFFIX[l]}` as 'subjectEn';
          const bk = `body${LANG_SUFFIX[l]}` as 'bodyEn';
          return (
            <div key={l} className="space-y-1 rounded border border-gray-200 p-2 dark:border-gray-700">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{langName[l]}</p>
              {draft.channel !== 'IN_APP' && (
                <input aria-label={`${t.nudges.subject} (${langName[l]})`} placeholder={t.nudges.subject} className={input} maxLength={191}
                  data-testid={`nudge-subject-${l}`} value={draft[sk]} onChange={(e) => set(sk, e.target.value)} />
              )}
              <textarea aria-label={`${t.nudges.body} (${langName[l]})`} placeholder={t.nudges.body} className={`${input} min-h-[5rem]`} maxLength={5000}
                data-testid={`nudge-body-${l}`} value={draft[bk]} onChange={(e) => set(bk, e.target.value)} />
            </div>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void save()} disabled={busy || !draft.name.trim()} data-testid="nudge-save">{t.nudges.save}</Button>
        {savedNote && <span role="status" className="text-sm text-green-700">{t.nudges.saved}</span>}
        {error && <span role="alert" className="text-sm text-red-700" data-testid="nudge-error">{error}</span>}
      </div>
    </div>
  );
}

export function NudgeGuardrails() {
  const t = useT();
  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300" data-testid="nudge-guardrails">
      <p className="mb-1 font-semibold">{t.nudges.guardrailsTitle}</p>
      <ul className="list-disc space-y-0.5 pl-4">
        <li>{t.nudges.guardrailDormancy}</li>
        <li>{t.nudges.guardrailOutcome}</li>
        <li>{t.nudges.guardrailUnsub}</li>
      </ul>
    </div>
  );
}
