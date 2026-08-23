'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Video, CalendarPlus, Check, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT, useLocale } from '@/i18n/client';

// "When is my meeting, what's the link?" answered on the mentee's first screen
// (#914). Read path: GET /api/meetings (opened to MENTEE in #913 — the API
// only ever returns the caller's own relations' meetings). RSVP reuses the
// existing token endpoint: the mentee's own rows carry their rsvpToken (the
// same credential their invite e-mail holds), so no new write path and no
// widened auth. Loading, empty and error are three separate states (#861).

interface Meeting {
  id: string;
  title: string;
  scheduledAt: string | null;
  meetLink: string | null;
  rsvp: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  rsvpToken: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function UpcomingMeetings() {
  const t = useT();
  const locale = useLocale();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/meetings');
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setMeetings((d.meetings ?? []) as Meeting[]);
    } catch {
      setFailed(true);
      setMeetings([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rsvp = async (m: Meeting, response: 'yes' | 'no') => {
    setAnswering(m.id);
    try {
      const res = await fetch('/api/rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: m.rsvpToken, response }),
      });
      if (res.ok) {
        const d = await res.json();
        setMeetings((prev) => (prev ?? []).map((x) => (x.id === m.id ? { ...x, rsvp: d.rsvp } : x)));
      }
    } finally {
      setAnswering(null);
    }
  };

  // Upcoming = scheduled and not more than an hour in the past (a running
  // meeting still matters); link-only meetings (no time) are listed after.
  const now = Date.now();
  const upcoming = (meetings ?? [])
    .filter((m) => m.scheduledAt && new Date(m.scheduledAt).getTime() >= now - HOUR_MS)
    .sort((a, b) => (a.scheduledAt! < b.scheduledAt! ? -1 : 1))
    .slice(0, 5);
  const linkOnly = (meetings ?? []).filter((m) => !m.scheduledAt && m.meetLink).slice(0, 3);

  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <Card className="mb-6" data-testid="upcoming-meetings-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Video className="h-5 w-5 text-blue-600" />
          <CardTitle>{t.portal.meetings.title}</CardTitle>
        </div>
      </CardHeader>

      {/* Loading ≠ empty (#891): no "no meetings" while the fetch is in flight. */}
      {meetings === null ? (
        <p className="py-4 text-sm text-gray-400" data-testid="upcoming-meetings-loading">{t.common.loading}</p>
      ) : failed ? (
        <p className="py-4 text-sm text-red-500">{t.common.error}</p>
      ) : upcoming.length === 0 && linkOnly.length === 0 ? (
        <div className="py-4" data-testid="upcoming-meetings-empty">
          <p className="text-sm text-gray-500">{t.portal.meetings.empty}</p>
          <Link href="/portal/requests" className="mt-1 inline-block text-sm text-blue-600 hover:underline">
            {t.portal.meetings.emptyCta}
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {upcoming.map((m) => (
            <li key={m.id} className="rounded-xl border border-gray-100 dark:border-gray-800 p-3" data-testid={`upcoming-meeting-${m.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-900 dark:text-gray-100">{m.title}</p>
                  <p className="text-sm text-gray-500 tabular-nums">{when(m.scheduledAt!)}</p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    m.rsvp === 'ACCEPTED'
                      ? 'bg-green-100 text-green-700'
                      : m.rsvp === 'DECLINED'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {t.portal.meetings.rsvp[m.rsvp]}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {m.meetLink && (
                  <a
                    href={m.meetLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                  >
                    <Video className="h-4 w-4" />
                    {t.portal.meetings.join}
                  </a>
                )}
                <a
                  href={`/api/calendar/${m.rsvpToken}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <CalendarPlus className="h-4 w-4" />
                  {t.portal.meetings.addToCalendar}
                </a>
                {m.rsvp !== 'ACCEPTED' && (
                  <button
                    type="button"
                    disabled={answering === m.id}
                    onClick={() => rsvp(m, 'yes')}
                    data-testid={`rsvp-yes-${m.id}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-green-200 px-3 py-1.5 text-sm text-green-700 hover:bg-green-50 disabled:opacity-50"
                  >
                    <Check className="h-4 w-4" />
                    {t.portal.meetings.accept}
                  </button>
                )}
                {m.rsvp !== 'DECLINED' && (
                  <button
                    type="button"
                    disabled={answering === m.id}
                    onClick={() => rsvp(m, 'no')}
                    data-testid={`rsvp-no-${m.id}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    <X className="h-4 w-4" />
                    {t.portal.meetings.decline}
                  </button>
                )}
              </div>
            </li>
          ))}
          {/* No-time meetings: just a shared room link — no RSVP, no calendar file. */}
          {linkOnly.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-3" data-testid={`upcoming-meeting-${m.id}`}>
              <div className="min-w-0">
                <p className="truncate font-medium text-gray-900 dark:text-gray-100">{m.title}</p>
                <p className="text-xs text-gray-400">{t.portal.meetings.linkOnly}</p>
              </div>
              <a
                href={m.meetLink!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
              >
                <Video className="h-4 w-4" />
                {t.portal.meetings.join}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
