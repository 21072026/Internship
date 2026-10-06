'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { DEFAULT_EVALUATION_SCHEDULE } from '@/lib/evaluationDueRule';

// When INTERIM and FINAL evaluations fall due (#1891). Stage KEYS of the org's
// own pipeline; '' = the built-in default where this pipeline has it, 'off' =
// no reminders for that type. The sweep is src/lib/evaluationDue.ts.
export function EvaluationScheduleEditor() {
  const t = useT();
  const e = t.settings.evaluationSchedule;
  const stages = useResolvedStages();
  const [interimStage, setInterimStage] = useState('');
  const [interimDays, setInterimDays] = useState('30');
  const [finalStage, setFinalStage] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');

  useEffect(() => {
    fetch('/api/admin/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(({ settings }) => {
        setInterimStage(settings.evaluationInterimStage ?? '');
        setInterimDays(settings.evaluationInterimDays ?? '30');
        setFinalStage(settings.evaluationFinalStage ?? '');
        setState('ready');
      })
      .catch(() => setState('error'));
  }, []);

  const has = (key: string) => stages.some((s) => s.key === key);
  const defaultLabel = (type: 'INTERIM' | 'FINAL') => {
    const key = DEFAULT_EVALUATION_SCHEDULE[type].stageKey;
    const stage = stages.find((s) => s.key === key);
    return stage ? e.defaultStage.replace('{stage}', stage.label) : e.defaultMissing;
  };
  const options = (type: 'INTERIM' | 'FINAL') => [
    { value: '', label: defaultLabel(type) },
    { value: 'off', label: e.off },
    ...stages.map((s) => ({ value: s.key, label: s.label })),
  ];

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('saving');
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evaluationInterimStage: interimStage, evaluationInterimDays: interimDays, evaluationFinalStage: finalStage }),
    }).catch(() => null);
    setState(res?.ok ? 'saved' : 'error');
  };

  return (
    <Card className="mt-6" data-testid="evaluation-schedule">
      <CardHeader>
        <CardTitle>{e.title}</CardTitle>
        <p className="mt-1 text-sm text-gray-500">{e.subtitle}</p>
      </CardHeader>
      <form onSubmit={save} className="space-y-4">
        <fieldset disabled={state === 'loading' || state === 'saving'} className="min-w-0 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label={e.interimStage} value={interimStage} onChange={(ev) => setInterimStage(ev.target.value)} options={options('INTERIM')} data-testid="evaluation-interim-stage" />
            <Input label={e.interimDays} type="number" min={0} max={365} value={interimDays} onChange={(ev) => setInterimDays(ev.target.value)} data-testid="evaluation-interim-days" />
          </div>
          <Select label={e.finalStage} value={finalStage} onChange={(ev) => setFinalStage(ev.target.value)} options={options('FINAL')} data-testid="evaluation-final-stage" />
          {interimStage && interimStage !== 'off' && !has(interimStage) && <p className="text-sm text-red-600">{e.unknownStage}</p>}
          <p className="text-xs text-gray-500">{e.capNote}</p>
          <div className="flex items-center gap-3">
            <Button type="submit" loading={state === 'saving'} data-testid="evaluation-schedule-save">{t.common.save}</Button>
            {state === 'saved' && <span className="text-sm text-green-700 dark:text-green-400" role="status">{e.saved}</span>}
            {state === 'error' && <span className="text-sm text-red-600" role="alert">{t.common.error}</span>}
          </div>
        </fieldset>
      </form>
    </Card>
  );
}
