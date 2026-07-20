'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Copy, Check, Video } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

interface Meeting {
  id: string;
  relationId: string;
  title: string;
  scheduledAt: string | null;
  meetLink?: string | null;
}

// Schedule a meeting for one mentorship relation, straight from the candidate
// detail screen (#661). Reuses the role-aware /api/meetings endpoint (admins may
// schedule for any relation; a video link auto-generates server-side) and lists
// this relation's meetings with a one-click copyable link.
export function MeetingSchedulerPanel({ relationId }: { relationId: string }) {
  const t = useT();
  const locale = useLocale();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [meetLink, setMeetLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Time optional: a date gives the meeting a time (+ RSVP); no date → no-time
  // meeting (just a link).
  const scheduledAt = date ? `${date}T${time || '00:00'}` : '';

  const load = useCallback(async () => {
    const r = await fetch('/api/meetings');
    if (r.ok) {
      const all: Meeting[] = (await r.json()).meetings ?? [];
      setMeetings(all.filter((m) => m.relationId === relationId));
    }
  }, [relationId]);

  useEffect(() => {
    load();
  }, [load]);

  const copyLink = async (m: Meeting) => {
    if (!m.meetLink) return;
    try {
      await navigator.clipboard.writeText(m.meetLink);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1800);
    } catch {
      window.prompt(t.meetings.copyLink, m.meetLink);
    }
  };

  const schedule = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationIds: [relationId], title, scheduledAt, meetLink }),
      });
      if (res.ok) {
        setTitle('');
        setDate('');
        setTime('');
        setMeetLink('');
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Video className="h-5 w-5 text-blue-600" />
          <CardTitle>{t.meetings.schedule}</CardTitle>
        </div>
      </CardHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
        <div className="sm:col-span-2">
          <Input label={t.meetings.meetingTitle} value={title} onChange={(e) => setTitle(e.target.value)} list="cand-meeting-topics" />
          <datalist id="cand-meeting-topics">
            {(t.meetings.topics as string[]).map((topic) => <option key={topic} value={topic} />)}
          </datalist>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t.meetings.date}</label>
          <input type="date" aria-label={t.meetings.date} value={date} onChange={(e) => setDate(e.target.value)} className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t.meetings.time}</label>
          <input type="time" aria-label={t.meetings.time} value={time} onChange={(e) => setTime(e.target.value)} className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm" />
        </div>
        <div className="sm:col-span-2">
          <Input label={t.meetings.meetLink} placeholder="https://meet.google.com/abc-defg-hij" hint={t.meetings.meetLinkHint} value={meetLink} onChange={(e) => setMeetLink(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <Button onClick={schedule} loading={busy} disabled={!title}>
            {t.meetings.sendInvite}
          </Button>
        </div>
      </div>

      {meetings.length > 0 && (
        <div className="mt-4 divide-y divide-gray-50 dark:divide-gray-800 border-t border-gray-100 dark:border-gray-800 pt-2">
          {meetings.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{m.title}</p>
                <p className="text-xs text-gray-500">{m.scheduledAt ? formatDateTime(m.scheduledAt, locale) : t.meetings.noTime}</p>
                {m.meetLink && (
                  <a href={m.meetLink} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate block max-w-[18rem]">
                    {m.meetLink}
                  </a>
                )}
              </div>
              {m.meetLink && (
                <Button variant="outline" size="sm" onClick={() => copyLink(m)} aria-label={t.meetings.copyLink}>
                  {copiedId === m.id ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedId === m.id ? t.meetings.linkCopied : t.meetings.copyLink}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
