'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { PIPELINE_PHASES, defaultPipelineStages, stageKeyFromLabel } from '@/lib/pipeline';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// Admin editor for a tenant's pipeline stages (#747, Slice A.2). Relabel /
// reorder / recolor / mark on-path/terminal over the canonical keys; reset to
// the built-in defaults. Premium-gated server-side (PUT rejects FREE plans).

interface Stage {
  key: string;
  label: string;
  order: number;
  isTerminal: boolean;
  isOffPath: boolean;
  color: string | null;
  // Board phase (#1637): null = derive it (built-in phase for a canonical
  // key, the "custom" group for any other).
  phase?: string | null;
  // Client-only (#1635): a row added in this session. Its key is still being
  // derived from the label; once saved it never changes again.
  isNew?: boolean;
  // Client-only stable React key — the stage key itself changes while a new
  // row's label is typed, and a re-keyed input would lose focus.
  uid?: string;
}

let nextUid = 0;
const withUid = (list: Stage[]) => list.map((s) => ({ ...s, uid: s.uid ?? `s${nextUid++}` }));

export default function PipelineStagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const [stages, setStages] = useState<Stage[]>([]);
  const [custom, setCustom] = useState(false);
  const [plan, setPlan] = useState<string>('FREE');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The API answers in English (it is a developer-facing detail: "Stage keys
  // must be unique", a bad hex colour, a plan refusal). Keep it, but under the
  // translated headline rather than instead of it (#1625).
  const [errDetail, setErrDetail] = useState<string | null>(null);
  // Records per stage key (#1635), from the GET — the remove control is
  // disabled on a stage in use (the PUT re-checks and answers 409).
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/organizations/${id}/pipeline-stages`);
    if (res.ok) {
      const data = await res.json();
      setStages(withUid(data.stages));
      setCustom(data.custom);
      setPlan(data.plan ?? 'FREE');
      setUsage(data.usage ?? {});
    } else {
      setErr(t.pipelineStages.loadFailed);
    }
    setLoading(false);
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  const update = (i: number, patch: Partial<Stage>) =>
    setStages((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));

  // A new row's key follows its label until the first save (#1635); a saved
  // row's label edit never touches its key.
  const relabel = (i: number, label: string) =>
    setStages((s) =>
      s.map((st, idx) => {
        if (idx !== i) return st;
        if (!st.isNew) return { ...st, label };
        const taken = new Set(s.filter((_, j) => j !== i).map((x) => x.key));
        return { ...st, label, key: stageKeyFromLabel(label, taken) };
      })
    );

  const addStage = () =>
    setStages((s) => {
      const label = t.pipelineStages.newStageLabel;
      const key = stageKeyFromLabel(label, new Set(s.map((x) => x.key)));
      return [
        ...s,
        { key, label, order: s.length, isTerminal: false, isOffPath: false, color: null, phase: null, isNew: true, uid: `s${nextUid++}` },
      ];
    });

  const remove = (i: number) => setStages((s) => s.filter((_, idx) => idx !== i).map((st, idx) => ({ ...st, order: idx })));

  // Records a reset would leave on a key the built-in set does not have.
  const builtIn = new Set(defaultPipelineStages().map((s) => s.key));
  const stranded = Object.entries(usage).reduce((n, [k, c]) => (builtIn.has(k) ? n : n + c), 0);

  const move = (i: number, dir: -1 | 1) => {
    setStages((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy.map((st, idx) => ({ ...st, order: idx }));
    });
  };

  const save = async () => {
    setSaving(true); setMsg(null); setErr(null); setErrDetail(null);
    const payload = {
      stages: stages.map(({ isNew: _isNew, uid: _uid, ...s }, idx) => ({ ...s, order: idx })),
    };
    const res = await fetch(`/api/admin/organizations/${id}/pipeline-stages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setStages(withUid(data.stages)); setCustom(true); setMsg(t.pipelineStages.saved); }
    else if (res.status === 409 && data.code === 'stage_in_use') {
      setErr(t.pipelineStages.inUseRefused.replace('{keys}', Object.keys(data.inUse ?? {}).join(', ')));
      await load();
    }
    else { setErr(t.pipelineStages.saveFailed); setErrDetail(data.error || null); }
    setSaving(false);
  };

  const reset = async () => {
    setSaving(true); setMsg(null); setErr(null); setErrDetail(null);
    const res = await fetch(`/api/admin/organizations/${id}/pipeline-stages`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setStages(withUid(data.stages)); setCustom(false); setMsg(t.pipelineStages.resetDone); }
    else { setErr(t.pipelineStages.resetFailed); setErrDetail(data.error || null); }
    setSaving(false);
  };

  return (
    <div className="max-w-3xl mx-auto p-6" data-testid="pipeline-stages-editor">
      <div className="mb-4">
        <Link href="/admin/organizations" className="text-sm text-blue-600 hover:underline">← {t.pipelineStages.backToOrganizations}</Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t.pipelineStages.title}</CardTitle>
        </CardHeader>

        <p className="text-sm text-gray-500 mb-4">
          {t.pipelineStages.subtitle}{' '}
          {/* Its own element, not a bare text node in the paragraph: which of
              the two sentences is on screen is the one fact a test needs to
              read exactly, and a shared <p> can only be matched by substring. */}
          <span data-testid="pipeline-stages-source">
            {custom ? t.pipelineStages.usingCustom : t.pipelineStages.usingDefaults}
          </span>
        </p>

        {plan === 'FREE' && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
            {t.pipelineStages.freePlanNotice}
          </div>
        )}
        {msg && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{msg}</div>}
        {err && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {err}
            {errDetail && <span className="block mt-1 text-xs font-mono text-red-600">{errDetail}</span>}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-400" data-testid="page-loading">{t.common.loading}</p>
        ) : (
          <div className="space-y-2">
            {stages.map((s, i) => (
              <div key={s.uid ?? s.key} className="flex flex-wrap items-center gap-2 border border-gray-100 rounded-lg p-2" data-testid={`stage-row-${s.key}`}>
                <div className="flex flex-col">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs leading-none">▲</button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1} className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs leading-none">▼</button>
                </div>
                <input
                  value={s.label}
                  onChange={(e) => relabel(i, e.target.value)}
                  aria-label={t.pipelineStages.labelFor.replace('{key}', s.key)}
                  data-testid={`stage-label-${s.key}`}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                />
                <code className="text-[10px] text-gray-400 w-32 truncate" title={s.key}>{s.key}</code>
                <input
                  type="color"
                  value={s.color || '#2563eb'}
                  onChange={(e) => update(i, { color: e.target.value })}
                  aria-label={t.pipelineStages.colorFor.replace('{key}', s.key)}
                  className="h-8 w-10 rounded border border-gray-300"
                />
                <select
                  value={s.phase ?? ''}
                  onChange={(e) => update(i, { phase: e.target.value || null })}
                  aria-label={t.pipelineStages.phaseFor.replace('{key}', s.key)}
                  data-testid={`stage-phase-${s.key}`}
                  className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs"
                >
                  <option value="">{t.pipelineStages.phaseAuto}</option>
                  {PIPELINE_PHASES.map((p) => (
                    <option key={p} value={p}>{t.adminBoard.groups[p]}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={s.isOffPath} onChange={(e) => update(i, { isOffPath: e.target.checked })} />
                  {t.pipelineStages.offPath}
                </label>
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={s.isTerminal} onChange={(e) => update(i, { isTerminal: e.target.checked })} />
                  {t.pipelineStages.terminal}
                </label>
                {(() => {
                  const n = s.isNew ? 0 : usage[s.key] ?? 0;
                  return (
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      disabled={n > 0 || stages.length <= 1}
                      title={n > 0 ? t.pipelineStages.inUse.replace('{n}', String(n)) : undefined}
                      aria-label={t.pipelineStages.removeFor.replace('{key}', s.key)}
                      data-testid={`stage-remove-${s.key}`}
                      className="text-xs text-red-600 hover:underline disabled:text-gray-400 disabled:no-underline"
                    >
                      {t.pipelineStages.remove}
                    </button>
                  );
                })()}
                {!s.isNew && (usage[s.key] ?? 0) > 0 && (
                  <span className="basis-full text-[11px] text-gray-500" data-testid={`stage-in-use-${s.key}`}>
                    {t.pipelineStages.inUse.replace('{n}', String(usage[s.key]))}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* The PUT replaces the whole stage set (deleteMany + createMany) and
            remaps nothing, so the copy says "replaces", not "updates" — a label
            that made this sound like a partial edit would be a lie. */}
        {!loading && (
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={addStage} disabled={stages.length >= 50} data-testid="stage-add">
              {t.pipelineStages.addStage}
            </Button>
          </div>
        )}
        <p className="text-xs text-gray-500 mt-5">{t.pipelineStages.saveReplacesHint}</p>
        <div className="flex gap-3 mt-2">
          <Button onClick={save} loading={saving} disabled={loading || plan === 'FREE'} data-testid="pipeline-stages-save">{t.pipelineStages.save}</Button>
          <Button variant="secondary" onClick={() => setConfirmReset(true)} disabled={saving || loading || !custom} data-testid="pipeline-stages-reset">{t.pipelineStages.reset}</Button>
        </div>
      </Card>
      <ConfirmDialog
        open={confirmReset}
        title={t.pipelineStages.resetConfirmTitle}
        message={
          stranded > 0
            ? `${t.pipelineStages.resetConfirmBody} ${t.pipelineStages.resetStranded.replace('{n}', String(stranded))}`
            : t.pipelineStages.resetConfirmBody
        }
        confirmLabel={t.pipelineStages.reset}
        cancelLabel={t.common.cancel}
        variant="danger"
        loading={saving}
        onConfirm={async () => {
          setConfirmReset(false);
          await reset();
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
