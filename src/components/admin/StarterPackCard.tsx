'use client';

import { useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// The tenant starter pack (#2066), from settings: one button that applies the
// pack (POST /api/admin/organizations/[id]/starter-pack) and the per-model
// result. Re-applying is safe by construction — the server only ever adds
// what is missing and never changes what the organization edited.

type Model = 'stages' | 'slas' | 'documentRequirements' | 'evaluationTemplates' | 'goalTemplates';
type Summary = Record<Model, { created: number; skipped: number }> & { sampleProgram?: { created: number; skipped: number } };
const MODELS: Model[] = ['stages', 'slas', 'documentRequirements', 'evaluationTemplates', 'goalTemplates'];

export function StarterPackCard({ orgId }: { orgId: string }) {
  const t = useT();
  const s = t.orgStarterPack;
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  const [sample, setSample] = useState(false);
  const [removed, setRemoved] = useState<number | null>(null);

  const apply = async () => {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/organizations/${encodeURIComponent(orgId)}/starter-pack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleProgram: sample }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSummary((await res.json()).summary);
      setRemoved(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  // The sample programme comes off as a set: exactly the rows tagged as sample.
  const removeSample = async () => {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/organizations/${encodeURIComponent(orgId)}/sample-data`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      const r = (await res.json()).removed as Record<string, number>;
      setRemoved(Object.values(r).reduce((n, v) => n + v, 0));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6" data-testid="starter-pack">
      <CardHeader>
        <CardTitle>{s.title}</CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-600 dark:text-gray-300">{s.body}</p>
      <label className="mt-3 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input type="checkbox" className="mt-1" checked={sample} onChange={(e) => setSample(e.target.checked)} data-testid="starter-pack-sample" />
        <span>
          {s.sampleLabel}
          <span className="block text-xs text-gray-500 dark:text-gray-400">{s.sampleNote}</span>
        </span>
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" onClick={apply} loading={busy} data-testid="starter-pack-apply">
          <PackageCheck className="mr-1 h-4 w-4" aria-hidden="true" /> {s.apply}
        </Button>
        <Button variant="ghost" onClick={removeSample} loading={busy} data-testid="starter-pack-remove-sample">
          {s.removeSample}
        </Button>
      </div>
      {removed !== null && <p className="mt-2 text-sm text-gray-700 dark:text-gray-200" data-testid="starter-pack-removed">{s.removed.replace('{n}', String(removed))}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{s.error}</p>}
      {summary && (
        <ul className="mt-3 space-y-0.5 text-sm text-gray-700 dark:text-gray-200" data-testid="starter-pack-summary">
          {MODELS.map((m) => (
            <li key={m} data-testid={`starter-pack-${m}`} data-created={summary[m].created}>
              {s.row.replace('{model}', s.models[m]).replace('{created}', String(summary[m].created)).replace('{skipped}', String(summary[m].skipped))}
            </li>
          ))}
          {summary.sampleProgram && (
            <li data-testid="starter-pack-sampleProgram" data-created={summary.sampleProgram.created}>
              {s.row.replace('{model}', s.sampleModel).replace('{created}', String(summary.sampleProgram.created)).replace('{skipped}', String(summary.sampleProgram.skipped))}
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}
