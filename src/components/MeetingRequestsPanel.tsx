'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT, useLocale } from '@/i18n/client';

interface MReq {
  id: string;
  topic: string;
  proposedAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
}

// mode='request' → the mentee proposes meetings + sees status.
// mode='manage'  → the mentor accepts/declines pending requests.
export function MeetingRequestsPanel({ relationId, mode }: { relationId: string; mode: 'request' | 'manage' }) {
  const t = useT();
  const locale = useLocale();
  const [reqs, setReqs] = useState<MReq[]>([]);
  const [topic, setTopic] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/meeting-requests?relationId=${relationId}`);
    if (res.ok) setReqs((await res.json()).requests ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || !when) return;
    setBusy(true);
    try {
      const res = await fetch('/api/meeting-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, topic, proposedAt: new Date(when).toISOString() }),
      });
      if (res.ok) { setTopic(''); setWhen(''); await load(); }
    } finally {
      setBusy(false);
    }
  };

  const handle = async (id: string, action: 'accept' | 'decline') => {
    setBusy(true);
    try {
      await fetch(`/api/meeting-requests/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (s: string) => (t.portal.meetingRequests.status as Record<string, string>)[s] ?? s;
  const variant = (s: string) => (s === 'ACCEPTED' ? 'success' : s === 'DECLINED' ? 'danger' : 'warning');
  const pending = reqs.filter((r) => r.status === 'PENDING');
  const list = mode === 'manage' ? pending : reqs;

  return (
    <Card>
      <CardHeader><CardTitle>{mode === 'manage' ? t.portal.meetingRequests.titleManage : t.portal.meetingRequests.title}</CardTitle></CardHeader>

      {mode === 'request' && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2 mb-4">
          <div className="flex-1 min-w-[160px]"><Input label={t.portal.meetingRequests.topic} value={topic} onChange={(e) => setTopic(e.target.value)} /></div>
          <div className="min-w-[180px]"><Input label={t.portal.meetingRequests.when} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
          <Button type="submit" size="sm" loading={busy} disabled={!topic.trim() || !when}>{t.portal.meetingRequests.request}</Button>
        </form>
      )}

      {list.length === 0 ? (
        <p className="text-sm text-gray-400">{mode === 'manage' ? t.portal.meetingRequests.noneManage : t.portal.meetingRequests.none}</p>
      ) : (
        <div className="space-y-2">
          {list.map((r) => (
            <div key={r.id} data-testid={`mreq-${r.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 p-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{r.topic}</p>
                <p className="text-xs text-gray-400">{new Date(r.proposedAt).toLocaleString(locale)}</p>
              </div>
              {mode === 'manage' ? (
                <div className="flex gap-2 flex-shrink-0">
                  <Button size="sm" loading={busy} onClick={() => handle(r.id, 'accept')}>{t.portal.meetingRequests.accept}</Button>
                  <Button size="sm" variant="outline" loading={busy} onClick={() => handle(r.id, 'decline')}>{t.portal.meetingRequests.decline}</Button>
                </div>
              ) : (
                <Badge variant={variant(r.status)}>{statusLabel(r.status)}</Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
