'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import type { AuditDrainFormat } from '@/lib/auditDrainRule';

// Type-only import above: auditDrainRule.ts imports node:crypto for the
// signature, which has no place in a client bundle. The catalogue is repeated
// here as a literal and pinned to the rule's type, so a format added there
// without being added here fails to compile.
const FORMATS: readonly AuditDrainFormat[] = ['json_lines', 'ecs'];

// The audit stream's console (#2012) on /admin/integrations: add a receiver,
// see where each one has streamed up to, pause/resume, send a synthetic test
// batch, rotate the secret, delete. Talks to /api/admin/audit-drains; the
// contract a receiver programs against is docs/audit-stream.md.

interface Drain {
  id: string;
  url: string;
  format: string;
  active: boolean;
  cursorAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
  createdAt: string;
}

export function AuditDrainsCard({ onLocked }: { onLocked?: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [drains, setDrains] = useState<Drain[]>([]);
  const [auditRows, setAuditRows] = useState<number | null>(null);
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<AuditDrainFormat>('json_lines');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/audit-drains');
    if (!res.ok) return;
    const d = await res.json();
    setDrains(d.drains ?? []);
    setAuditRows(typeof d.auditRows === 'number' ? d.auditRows : null);
  }, []);
  useEffect(() => { load(); }, [load]);

  const noteLocked = async (res: Response) => {
    if (res.status !== 403) return;
    const d = await res.clone().json().catch(() => ({}));
    if (d.code === 'feature_locked') onLocked?.();
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    setBusy(true);
    setError('');
    const res = await fetch('/api/admin/audit-drains', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, format }),
    });
    setBusy(false);
    await noteLocked(res);
    if (res.ok) {
      const d = await res.json();
      setSecret(d.secret);
      setUrl('');
      await load();
    } else if (res.status === 400) {
      setError(t.integrations.auditStreamUrlInvalid);
    }
  };
  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/audit-drains?id=${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await noteLocked(res);
    await load();
  };
  const remove = async (id: string) => {
    await fetch(`/api/admin/audit-drains?id=${id}`, { method: 'DELETE' });
    await load();
  };
  const rotate = async (id: string) => {
    if (!confirm(t.integrations.rotateSecretConfirm)) return;
    const res = await fetch(`/api/admin/audit-drains/rotate-secret?id=${id}`, { method: 'POST' });
    if (res.ok) setSecret((await res.json()).secret);
  };
  const sendTest = async (id: string) => {
    const res = await fetch(`/api/admin/audit-drains/test?id=${id}`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    const message = res.status === 429
      ? t.integrations.auditStreamTestRateLimited
      : d.ok
        ? t.integrations.auditStreamTestOk.replace('{status}', String(d.status))
        : t.integrations.auditStreamTestFailed.replace('{error}', String(d.error ?? ''));
    setTestResult((p) => ({ ...p, [id]: message }));
    await load();
  };

  const formatLabel = (f: string) => (f === 'ecs' ? t.integrations.auditStreamFormatEcs : t.integrations.auditStreamFormatJson);

  return (
    <Card data-testid="audit-drains">
      <CardHeader><CardTitle>{t.integrations.auditStream}</CardTitle></CardHeader>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">{t.integrations.auditStreamDesc}</p>
      {auditRows !== null && (
        <p className="text-xs text-gray-400 mb-3" data-testid="audit-drains-rows">
          {t.integrations.auditStreamRows.replace('{n}', String(auditRows))}
        </p>
      )}
      {secret && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 break-all" data-testid="audit-drain-secret">
          {t.integrations.auditStreamSecretOnce}: <code>{secret}</code>
        </div>
      )}
      <form onSubmit={add} className="space-y-2 mb-4" data-testid="audit-drain-form">
        <Input
          placeholder={t.integrations.auditStreamUrlPlaceholder}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          data-testid="audit-drain-url"
        />
        <Select
          aria-label={t.integrations.auditStreamFormat}
          value={format}
          onChange={(e) => setFormat(e.target.value as AuditDrainFormat)}
          options={FORMATS.map((f) => ({ value: f, label: formatLabel(f) }))}
          data-testid="audit-drain-format"
        />
        {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400" data-testid="audit-drain-error">{error}</p>}
        <Button type="submit" size="sm" disabled={!url || busy} data-testid="audit-drain-add">{t.integrations.auditStreamAdd}</Button>
      </form>
      {drains.length === 0 ? (
        <p className="text-sm text-gray-400" data-testid="audit-drains-empty">{t.integrations.auditStreamNone}</p>
      ) : (
        <div className="divide-y divide-gray-50 dark:divide-gray-800" data-testid="audit-drain-list">
          {drains.map((d) => {
            const pausedAuto = !d.active && d.failures > 0;
            return (
              <div key={d.id} className="py-2 text-sm" data-testid={`audit-drain-${d.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-gray-900 dark:text-gray-100">
                      {d.url}
                      {!d.active && (
                        <Badge variant={pausedAuto ? 'danger' : 'default'} className="ml-2" data-testid={`audit-drain-state-${d.id}`}>
                          {t.integrations.paused}
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-gray-400">
                      {formatLabel(d.format)}
                      {' · '}
                      {d.cursorAt
                        ? <>{t.integrations.auditStreamCursor}: {formatDateTime(d.cursorAt, locale)}</>
                        : t.integrations.auditStreamNothingYet}
                      {d.lastOkAt && <> · {t.integrations.lastOk}: <RelativeTime date={d.lastOkAt} /></>}
                    </p>
                    {d.failures > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-300" data-testid={`audit-drain-failures-${d.id}`}>
                        {t.integrations.auditStreamFailures.replace('{n}', String(d.failures))}
                        {d.nextAttemptAt && d.active && <> · {t.integrations.auditStreamNextAttempt}: {formatDateTime(d.nextAttemptAt, locale)}</>}
                      </p>
                    )}
                    {pausedAuto && <p className="text-xs text-red-600 dark:text-red-400">{t.integrations.auditStreamPausedAuto}</p>}
                    {d.lastError && <p className="text-xs text-red-600 dark:text-red-400 break-words" data-testid={`audit-drain-error-${d.id}`}>{d.lastError}</p>}
                    {testResult[d.id] && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5" data-testid={`audit-drain-test-result-${d.id}`}>{testResult[d.id]}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" data-testid={`audit-drain-pause-${d.id}`} onClick={() => patch(d.id, { active: !d.active })}>
                      {d.active ? t.integrations.pause : t.integrations.resume}
                    </Button>
                    <Button size="sm" variant="ghost" data-testid={`audit-drain-test-${d.id}`} onClick={() => sendTest(d.id)}>{t.integrations.auditStreamSendTest}</Button>
                    <Button size="sm" variant="ghost" onClick={() => rotate(d.id)}>{t.integrations.rotateSecret}</Button>
                    <button onClick={() => remove(d.id)} aria-label={t.common.delete} data-testid={`audit-drain-delete-${d.id}`} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-3">{t.integrations.auditStreamVerifyHint}</p>
    </Card>
  );
}
