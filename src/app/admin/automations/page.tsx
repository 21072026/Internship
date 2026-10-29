'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, Pencil, Plus, Trash2 } from 'lucide-react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ConditionRow } from '@/components/automation/ConditionRow';
import { useT } from '@/i18n/client';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_EMAIL_TEMPLATES,
  CONDITION_FIELDS,
  CONDITION_FIELD_NAMES,
  NOTIFY_ROLES,
  type AutomationAction,
  type AutomationActionType,
  type AutomationCondition,
  type ConditionField,
} from '@/lib/automation/rule';
import type { SimulationResult } from '@/lib/automation/simulate';

// Stage automation (#1704): the org's rules, an editor built from the action
// allowlist, a dry run against real stage history and the run log. Everything
// this page sends is re-validated by /api/admin/automations — the form only
// offers what the server would accept. docs/automation-rules.md.

interface Stage { key: string; label: string; isOutcome: boolean }
interface Option { id: string; label: string }
interface Rule {
  id: string;
  name: string;
  trigger: 'STAGE_ENTRY' | 'STAGE_EXIT';
  stageKey: string;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  valid: boolean;
  delayMinutes: number;
  enabled: boolean;
  lastSimulatedAt: string | null;
}
interface Run {
  id: string;
  ruleId: string;
  ruleName: string;
  menteeName: string;
  fromStage: string;
  toStage: string;
  status: string;
  results: { index: number; type: string; status: 'ok' | 'skipped' | 'failed'; detail?: string }[];
  error: string | null;
  createdAt: string;
}
interface Draft {
  id: string | null;
  name: string;
  trigger: 'STAGE_ENTRY' | 'STAGE_EXIT';
  stageKey: string;
  delayMinutes: number;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

const selectCls = 'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm';

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

export default function AdminAutomationsPage() {
  const t = useT();
  const A = t.automations;
  const [tab, setTab] = useState<'rules' | 'runs'>('rules');
  const [rules, setRules] = useState<Rule[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [refs, setRefs] = useState<{ tags: Option[]; documentRequirements: Option[]; goalTemplates: Option[] }>({ tags: [], documentRequirements: [], goalTemplates: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [simulations, setSimulations] = useState<Record<string, SimulationResult>>({});
  const [pendingDelete, setPendingDelete] = useState<Rule | null>(null);

  const stageLabel = useCallback((key: string) => stages.find((s) => s.key === key)?.label || key, [stages]);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/automations');
    if (res.ok) {
      const data = await res.json();
      setRules(data.rules ?? []);
      setStages(data.stages ?? []);
      setRefs(data.references ?? { tags: [], documentRequirements: [], goalTemplates: [] });
    } else {
      setError(A.errors.generic);
    }
    setLoading(false);
  }, [A.errors.generic]);
  useEffect(() => { load(); }, [load]);

  const errorFor = (code?: string) => (code && code in A.errors ? A.errors[code as keyof typeof A.errors] : A.errors.generic);

  const call = async (key: string, url: string, method: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorFor(data.code));
        return null;
      }
      return data;
    } finally {
      setBusy('');
    }
  };

  // ── Draft helpers ────────────────────────────────────────────────────────
  const firstStage = stages[0]?.key ?? '';
  const defaultCondition = (field: ConditionField): AutomationCondition => {
    switch (field) {
      case 'kind': return { field, op: 'eq', value: 'PLACEMENT' };
      case 'hasCompany': return { field, op: 'eq', value: true };
      case 'fromStage': return { field, op: 'in', value: firstStage ? [firstStage] : [] };
      case 'toStage': return { field, op: 'in', value: firstStage ? [firstStage] : [] };
      default: return { field: 'daysInFromStage', op: 'gte', value: 7 };
    }
  };
  const defaultAction = (type: AutomationActionType): AutomationAction => {
    switch (type) {
      case 'notifyRole': return { type, role: 'mentor' };
      case 'sendTemplateEmail': return { type, template: 'mentorCheckIn' };
      case 'setStageDeadline': return { type, days: 5 };
      case 'assignGoalFromTemplate': return { type, templateId: refs.goalTemplates[0]?.id ?? '' };
      case 'requireDocument': return { type, requirementId: refs.documentRequirements[0]?.id ?? '' };
      default: return { type: 'addTag', tagId: refs.tags[0]?.id ?? '' };
    }
  };
  const newDraft = (): Draft => ({ id: null, name: '', trigger: 'STAGE_ENTRY', stageKey: firstStage, delayMinutes: 0, conditions: [], actions: [defaultAction('notifyRole')] });
  const editDraft = (r: Rule): Draft => ({ id: r.id, name: r.name, trigger: r.trigger, stageKey: r.stageKey, delayMinutes: r.delayMinutes, conditions: r.conditions, actions: r.actions });

  const save = async () => {
    if (!draft) return;
    const body = { name: draft.name, trigger: draft.trigger, stageKey: draft.stageKey, delayMinutes: draft.delayMinutes, conditions: draft.conditions, actions: draft.actions };
    const data = draft.id
      ? await call('save', `/api/admin/automations/${draft.id}`, 'PATCH', body)
      : await call('save', '/api/admin/automations', 'POST', body);
    if (data) {
      setDraft(null);
      setNotice(A.saved);
      await load();
    }
  };

  const toggle = async (r: Rule) => {
    const data = await call(`toggle-${r.id}`, `/api/admin/automations/${r.id}`, 'PATCH', { enabled: !r.enabled });
    if (data) await load();
  };

  const simulate = async (r: Rule) => {
    const data = await call(`sim-${r.id}`, `/api/admin/automations/${r.id}/simulate`, 'POST', {});
    if (data) {
      setSimulations((s) => ({ ...s, [r.id]: data.result as SimulationResult }));
      setRules((list) => list.map((x) => (x.id === r.id ? { ...x, lastSimulatedAt: data.lastSimulatedAt as string } : x)));
    }
  };

  const move = async (index: number, delta: number) => {
    const next = [...rules];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setRules(next);
    const data = await call('reorder', '/api/admin/automations/reorder', 'POST', { ids: next.map((r) => r.id) });
    if (!data) await load();
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const data = await call(`del-${pendingDelete.id}`, `/api/admin/automations/${pendingDelete.id}`, 'DELETE');
    setPendingDelete(null);
    if (data) await load();
  };

  const actionLabel = (type: string) => (A.actionTypes as Record<string, { label: string }>)[type]?.label ?? type;

  // ── Editor ───────────────────────────────────────────────────────────────
  const conditionFields = CONDITION_FIELD_NAMES.map((f) => ({
    value: f,
    label: A.fields[f],
    ops: CONDITION_FIELDS[f].ops.map((o) => ({ value: o, label: A.ops[o] })),
  }));

  const stageMulti = (value: string[], onChange: (v: string[]) => void) => (
    <>
      <select multiple className={selectCls} value={value} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))} size={Math.min(5, Math.max(2, stages.length))}>
        {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <p className="mt-1 text-xs text-gray-500">{A.stagesHint}</p>
    </>
  );

  const valueEditor = (c: AutomationCondition, set: (c: AutomationCondition) => void) => {
    if (c.field === 'kind') {
      return (
        <select className={selectCls} value={c.value} onChange={(e) => set({ ...c, value: e.target.value as 'PLACEMENT' | 'COACHING' })}>
          <option value="PLACEMENT">{A.kinds.PLACEMENT}</option>
          <option value="COACHING">{A.kinds.COACHING}</option>
        </select>
      );
    }
    if (c.field === 'hasCompany') {
      return (
        <select className={selectCls} value={c.value ? 'yes' : 'no'} onChange={(e) => set({ ...c, value: e.target.value === 'yes' })}>
          <option value="yes">{A.yes}</option>
          <option value="no">{A.no}</option>
        </select>
      );
    }
    if (c.field === 'fromStage' || c.field === 'toStage') return stageMulti(c.value, (v) => set({ ...c, value: v }));
    return <Input type="number" min={0} max={3650} value={c.value} onChange={(e) => set({ ...c, value: Math.max(0, Number(e.target.value) || 0) })} />;
  };

  const optionSelect = (value: string, options: Option[], onChange: (v: string) => void) => (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">{A.choose}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );

  const actionParams = (a: AutomationAction, set: (a: AutomationAction) => void) => {
    switch (a.type) {
      case 'notifyRole':
        return (
          <select className={selectCls} aria-label={A.params.role} value={a.role} onChange={(e) => set({ ...a, role: e.target.value as typeof a.role })}>
            {NOTIFY_ROLES.map((r) => <option key={r} value={r}>{A.roles[r]}</option>)}
          </select>
        );
      case 'sendTemplateEmail':
        return (
          <select className={selectCls} aria-label={A.params.template} value={a.template} onChange={(e) => set({ ...a, template: e.target.value as typeof a.template })}>
            {(Object.keys(AUTOMATION_EMAIL_TEMPLATES) as (keyof typeof AUTOMATION_EMAIL_TEMPLATES)[]).map((k) => <option key={k} value={k}>{A.templates[k]}</option>)}
          </select>
        );
      case 'setStageDeadline':
        return <Input type="number" aria-label={A.params.days} min={1} max={365} value={a.days} onChange={(e) => set({ ...a, days: Math.min(365, Math.max(1, Number(e.target.value) || 1)) })} />;
      case 'assignGoalFromTemplate':
        return optionSelect(a.templateId, refs.goalTemplates, (v) => set({ ...a, templateId: v }));
      case 'requireDocument':
        return optionSelect(a.requirementId, refs.documentRequirements, (v) => set({ ...a, requirementId: v }));
      default:
        return optionSelect(a.tagId, refs.tags, (v) => set({ ...a, tagId: v }));
    }
  };

  const editor = draft && (
    <Card data-testid="automation-editor">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input label={A.name} value={draft.name} maxLength={120} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="automation-name" />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{A.trigger}</span>
            <select className={selectCls} value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as Draft['trigger'] })} data-testid="automation-trigger">
              <option value="STAGE_ENTRY">{A.triggerEntry}</option>
              <option value="STAGE_EXIT">{A.triggerExit}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{A.stage}</span>
            <select className={selectCls} value={draft.stageKey} onChange={(e) => setDraft({ ...draft, stageKey: e.target.value })} data-testid="automation-stage">
              {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <div>
            <Input
              label={A.delay}
              type="number"
              min={0}
              max={43200}
              value={draft.delayMinutes}
              onChange={(e) => setDraft({ ...draft, delayMinutes: Math.max(0, Math.min(43200, Number(e.target.value) || 0)) })}
            />
            <p className="mt-1 text-xs text-gray-500">{A.delayHint}</p>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{A.conditions}</legend>
          {draft.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              testId={`automation-condition-${i}`}
              fields={conditionFields}
              field={c.field}
              op={c.op}
              onFieldChange={(f) => setDraft({ ...draft, conditions: draft.conditions.map((x, j) => (j === i ? defaultCondition(f as ConditionField) : x)) })}
              onOpChange={(op) => setDraft({ ...draft, conditions: draft.conditions.map((x, j) => (j === i ? ({ ...x, op } as AutomationCondition) : x)) })}
              valueEditor={valueEditor(c, (next) => setDraft({ ...draft, conditions: draft.conditions.map((x, j) => (j === i ? next : x)) }))}
              onRemove={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })}
              removeLabel={A.remove}
            />
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, defaultCondition('kind')] })} disabled={draft.conditions.length >= 10}>
            <Plus className="mr-1 h-4 w-4" />
            {A.addCondition}
          </Button>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{A.actions}</legend>
          {draft.actions.map((a, i) => (
            <div key={i} className="rounded-md border border-gray-200 dark:border-gray-700 p-3" data-testid={`automation-action-${i}`}>
              <div className="flex flex-wrap items-start gap-2">
                <span className="pt-1.5 text-sm text-gray-500">{i + 1}.</span>
                <div className="min-w-[12rem] flex-1">
                  <select
                    className={selectCls}
                    aria-label={A.actions}
                    value={a.type}
                    onChange={(e) => setDraft({ ...draft, actions: draft.actions.map((x, j) => (j === i ? defaultAction(e.target.value as AutomationActionType) : x)) })}
                  >
                    {AUTOMATION_ACTION_TYPES.map((type) => <option key={type} value={type}>{actionLabel(type)}</option>)}
                  </select>
                </div>
                <div className="min-w-[12rem] flex-1">{actionParams(a, (next) => setDraft({ ...draft, actions: draft.actions.map((x, j) => (j === i ? next : x)) }))}</div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })} disabled={draft.actions.length <= 1} aria-label={A.remove}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <p className="mt-2 text-xs text-gray-500">{(A.actionTypes as Record<string, { help: string }>)[a.type]?.help}</p>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, actions: [...draft.actions, defaultAction('notifyRole')] })} disabled={draft.actions.length >= 10}>
            <Plus className="mr-1 h-4 w-4" />
            {A.addAction}
          </Button>
        </fieldset>

        <div className="flex gap-2">
          <Button type="submit" loading={busy === 'save'} data-testid="automation-save">{A.save}</Button>
          <Button type="button" variant="ghost" onClick={() => setDraft(null)}>{A.cancel}</Button>
        </div>
      </form>
    </Card>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{A.title}</CardTitle>
          <CardDescription>{A.subtitle}</CardDescription>
        </CardHeader>
        <div className="flex gap-2" role="tablist">
          {(['rules', 'runs'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              data-testid={`automation-tab-${k}`}
              onClick={() => setTab(k)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === k ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}
            >
              {k === 'rules' ? A.tabRules : A.tabRuns}
            </button>
          ))}
        </div>
      </Card>

      {error && <p role="alert" className="text-sm text-red-600" data-testid="automation-error">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}

      {tab === 'runs' ? (
        <RunLog rules={rules} stageLabel={stageLabel} actionLabel={actionLabel} />
      ) : (
        <>
          {!draft && (
            <Button onClick={() => setDraft(newDraft())} disabled={loading || stages.length === 0} data-testid="automation-new">
              <Plus className="mr-1 h-4 w-4" />
              {A.newRule}
            </Button>
          )}
          {draft && !draft.id && editor}
          {loading ? (
            <SkeletonRows rows={3} />
          ) : rules.length === 0 && !draft ? (
            <EmptyState testId="automation-empty" title={A.emptyTitle} body={A.emptyHint} />
          ) : (
            <ul className="space-y-3" data-testid="automation-rule-list">
              {rules.map((r, i) => (
                <li key={r.id} data-testid={`automation-rule-${r.id}`}>
                  {draft?.id === r.id ? (
                    editor
                  ) : (
                    <Card>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold">{r.name}</h3>
                            <Badge variant={r.enabled ? 'success' : 'default'} data-testid={`automation-state-${r.id}`}>{r.enabled ? A.on : A.off}</Badge>
                          </div>
                          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                            {fill(r.trigger === 'STAGE_ENTRY' ? A.summaryEntry : A.summaryExit, { stage: stageLabel(r.stageKey) })}
                            {r.delayMinutes > 0 && ` · ${fill(A.delayNote, { n: r.delayMinutes })}`}
                            {' → '}
                            {r.actions.map((a) => actionLabel(a.type)).join(', ')}
                          </p>
                          {!r.valid && <p className="mt-1 text-sm text-red-600">{A.invalidStored}</p>}
                          {r.lastSimulatedAt ? (
                            <p className="mt-1 text-xs text-gray-500">
                              {A.simulatedAt}: <RelativeTime date={r.lastSimulatedAt} />
                            </p>
                          ) : (
                            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400" data-testid={`automation-warning-${r.id}`}>{A.enableWarning}</p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => simulate(r)} loading={busy === `sim-${r.id}`} data-testid={`automation-simulate-${r.id}`}>
                            <FlaskConical className="mr-1 h-4 w-4" />
                            {A.dryRun}
                          </Button>
                          <Button
                            size="sm"
                            variant={r.enabled ? 'secondary' : 'primary'}
                            onClick={() => toggle(r)}
                            loading={busy === `toggle-${r.id}`}
                            disabled={!r.enabled && (!r.lastSimulatedAt || !r.valid)}
                            title={!r.enabled && !r.lastSimulatedAt ? A.notSimulated : undefined}
                            data-testid={`automation-toggle-${r.id}`}
                          >
                            {r.enabled ? A.switchOff : A.switchOn}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDraft(editDraft(r))} aria-label={A.edit} title={A.edit}><Pencil className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0 || busy === 'reorder'} aria-label={A.moveUp} title={A.moveUp}><ArrowUp className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === rules.length - 1 || busy === 'reorder'} aria-label={A.moveDown} title={A.moveDown}><ArrowDown className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => setPendingDelete(r)} aria-label={A.delete} title={A.delete}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </div>
                      {simulations[r.id] && <SimulationPanel result={simulations[r.id]} stageLabel={stageLabel} actionLabel={actionLabel} />}
                    </Card>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={A.deleteTitle}
        message={fill(A.deleteMessage, { name: pendingDelete?.name ?? '' })}
        confirmLabel={A.delete}
        cancelLabel={A.cancel}
        variant="danger"
        loading={busy.startsWith('del-')}
        onConfirm={remove}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function SimulationPanel({ result, stageLabel, actionLabel }: { result: SimulationResult; stageLabel: (k: string) => string; actionLabel: (t: string) => string }) {
  const A = useT().automations;
  return (
    <div className="mt-4 rounded-md border border-gray-200 dark:border-gray-700 p-3" data-testid="automation-simulate-output">
      <h4 className="text-sm font-semibold">{A.dryRunTitle}</h4>
      <p className="text-xs text-gray-500">{A.dryRunHint}</p>
      <p className="mt-2 text-sm" data-testid="automation-simulate-summary">
        {fill(A.dryRunSummary, { considered: result.considered, matched: result.matched, fire: result.wouldFire })}
      </p>
      {result.moves.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">{A.dryRunNone}</p>
      ) : (
        <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto text-sm">
          {result.moves.map((m) => (
            <li key={m.moveId} className="border-t border-gray-100 dark:border-gray-700 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={m.verdict === 'fire' ? 'info' : 'default'}>{m.verdict === 'fire' ? A.wouldFire : A.wouldSkip}</Badge>
                <span className="font-medium">{m.menteeName}</span>
                <span className="text-gray-500">{stageLabel(m.from)} → {stageLabel(m.to)}</span>
                <span className="text-xs text-gray-500"><RelativeTime date={m.at} /></span>
              </div>
              {m.verdict === 'skip' ? (
                <p className="text-xs text-gray-500">{fill(A.didNotHold, { fields: m.failed.map((f) => A.fields[f]).join(', ') })}</p>
              ) : (
                <p className="text-xs text-gray-500">
                  {m.actions.map((a) => `${actionLabel(a.type)} — ${a.outcome === 'would_run' ? A.wouldRun : A.skippedOutcome}`).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunLog({ rules, stageLabel, actionLabel }: { rules: Rule[]; stageLabel: (k: string) => string; actionLabel: (t: string) => string }) {
  const A = useT().automations;
  const [ruleId, setRuleId] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPage = useCallback(async (before: string | null) => {
    const qs = new URLSearchParams();
    if (ruleId) qs.set('ruleId', ruleId);
    if (before) qs.set('before', before);
    const res = await fetch(`/api/admin/automations/runs?${qs}`);
    const data = res.ok ? await res.json() : { runs: [], nextBefore: null };
    setRuns((list) => (before ? [...list, ...data.runs] : data.runs));
    setNext(data.nextBefore);
    setLoading(false);
  }, [ruleId]);
  useEffect(() => { setLoading(true); fetchPage(null); }, [fetchPage]);

  const variant = useMemo(
    () => (s: string): 'success' | 'warning' | 'danger' | 'default' | 'info' =>
      s === 'SUCCESS' ? 'success' : s === 'PARTIAL' ? 'warning' : s === 'FAILED' ? 'danger' : s === 'PENDING' || s === 'RUNNING' ? 'info' : 'default',
    [],
  );

  return (
    <Card data-testid="automation-run-log">
      <div className="mb-3 max-w-xs">
        <select className={selectCls} value={ruleId} onChange={(e) => setRuleId(e.target.value)} aria-label={A.colRule}>
          <option value="">{A.allRules}</option>
          {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {loading ? (
        <SkeletonRows rows={3} />
      ) : runs.length === 0 ? (
        <p className="text-sm text-gray-500">{A.runsEmpty}</p>
      ) : (
        <ul className="space-y-3">
          {runs.map((r) => (
            <li key={r.id} className="border-t border-gray-100 dark:border-gray-700 pt-3 text-sm" data-testid={`automation-run-${r.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={variant(r.status)} data-testid="automation-run-status">{(A.runStatus as Record<string, string>)[r.status] ?? r.status}</Badge>
                <span className="font-medium">{r.ruleName}</span>
                <span>{r.menteeName}</span>
                <span className="text-gray-500">{stageLabel(r.fromStage)} → {stageLabel(r.toStage)}</span>
                <span className="text-xs text-gray-500"><RelativeTime date={r.createdAt} /></span>
              </div>
              {r.results.length > 0 && (
                <ul className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                  {r.results.map((s) => (
                    <li key={s.index}>
                      {s.index + 1}. {actionLabel(s.type)} — {A.stepStatus[s.status]}{s.detail ? ` (${s.detail})` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {r.error && <p className="mt-1 break-words text-xs text-red-600" data-testid="automation-run-error">{r.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {next && (
        <Button variant="outline" size="sm" className="mt-3" onClick={() => fetchPage(next)}>{A.loadMore}</Button>
      )}
    </Card>
  );
}
