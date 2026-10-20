'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowDown, ArrowLeft, ArrowUp, Pencil } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLocale, useT } from '@/i18n/client';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { intlLocaleFor } from '@/lib/interviewRequests';
import {
  JOURNEY_ACTIONS,
  JOURNEY_AUDIENCES,
  JOURNEY_SKIP_CONDITIONS,
  stepTitle,
  type JourneyAction,
  type JourneyAudience,
  type JourneySkipCondition,
  type StepPayload,
  type StepStatus,
} from '@/lib/programJourneyRule';

// The journey builder (#1853): a programme's steps in order, grouped under
// their milestones, edited in three languages, previewed against a real pair
// and published. Every rule is server-side (src/lib/programJourneyAdmin.ts);
// this page only renders what the API answers, including its refusal codes.

// PROGRAM_START is offered once the programme carries a start date (#1622).
const ANCHORS = ['RELATION_START', 'STAGE_ENTRY'] as const;

interface Step {
  id: string;
  order: number;
  milestone: string | null;
  anchor: string;
  offsetDays: number;
  audience: JourneyAudience;
  action: JourneyAction;
  payload: StepPayload;
  title: string;
  translations: Partial<Record<'en' | 'tr' | 'de', string>>;
  publishedAt: string | null;
  archivedAt: string | null;
  runs: number;
}
interface Pairing { id: string; startDate: string; menteeName: string; mentorName: string }
interface TimelineRow { stepId: string; status: StepStatus; dueAt: string | null; reason: string | null }

interface Draft {
  milestone: string;
  anchor: (typeof ANCHORS)[number];
  offsetDays: string;
  stageKey: string;
  audience: JourneyAudience;
  action: JourneyAction;
  url: string;
  skipIf: JourneySkipCondition | '';
  en: string;
  tr: string;
  de: string;
}
const EMPTY: Draft = { milestone: '', anchor: 'RELATION_START', offsetDays: '0', stageKey: '', audience: 'BOTH', action: 'NUDGE', url: '', skipIf: '', en: '', tr: '', de: '' };

function draftOf(s: Step): Draft {
  return {
    milestone: s.milestone ?? '',
    anchor: s.anchor === 'STAGE_ENTRY' ? 'STAGE_ENTRY' : 'RELATION_START',
    offsetDays: String(s.offsetDays),
    stageKey: s.payload.stageKey ?? '',
    audience: s.audience,
    action: s.action,
    url: s.payload.url ?? '',
    skipIf: s.payload.skipIf ?? '',
    en: s.translations.en ?? '',
    tr: s.translations.tr ?? '',
    de: s.translations.de ?? '',
  };
}

