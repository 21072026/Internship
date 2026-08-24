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

interface StageRow {
  key: string;
  label: string;
  isOffPath: boolean;
  isTerminal: boolean;
  days: number | null;
}

export function StageSlaEditor() {
  const t = useT();
  const [rows, setRows] = useState<StageRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/stage-sla');
    if (res.ok) setRows((await res.json()).stages ?? []);
  }, []);
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
        body: JSON.stringify({ slas: rows.map((r) => ({ stageKey: r.key, days: r.days })) }),
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
      {flash && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{flash}</div>}
      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      <div className="space-y-2" data-testid="stage-sla-rows">
        {rows.map((r, i) => (
          <div key={r.key} className="flex items-center gap-3 text-sm">
            <span className="flex-1 truncate text-gray-700 dark:text-gray-300">
              {r.label}
              {r.isOffPath && <span className="ml-2 text-xs text-gray-400">({t.stageSla.offPath})</span>}
            </span>
            <input
              type="number"
              min={0}
              max={365}
              value={r.days ?? ''}
              placeholder={t.stageSla.noRule}
              aria-label={`${r.label} — ${t.stageSla.days}`}
              data-testid={`sla-${r.key}`}
              onChange={(e) => {
                const v = e.target.value.trim();
                const days = v === '' ? null : Number(v);
                setRows((p) => p.map((row, j) => (j === i ? { ...row, days } : row)));
              }}
              className="w-24 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
            />
            <span className="w-10 text-xs text-gray-400">{t.stageSla.days}</span>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <Button size="sm" loading={saving} onClick={save} data-testid="stage-sla-save">
          {t.common.save}
        </Button>
      </div>
      <p className="mt-3 text-xs text-gray-500">{t.stageSla.calendarDays}</p>
      <p className="mt-1 text-xs text-gray-500">{t.stageSla.appliesOnMove}</p>
    </Card>
  );
}
