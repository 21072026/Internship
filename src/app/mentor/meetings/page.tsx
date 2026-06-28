'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

interface Relation {
  id: string;
  mentee: { fullName: string };
}
interface Meeting {
  id: string;
  title: string;
  scheduledAt: string;
  meetLink?: string | null;
  rsvp: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  relation: { mentee: { fullName: string } };
}

const RSVP_VARIANT = { PENDING: 'warning', ACCEPTED: 'success', DECLINED: 'danger' } as const;

export default function MentorMeetingsPage() {
  const t = useT();
  const [relations, setRelations] = useState<Relation[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [title, setTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [meetLink, setMeetLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r1, r2] = await Promise.all([fetch('/api/mentorship'), fetch('/api/meetings')]);
    setRelations((await r1.json()).relations ?? []);
    setMeetings((await r2.json()).meetings ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chosen = relations.filter((r) => selected[r.id]).map((r) => r.id);

  const schedule = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationIds: chosen, title, scheduledAt, meetLink }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(t.meetings.scheduledCount.replace('{n}', String(data.created)));
        setTitle('');
        setScheduledAt('');
        setMeetLink('');
        setSelected({});
        await load();
      } else {
        setResult(data.error || 'Failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.meetings.title}</h1>
        <p className="text-gray-500 mt-1">{t.meetings.subtitle}</p>
      </div>

      {result && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{result}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t.meetings.schedule} ({chosen.length})</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div className="max-h-40 overflow-y-auto border border-gray-100 rounded-lg p-2">
              {relations.length === 0 ? (
                <p className="text-sm text-gray-400">{t.mentor.noMenteesAssigned}</p>
              ) : (
                relations.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={!!selected[r.id]}
                      onChange={(e) => setSelected((p) => ({ ...p, [r.id]: e.target.checked }))}
                    />
                    <span className="truncate">{r.mentee.fullName}</span>
                  </label>
                ))
              )}
            </div>
            <Input label={t.meetings.meetingTitle} value={title} onChange={(e) => setTitle(e.target.value)} />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.meetings.when}</label>
              <input
                type="datetime-local"
                aria-label={t.meetings.when}
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm"
              />
            </div>
            <Input
              label={t.meetings.meetLink}
              placeholder="https://meet.google.com/abc-defg-hij"
              value={meetLink}
              onChange={(e) => setMeetLink(e.target.value)}
            />
            <Button onClick={schedule} loading={busy} disabled={chosen.length === 0 || !title || !scheduledAt}>
              {t.meetings.sendInvite}
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.meetings.upcoming} ({meetings.length})</CardTitle>
          </CardHeader>
          {meetings.length === 0 ? (
            <p className="text-sm text-gray-400">{t.meetings.none}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {meetings.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{m.title}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {m.relation.mentee.fullName} · {new Date(m.scheduledAt).toLocaleString()}
                    </p>
                  </div>
                  <Badge variant={RSVP_VARIANT[m.rsvp]}>{t.meetings[m.rsvp.toLowerCase() as 'pending' | 'accepted' | 'declined']}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