export default function ProgramJourneyPage() {
  const t = useT();
  const T = t.programJourney;
  const locale = useLocale();
  const stages = useResolvedStages();
  const { id } = useParams<{ id: string }>();
  const [program, setProgram] = useState<{ name: string; term: string | null } | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relationId, setRelationId] = useState('');
  const [timeline, setTimeline] = useState<Map<string, TimelineRow>>(new Map());

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/programs/${id}/journey`);
    if (!res.ok) {
      setMissing(true);
      setLoading(false);
      return;
    }
    const body = await res.json();
    setProgram(body.program);
    setSteps(body.steps);
    setPairings(body.relations);
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const loadPreview = useCallback(async () => {
    if (!relationId) { setTimeline(new Map()); return; }
    const res = await fetch(`/api/admin/programs/${id}/journey/preview?relationId=${encodeURIComponent(relationId)}`);
    if (!res.ok) { setTimeline(new Map()); return; }
    const rows: TimelineRow[] = (await res.json()).timeline;
    setTimeline(new Map(rows.map((r) => [r.stepId, r])));
  }, [id, relationId]);
  useEffect(() => { loadPreview(); }, [loadPreview, steps]);

  const errorText = (code: unknown) => (typeof code === 'string' && code in T.errors ? T.errors[code as keyof typeof T.errors] : T.errors.generic);

  const call = async (url: string, method: string, body?: unknown) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!res.ok) {
        setError(errorText((await res.json().catch(() => ({}))).code));
        return false;
      }
      await load();
      return true;
    } finally {
      setSaving(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const offset = parseInt(draft.offsetDays, 10);
    const body = {
      milestone: draft.milestone || null,
      anchor: draft.anchor,
      offsetDays: Number.isFinite(offset) ? offset : 0,
      audience: draft.audience,
      action: draft.action,
      translations: { en: draft.en, tr: draft.tr, de: draft.de },
      stageKey: draft.anchor === 'STAGE_ENTRY' ? draft.stageKey || null : null,
      url: draft.action === 'PUBLISH_CONTENT' ? draft.url || null : null,
      skipIf: draft.skipIf || null,
    };
    const ok = editing
      ? await call(`/api/admin/programs/${id}/journey/${editing}`, 'PATCH', body)
      : await call(`/api/admin/programs/${id}/journey`, 'POST', body);
    if (ok) { setDraft(EMPTY); setEditing(null); }
  };

  const live = useMemo(() => steps.filter((s) => !s.archivedAt), [steps]);
  const archived = useMemo(() => steps.filter((s) => s.archivedAt), [steps]);

  const move = async (index: number, delta: number) => {
    const ids = live.map((s) => s.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await call(`/api/admin/programs/${id}/journey`, 'PATCH', { order: ids });
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(intlLocaleFor(locale), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const statusVariant = (s: StepStatus) => (s === 'delivered' || s === 'due' ? 'success' : s === 'missed' || s === 'unresolved' ? 'danger' : s === 'skipped' || s === 'would_skip' ? 'warning' : 'default');

  if (missing) return <p className="py-10 text-center text-gray-500">{T.errors.generic}</p>;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/cohorts" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-blue-600"><ArrowLeft className="h-4 w-4" />{T.back}</Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">{T.title}{program ? ` · ${program.name}` : ''}</h1>
        <p className="text-gray-500">{T.subtitle}</p>
      </div>

      <Card>
        <CardHeader><CardTitle>{editing ? T.editStep : T.addStep}</CardTitle></CardHeader>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" data-testid="journey-step-form">
          <Input label={T.milestone} placeholder={T.milestonePlaceholder} value={draft.milestone} maxLength={120} onChange={(e) => set('milestone', e.target.value)} data-testid="journey-milestone" />
          <Select label={T.action} value={draft.action} onChange={(e) => set('action', e.target.value as JourneyAction)} options={JOURNEY_ACTIONS.map((a) => ({ value: a, label: T.actions[a] }))} data-testid="journey-action" />
          <Select label={T.anchor} value={draft.anchor} onChange={(e) => set('anchor', e.target.value as Draft['anchor'])} options={ANCHORS.map((a) => ({ value: a, label: T.anchors[a] }))} data-testid="journey-anchor" />
          <Input label={T.offsetDays} hint={T.offsetHint} type="number" value={draft.offsetDays} onChange={(e) => set('offsetDays', e.target.value)} data-testid="journey-offset" />
          {draft.anchor === 'STAGE_ENTRY' && (
            <Select label={T.stage} value={draft.stageKey} placeholder={T.chooseStage} onChange={(e) => set('stageKey', e.target.value)} options={stages.map((s) => ({ value: s.key, label: s.label }))} data-testid="journey-stage" />
          )}
          <Select label={T.audience} value={draft.audience} onChange={(e) => set('audience', e.target.value as JourneyAudience)} options={JOURNEY_AUDIENCES.map((a) => ({ value: a, label: T.audiences[a] }))} data-testid="journey-audience" />
          {draft.action === 'PUBLISH_CONTENT' && (
            <Input label={T.url} hint={T.urlHint} value={draft.url} maxLength={500} onChange={(e) => set('url', e.target.value)} data-testid="journey-url" />
          )}
          <Select
            label={T.skipIf}
            value={draft.skipIf}
            onChange={(e) => set('skipIf', e.target.value as Draft['skipIf'])}
            options={[{ value: '', label: T.skipNever }, ...JOURNEY_SKIP_CONDITIONS.map((c) => ({ value: c, label: T.skipIfs[c] }))]}
            data-testid="journey-skip"
          />
          <Input label={T.titleEn} value={draft.en} maxLength={191} onChange={(e) => set('en', e.target.value)} data-testid="journey-title-en" />
          <Input label={T.titleTr} value={draft.tr} maxLength={191} onChange={(e) => set('tr', e.target.value)} data-testid="journey-title-tr" />
          <Input label={T.titleDe} value={draft.de} maxLength={191} hint={T.titleHint} onChange={(e) => set('de', e.target.value)} data-testid="journey-title-de" />
          {error && <p role="alert" className="text-sm text-red-600 sm:col-span-2" data-testid="journey-error">{error}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" loading={saving} data-testid="journey-save">{editing ? t.common.save : T.addStep}</Button>
            {editing && <Button type="button" variant="ghost" onClick={() => { setEditing(null); setDraft(EMPTY); setError(null); }}>{t.common.cancel}</Button>}
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{T.preview}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-gray-500">{T.previewHint}</p>
        {pairings.length === 0 ? (
          <p className="text-sm text-gray-400">{T.noRelations}</p>
        ) : (
          <Select
            aria-label={T.pickRelation}
            value={relationId}
            placeholder={T.pickRelation}
            onChange={(e) => setRelationId(e.target.value)}
            options={pairings.map((p) => ({ value: p.id, label: `${p.menteeName} · ${p.mentorName} · ${T.startedOn.replace('{date}', fmtDate(p.startDate))}` }))}
            data-testid="journey-preview-relation"
          />
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardHeader><CardTitle>{T.title} ({live.length})</CardTitle></CardHeader>
          {live.some((s) => !s.publishedAt) && (
            <Button size="sm" onClick={() => call(`/api/admin/programs/${id}/journey`, 'PATCH', { publish: 'all' })} loading={saving} data-testid="journey-publish-all">{T.publishAll}</Button>
          )}
        </div>
        {loading ? (
          <SkeletonRows rows={4} />
        ) : live.length === 0 ? (
          <p className="py-10 text-center text-gray-400">{T.none}</p>
        ) : (
          <ol className="divide-y divide-gray-100" data-testid="journey-steps">
            {live.map((s, i) => {
              const header = i === 0 || live[i - 1].milestone !== s.milestone;
              const row = timeline.get(s.id);
              return (
                <li key={s.id} data-testid={`journey-step-${s.id}`} className="py-3">
                  {header && <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{s.milestone || T.noMilestone}</p>}
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-gray-900">{stepTitle(s, locale)}</p>
                      <p className="text-sm text-gray-500">
                        {T.dayLabel.replace('{n}', String(s.offsetDays))} · {T.anchors[s.anchor as keyof typeof T.anchors] ?? s.anchor}
                        {s.payload.stageKey ? ` (${stages.find((x) => x.key === s.payload.stageKey)?.label ?? s.payload.stageKey})` : ''}
                        {' · '}{T.actions[s.action]} · {T.audiences[s.audience]}
                        {s.runs > 0 ? ` · ${T.runs.replace('{n}', String(s.runs))}` : ''}
                      </p>
                      {row && (
                        <p className="mt-1 text-sm" data-testid={`journey-preview-${s.id}`} data-status={row.status}>
                          {row.dueAt && <span className="mr-2 text-gray-700">{fmtDate(row.dueAt)}</span>}
                          <Badge variant={statusVariant(row.status)}>{T.status[row.status]}</Badge>
                        </p>
                      )}
                    </div>
                    <Badge variant={s.publishedAt ? 'success' : 'default'}>{s.publishedAt ? T.published : T.draft}</Badge>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => move(i, -1)} disabled={saving || i === 0} aria-label={T.moveUp} className="p-1 text-gray-400 hover:text-blue-600 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                      <button type="button" onClick={() => move(i, 1)} disabled={saving || i === live.length - 1} aria-label={T.moveDown} className="p-1 text-gray-400 hover:text-blue-600 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                      <button type="button" onClick={() => { setEditing(s.id); setDraft(draftOf(s)); setError(null); }} aria-label={T.editStep} className="p-1 text-gray-400 hover:text-blue-600"><Pencil className="h-4 w-4" /></button>
                      <Button size="sm" variant="outline" disabled={saving} onClick={() => call(`/api/admin/programs/${id}/journey/${s.id}`, 'PATCH', { published: !s.publishedAt })} data-testid={`journey-toggle-${s.id}`}>
                        {s.publishedAt ? T.unpublish : T.publish}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={saving} onClick={() => call(`/api/admin/programs/${id}/journey/${s.id}`, 'DELETE')}>{T.archive}</Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {archived.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{T.archived} ({archived.length})</CardTitle></CardHeader>
          <ul className="divide-y divide-gray-100">
            {archived.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-gray-500">{stepTitle(s, locale)}</span>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => call(`/api/admin/programs/${id}/journey/${s.id}`, 'PATCH', { archived: false })}>{T.restore}</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
