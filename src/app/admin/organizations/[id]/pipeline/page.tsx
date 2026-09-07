'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

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
}

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

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/organizations/${id}/pipeline-stages`);
    if (res.ok) {
      const data = await res.json();
      setStages(data.stages);
      setCustom(data.custom);
      setPlan(data.plan ?? 'FREE');
    } else {
      setErr(t.pipelineStages.loadFailed);
    }
    setLoading(false);
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  const update = (i: number, patch: Partial<Stage>) =>
    setStages((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));

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
    const payload = { stages: stages.map((s, idx) => ({ ...s, order: idx })) };
    const res = await fetch(`/api/admin/organizations/${id}/pipeline-stages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setStages(data.stages); setCustom(true); setMsg(t.pipelineStages.saved); }
    else { setErr(t.pipelineStages.saveFailed); setErrDetail(data.error || null); }
    setSaving(false);
  };

  const reset = async () => {
    setSaving(true); setMsg(null); setErr(null); setErrDetail(null);
    const res = await fetch(`/api/admin/organizations/${id}/pipeline-stages`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setStages(data.stages); setCustom(false); setMsg(t.pipelineStages.resetDone); }
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
          {custom ? t.pipelineStages.usingCustom : t.pipelineStages.usingDefaults}
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
          <p className="text-sm text-gray-400">{t.common.loading}</p>
        ) : (
          <div className="space-y-2">
            {stages.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2 border border-gray-100 rounded-lg p-2">
                <div className="flex flex-col">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs leading-none">▲</button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1} className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs leading-none">▼</button>
                </div>
                <input
                  value={s.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  aria-label={t.pipelineStages.labelFor.replace('{key}', s.key)}
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
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={s.isOffPath} onChange={(e) => update(i, { isOffPath: e.target.checked })} />
                  {t.pipelineStages.offPath}
                </label>
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={s.isTerminal} onChange={(e) => update(i, { isTerminal: e.target.checked })} />
                  {t.pipelineStages.terminal}
                </label>
              </div>
            ))}
          </div>
        )}

        {/* The PUT replaces the whole stage set (deleteMany + createMany) and
            remaps nothing, so the copy says "replaces", not "updates" — a label
            that made this sound like a partial edit would be a lie. */}
        <p className="text-xs text-gray-500 mt-5">{t.pipelineStages.saveReplacesHint}</p>
        <div className="flex gap-3 mt-2">
          <Button onClick={save} loading={saving} disabled={loading || plan === 'FREE'} data-testid="pipeline-stages-save">{t.pipelineStages.save}</Button>
          <Button variant="secondary" onClick={reset} disabled={saving || loading || !custom}>{t.pipelineStages.reset}</Button>
        </div>
      </Card>
    </div>
  );
}
