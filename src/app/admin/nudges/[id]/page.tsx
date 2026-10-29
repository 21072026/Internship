'use client';

// One nudge rule (#1686): edit it, dry-run the audience (who it would reach
// right now and who the limits leave out — nothing is sent), switch it on or
// off (an audited action), and see what it sent.
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import { NudgeEditor, NudgeGuardrails, useEventLabel, type NudgeDraft, type NudgeOptions } from '@/components/admin/NudgeEditor';

interface Preview {
  matched: number;
  count: number;
  sample: { name: string | null; role: 'MENTOR' | 'MENTEE' }[];
  dropped: Record<'unsubscribed' | 'cap' | 'cooldown' | 'dormancy' | 'outcome' | 'already_sent', number>;
  truncated: boolean;
}
interface Send { id: string; recipient: string | null; sentAt: string; channel: string; status: 'SENT' | 'HELD' | 'SKIPPED'; event: string | null }

const DROP_LABEL = {
  unsubscribed: 'dropUnsubscribed',
  cap: 'dropCap',
  cooldown: 'dropCooldown',
  dormancy: 'dropDormancy',
  outcome: 'dropOutcome',
  already_sent: 'dropAlreadySent',
} as const;

function toDraft(r: Record<string, unknown>): NudgeDraft {
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  return {
    name: s('name'),
    enabled: r.enabled === true,
    trigger: (r.trigger as NudgeDraft['trigger']) ?? { kind: 'scan' },
    segment: (r.segment as NudgeDraft['segment']) ?? { conditions: [] },
    delayMinutes: Number(r.delayMinutes) || 0,
    channel: (r.channel as NudgeDraft['channel']) ?? 'EMAIL',
    subjectEn: s('subjectEn'), subjectTr: s('subjectTr'), subjectDe: s('subjectDe'),
    bodyEn: s('bodyEn'), bodyTr: s('bodyTr'), bodyDe: s('bodyDe'),
    maxPerUserPer30Days: Number(r.maxPerUserPer30Days) || 2,
    cooldownDays: Number(r.cooldownDays ?? 7),
  };
}

export default function NudgeRulePage() {
  const t = useT();
  const router = useRouter();
  const eventLabel = useEventLabel();
  const { id } = useParams<{ id: string }>();
  const [draft, setDraft] = useState<NudgeDraft | null>(null);
  const [options, setOptions] = useState<NudgeOptions | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sends, setSends] = useState<Send[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    const [r, list, s] = await Promise.all([
      fetch(`/api/admin/nudges/${encodeURIComponent(id)}`),
      fetch('/api/admin/nudges'),
      fetch(`/api/admin/nudges/${encodeURIComponent(id)}/sends`),
    ]);
    if (!r.ok) { setNotFound(true); return; }
    setDraft(toDraft((await r.json()).rule));
    if (list.ok) setOptions((await list.json()).options ?? null);
    if (s.ok) setSends((await s.json()).sends ?? []);
    setVersion((v) => v + 1);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const runPreview = async () => {
    const res = await fetch(`/api/admin/nudges/${encodeURIComponent(id)}/preview`, { method: 'POST' });
    if (res.ok) setPreview(await res.json());
  };

  const toggle = async () => {
    if (!draft) return;
    if (!draft.enabled && !confirm(t.nudges.enableConfirm)) return;
    const res = await fetch(`/api/admin/nudges/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !draft.enabled }),
    });
    if (res.ok) await load();
  };

  const remove = async () => {
    if (!confirm(t.nudges.deleteConfirm)) return;
    const res = await fetch(`/api/admin/nudges/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) router.push('/admin/nudges');
  };

  if (notFound) return <p className="text-sm text-gray-500"><Link href="/admin/nudges" className="text-blue-600 hover:underline">{t.nudges.back}</Link></p>;
  if (!draft || !options) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/admin/nudges" className="text-sm text-blue-600 hover:underline">← {t.nudges.back}</Link>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {draft.name}{' '}
            <Badge variant={draft.enabled ? 'success' : 'default'} data-testid="nudge-status">{draft.enabled ? t.nudges.on : t.nudges.off}</Badge>
          </h1>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant={draft.enabled ? 'secondary' : 'primary'} onClick={() => void toggle()} data-testid="nudge-toggle">
            {draft.enabled ? t.nudges.disable : t.nudges.enable}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void remove()} data-testid="nudge-delete">{t.nudges.delete}</Button>
        </div>
      </div>
      <NudgeGuardrails />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <NudgeEditor key={version} initial={draft} options={options} ruleId={id} onSaved={() => void load()} />
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>{t.nudges.preview}</CardTitle></CardHeader>
            <Button size="sm" variant="secondary" onClick={() => void runPreview()} data-testid="nudge-preview">{t.nudges.previewRun}</Button>
            {preview && (
              <div className="mt-3 space-y-2 text-sm" data-testid="nudge-preview-result">
                <p className="font-medium" data-testid="nudge-preview-count">{t.nudges.previewCount.replace('{n}', String(preview.count))}</p>
                <p className="text-gray-500">{t.nudges.previewMatched.replace('{n}', String(preview.matched))}</p>
                {preview.truncated && <p className="text-amber-700">{t.nudges.previewTruncated}</p>}
                {preview.sample.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-600 dark:text-gray-300">{t.nudges.previewSample}</p>
                    <ul className="list-disc pl-5" data-testid="nudge-preview-sample">
                      {preview.sample.map((p, i) => <li key={i}>{p.name ?? '—'} · {p.role === 'MENTOR' ? t.nudges.roleMENTOR : t.nudges.roleMENTEE}</li>)}
                    </ul>
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold text-gray-600 dark:text-gray-300">{t.nudges.previewDropped}</p>
                  <ul className="pl-1" data-testid="nudge-preview-dropped">
                    {(Object.keys(DROP_LABEL) as (keyof typeof DROP_LABEL)[]).map((k) => (
                      <li key={k} data-testid={`nudge-drop-${k}`}>{t.nudges[DROP_LABEL[k]]}: {preview.dropped[k] ?? 0}</li>
                    ))}
                  </ul>
                </div>
                <p className="text-xs text-gray-500">{t.nudges.previewNothingSent}</p>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>{t.nudges.history}</CardTitle></CardHeader>
            {!sends || sends.length === 0 ? (
              <p className="text-sm text-gray-400">{t.nudges.historyEmpty}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="nudge-history">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400">
                      <th className="py-1 pr-3 font-medium">{t.nudges.colRecipient}</th>
                      <th className="py-1 pr-3 font-medium">{t.nudges.colSentAt}</th>
                      <th className="py-1 pr-3 font-medium">{t.nudges.colChannel}</th>
                      <th className="py-1 font-medium">{t.nudges.colEvent}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {sends.map((s) => (
                      <tr key={s.id}>
                        <td className="py-1 pr-3">{s.recipient ?? '—'} <span className="text-xs text-gray-500">({t.nudges[`status${s.status}`]})</span></td>
                        <td className="py-1 pr-3"><RelativeTime date={s.sentAt} /></td>
                        <td className="py-1 pr-3">{t.nudges[`channel${s.channel as 'EMAIL' | 'IN_APP' | 'BOTH'}`]}</td>
                        <td className="py-1">{s.event ? eventLabel(s.event) : t.nudges.triggerScan}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
