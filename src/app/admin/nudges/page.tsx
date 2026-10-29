'use client';

// /admin/nudges (#1686): the org's nudge rules — on/off, trigger, sends in the
// last 30 days, last scan — and a new-rule form. A rule is created switched
// off; it is switched on from its own page, after a dry run.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import { EMPTY_NUDGE, NudgeEditor, NudgeGuardrails, useEventLabel, type NudgeOptions } from '@/components/admin/NudgeEditor';

interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { kind: 'scan' } | { kind: 'event'; event: string } | null;
  lastEvaluatedAt: string | null;
  sentLast30Days: number;
  missingLocales: string[];
}

export default function NudgesPage() {
  const t = useT();
  const router = useRouter();
  const eventLabel = useEventLabel();
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [options, setOptions] = useState<NudgeOptions | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/nudges');
    if (!res.ok) { setRules([]); return; }
    const d = await res.json();
    setRules(d.rules ?? []);
    setOptions(d.options ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.nudges.title}</h1>
        <p className="mt-1 text-gray-500">{t.nudges.subtitle}</p>
      </div>
      <NudgeGuardrails />

      <Card>
        <div className="flex items-center justify-between">
          <CardHeader><CardTitle>{t.nudges.title}</CardTitle></CardHeader>
          {!creating && <Button size="sm" onClick={() => setCreating(true)} data-testid="nudge-new">{t.nudges.newRule}</Button>}
        </div>
        {creating && options && (
          <div className="mb-6 border-b border-gray-100 pb-6 dark:border-gray-800">
            <NudgeEditor initial={EMPTY_NUDGE} options={options} onSaved={(id) => router.push(`/admin/nudges/${id}`)} />
          </div>
        )}
        {rules === null ? null : rules.length === 0 ? (
          <p className="text-sm text-gray-400">{t.nudges.noRules}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="nudge-list">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400">
                  <th className="py-1 pr-3 font-medium">{t.nudges.colName}</th>
                  <th className="py-1 pr-3 font-medium">{t.nudges.colTrigger}</th>
                  <th className="py-1 pr-3 font-medium">{t.nudges.colStatus}</th>
                  <th className="py-1 pr-3 font-medium">{t.nudges.colSent30}</th>
                  <th className="py-1 font-medium">{t.nudges.colLastRun}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {rules.map((r) => (
                  <tr key={r.id} data-testid={`nudge-row-${r.id}`}>
                    <td className="py-2 pr-3"><Link href={`/admin/nudges/${r.id}`} className="text-blue-600 hover:underline">{r.name}</Link></td>
                    <td className="py-2 pr-3">
                      {r.trigger?.kind === 'event' ? `${t.nudges.triggerEventPrefix} ${eventLabel(r.trigger.event)}` : t.nudges.triggerScan}
                    </td>
                    <td className="py-2 pr-3"><Badge variant={r.enabled ? 'success' : 'default'}>{r.enabled ? t.nudges.on : t.nudges.off}</Badge></td>
                    <td className="py-2 pr-3">{r.sentLast30Days}</td>
                    <td className="py-2">{r.lastEvaluatedAt ? <RelativeTime date={r.lastEvaluatedAt} /> : t.nudges.never}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
