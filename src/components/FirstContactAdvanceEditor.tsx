'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { DEFAULT_FIRST_CONTACT_TARGET } from '@/lib/firstContactAdvanceRule';

// First-contact auto-advance (#3746): the switch and its target stage, MARKETING
// only (the settings page renders this for that vertical; the API refuses the
// keys anywhere else). '' as the target = the marketing preset's "Contacted"
// stage where this pipeline has it. The rule is src/lib/firstContactAdvanceRule.ts.
export function FirstContactAdvanceEditor() {
  const t = useT();
  const f = t.settings.firstContactAdvance;
  const stages = useResolvedStages();
  const [mode, setMode] = useState<'off' | 'on'>('off');
  const [target, setTarget] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');

  useEffect(() => {
    fetch('/api/admin/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(({ settings }) => {
        setMode(settings.firstContactAutoAdvance === 'on' ? 'on' : 'off');
        setTarget(settings.firstContactTargetStage ?? '');
        setState('ready');
      })
      .catch(() => setState('error'));
  }, []);

  const preset = stages.find((s) => s.key === DEFAULT_FIRST_CONTACT_TARGET);
  const onPath = stages.filter((s) => !s.isTerminal && !s.isOffPath);
  const options = [
    { value: '', label: preset ? f.defaultTarget.replace('{stage}', preset.label) : f.defaultMissing },
    ...onPath.map((s) => ({ value: s.key, label: s.label })),
  ];
  const noTarget = !target && !preset;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('saving');
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstContactAutoAdvance: mode, firstContactTargetStage: target }),
    }).catch(() => null);
    setState(res?.ok ? 'saved' : 'error');
  };

  return (
    <Card className="mt-6" id="first-contact-advance" data-testid="first-contact-advance">
      <CardHeader>
        <CardTitle>{f.title}</CardTitle>
        <p className="mt-1 text-sm text-gray-500">{f.subtitle}</p>
      </CardHeader>
      <form onSubmit={save} className="space-y-4">
        <fieldset disabled={state === 'loading' || state === 'saving'} className="min-w-0 space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={mode === 'on'}
              onChange={(e) => setMode(e.target.checked ? 'on' : 'off')}
              data-testid="first-contact-advance-toggle"
            />
            {f.toggle}
          </label>
          <Select label={f.target} value={target} onChange={(e) => setTarget(e.target.value)} options={options} data-testid="first-contact-advance-target" />
          {noTarget && <p className="text-sm text-amber-700 dark:text-amber-400" role="status">{f.noTargetNote}</p>}
          <p className="text-xs text-gray-500">{f.boundsNote}</p>
          <div className="flex items-center gap-3">
            <Button type="submit" loading={state === 'saving'} data-testid="first-contact-advance-save">{t.common.save}</Button>
            {state === 'saved' && <span className="text-sm text-green-700 dark:text-green-400" role="status">{f.saved}</span>}
            {state === 'error' && <span className="text-sm text-red-600" role="alert">{t.common.error}</span>}
          </div>
        </fieldset>
      </form>
    </Card>
  );
}
