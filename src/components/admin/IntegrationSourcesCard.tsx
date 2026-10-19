'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

// The registered integration sources on /admin/integrations (#2978): per source
// the on/off switch, the IP allowlist, the request-signing secret (generate,
// rotate, switch off — the secret is shown once, in the banner, and never
// again) and when the last event arrived. Talks to
// /api/admin/integration-sources; registering a source stays with the operator
// CLI, so an organization without one sees nothing here at all. The contract a
// sender programs against is docs/integrations/account-events.md § Security.

interface SourceRow {
  id: string;
  slug: string;
  label: string;
  enabled: boolean;
  boundToKey: boolean;
  allowedIps: string[];
  signing: { enabled: boolean; rotatedAt: string | null; previousValidUntil: string | null };
  lastEventAt: string | null;
}

export function IntegrationSourcesCard() {
  const t = useT();
  const s = t.integrationSources;
  const locale = useLocale();
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, { kind: 'ok' | 'error'; text: string }>>({});
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const replace = (row: SourceRow) => setSources((list) => list.map((r) => (r.id === row.id ? row : r)));

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/integration-sources');
    if (!res.ok) return;
    const list: SourceRow[] = (await res.json()).sources ?? [];
    setSources(list);
    setDrafts(Object.fromEntries(list.map((r) => [r.id, r.allowedIps.join('\n')])));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (sources.length === 0) return null;

  const patch = async (row: SourceRow, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/integration-sources/${row.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.source) {
      replace(d.source);
      if ('allowedIps' in body) {
        setDrafts((p) => ({ ...p, [row.id]: (d.source as SourceRow).allowedIps.join('\n') }));
        setNotes((p) => ({ ...p, [row.id]: { kind: 'ok', text: s.ipsSaved } }));
      }
    } else if (d.code === 'invalid_allowed_ips') {
      const list = (d.errors as { value: string }[] | undefined)?.map((e) => e.value).join(', ') ?? '';
      setNotes((p) => ({ ...p, [row.id]: { kind: 'error', text: s.ipsInvalid.replace('{list}', list) } }));
    }
  };

  const rotate = async (row: SourceRow) => {
    if (row.signing.enabled && !confirm(s.rotateConfirm)) return;
    const res = await fetch(`/api/admin/integration-sources/${row.id}/signing-secret`, { method: 'POST' });
    // 409: another rotation won the race and its secret is the live one — show
    // the fresh state rather than a secret that was never stored.
    if (res.status === 409) { await load(); return; }
    if (!res.ok) return;
    const d = await res.json();
    setCopied(false);
    setSecret({ id: row.id, value: d.secret });
    replace(d.source);
  };

  const disableSigning = async (row: SourceRow) => {
    if (!confirm(s.disableSigningConfirm)) return;
    const res = await fetch(`/api/admin/integration-sources/${row.id}/signing-secret`, { method: 'DELETE' });
    if (!res.ok) return;
    if (secret?.id === row.id) setSecret(null);
    replace((await res.json()).source);
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Card data-testid="integration-sources" className="lg:col-span-2">
      <CardHeader><CardTitle>{s.title}</CardTitle></CardHeader>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{s.desc}</p>
      {secret && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" data-testid="integration-source-secret">
          <p className="mb-1">{s.secretOnce}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all" data-testid="integration-source-secret-value">{secret.value}</code>
            <Button size="sm" variant="secondary" onClick={copy} data-testid="integration-source-secret-copy">
              {copied ? s.copied : s.copy}
            </Button>
          </div>
        </div>
      )}
      <div className="divide-y divide-gray-50 dark:divide-gray-800">
        {sources.map((row) => (
          <div key={row.id} className="py-3 text-sm" data-testid={`integration-source-${row.slug}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-gray-900 dark:text-gray-100">
                  <span className="font-medium">{row.label}</span>
                  <code className="text-xs text-gray-500 dark:text-gray-400">{row.slug}</code>
                  <Badge variant={row.enabled ? 'success' : 'default'} data-testid={`integration-source-state-${row.slug}`}>
                    {row.enabled ? s.on : s.off}
                  </Badge>
                  {row.boundToKey && <Badge variant="default">{s.boundToKey}</Badge>}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`integration-source-last-${row.slug}`}>
                  {row.lastEventAt ? <>{s.lastEvent}: <RelativeTime date={row.lastEventAt} /></> : s.noEventYet}
                </p>
                {!row.enabled && <p className="text-xs text-gray-500 dark:text-gray-400">{s.offHint}</p>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => patch(row, { enabled: !row.enabled })} data-testid={`integration-source-toggle-${row.slug}`}>
                {row.enabled ? s.switchOff : s.switchOn}
              </Button>
            </div>

            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor={`allowed-ips-${row.id}`} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {s.allowedIps}
                </label>
                <Textarea
                  id={`allowed-ips-${row.id}`}
                  rows={3}
                  value={drafts[row.id] ?? ''}
                  placeholder={s.allowedIpsPlaceholder}
                  onChange={(e) => setDrafts((p) => ({ ...p, [row.id]: e.target.value }))}
                  data-testid={`integration-source-ips-${row.slug}`}
                />
                <p className="text-xs text-gray-400 mt-1">{row.allowedIps.length ? s.allowedIpsHint : s.allowedIpsAny}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => patch(row, { allowedIps: drafts[row.id] ?? '' })} data-testid={`integration-source-ips-save-${row.slug}`}>
                    {s.saveIps}
                  </Button>
                  {notes[row.id] && (
                    <span
                      role={notes[row.id].kind === 'error' ? 'alert' : 'status'}
                      className={notes[row.id].kind === 'error' ? 'text-xs text-red-600 dark:text-red-400' : 'text-xs text-green-700 dark:text-green-300'}
                      data-testid={`integration-source-ips-note-${row.slug}`}
                    >
                      {notes[row.id].text}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{s.signing}</p>
                <p className="text-xs text-gray-600 dark:text-gray-300" data-testid={`integration-source-signing-${row.slug}`}>
                  {row.signing.enabled ? s.signingOn : s.signingOff}
                </p>
                {row.signing.rotatedAt && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">{s.secretGenerated}: <RelativeTime date={row.signing.rotatedAt} /></p>
                )}
                {row.signing.previousValidUntil && (
                  <p className="text-xs text-amber-700 dark:text-amber-300" data-testid={`integration-source-previous-${row.slug}`}>
                    {s.previousUntil.replace('{when}', formatDateTime(row.signing.previousValidUntil, locale))}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => rotate(row)} data-testid={`integration-source-rotate-${row.slug}`}>
                    {row.signing.enabled ? s.rotateSecret : s.generateSecret}
                  </Button>
                  {row.signing.enabled && (
                    <Button size="sm" variant="ghost" onClick={() => disableSigning(row)} data-testid={`integration-source-signing-off-${row.slug}`}>
                      {s.disableSigning}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">{s.signingHint}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
