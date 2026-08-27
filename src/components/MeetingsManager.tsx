'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Copy, Check } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { StartMeetingButton } from '@/components/meeting/StartMeetingButton';
import { browserTimeZone, wallClockToInstantISO } from '@/lib/timezone';
import { AttendeeTimes } from '@/components/meeting/AttendeeTimes';
import { useSearchParams } from 'next/navigation';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { GuestInviteField, type PendingGuest } from '@/components/meeting/GuestInviteField';
import { MeetingGuestList, type MeetingGuest } from '@/components/meeting/MeetingGuestList';
import { MAX_GUESTS_PER_MEETING } from '@/lib/meetingGuestLimits';
import { copyToClipboard } from '@/lib/clipboard';

interface Relation {
  id: string;
  // `timezone` is null for anyone who never saved one; AttendeeTimes falls back
  // to the deployment default for those, same as the emails do.
  mentee: { id: string; fullName: string; timezone?: string | null };
}
interface Meeting {
  id: string;
  title: string;
  scheduledAt: string | null;
  meetLink?: string | null;
  rsvp: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  relation: { mentee: { id: string; fullName: string } };
  // Present only on the row a bulk schedule attached its guests to (#1446) —
  // every other row of the batch has an empty list, which is correct: the
  // outsider was invited once, to the shared room.
  guests?: MeetingGuest[];
}

const RSVP_VARIANT = { PENDING: 'warning', ACCEPTED: 'success', DECLINED: 'danger' } as const;

// Shared meeting scheduler + list, used by both /mentor/meetings and
// /admin/meetings. The APIs it calls are role-aware: /api/mentorship and
// /api/meetings return the caller's own relations/meetings for a MENTOR and
// everything for an ADMIN, so the same component gives an admin full reach
// without any role branching here (#661).
export function MeetingsManager() {
  const t = useT();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const interviewRelationId = searchParams.get('relationId');
  const interviewRequestId = searchParams.get('interviewRequestId');
  const interviewRequisitionId = searchParams.get('requisitionId');
  const interviewRequisitionTitle = searchParams.get('requisitionTitle');
  const [relations, setRelations] = useState<Relation[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [meetLink, setMeetLink] = useState('');
  const [guests, setGuests] = useState<PendingGuest[]>([]);
  // Time is optional. With a date the meeting has a time (defaulting to
  // midnight if no clock time) and expects an RSVP; with no date it's a
  // no-time meeting (just a link, no RSVP).
  //
  // Sent as a zone-qualified instant, not the bare "2026-08-03T16:30" the inputs
  // produce: the server runs UTC and would have read that wall clock as UTC,
  // pushing the meeting forward by the organizer's offset (#1061).
  const scheduledAt = date ? wallClockToInstantISO(date, time || '00:00') : '';
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [r1, r2] = await Promise.all([fetch('/api/mentorship'), fetch('/api/meetings')]);
      if (!r1.ok || !r2.ok) throw new Error('Failed to load meetings data');

      const [relationsData, meetingsData] = await Promise.all([r1.json(), r2.json()]);
      setRelations(relationsData.relations ?? []);
      setMeetings(meetingsData.meetings ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!interviewRelationId || !relations.some((relation) => relation.id === interviewRelationId)) return;
    setSelected((current) => ({ ...current, [interviewRelationId]: true }));
  }, [interviewRelationId, relations]);

  useEffect(() => {
    if (!interviewRequisitionTitle) return;
    setTitle((current) => current || `${t.interviewRequests.interviewRequest}: ${interviewRequisitionTitle}`);
  }, [interviewRequisitionTitle, t.interviewRequests.interviewRequest]);

  const chosen = relations.filter((r) => selected[r.id]).map((r) => r.id);
  // The organizer is on the list too: a reading of the invitees' clocks is only
  // a confirmation if it can be compared against the one the time was typed on.
  const attendees = [
    { name: t.meetings.you, timezone: browserTimeZone() },
    ...relations.filter((r) => selected[r.id]).map((r) => ({ name: r.mentee.fullName, timezone: r.mentee.timezone })),
  ];

  const copyLink = async (m: Meeting) => {
   if (!m.meetLink) return;

   const didCopy = await copyToClipboard(m.meetLink);

   if (!didCopy) return;

   setCopiedId(m.id);
   setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1800);
  };

  const schedule = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `timeZone`: the clock the organizer typed the time on — their browser's,
        // which is what the date/time inputs are read in (#1210).
        body: JSON.stringify({
          relationIds: chosen,
          title,
          scheduledAt,
          meetLink,
          timeZone: browserTimeZone() ?? undefined,
          guests: guests.length > 0 ? guests : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Two counts, not one: "3 mentees" and "2 outsiders" are different
        // facts, and an organizer who typed an address needs to see it landed.
        const lines = [t.meetings.scheduledCount.replace('{n}', String(data.created))];
        if (data.guestsInvited > 0) {
          lines.push(t.meetings.guests.invited.replace('{n}', String(data.guestsInvited)));
        }
        // An address that turned out to belong to an account is not an error —
        // that person IS invited, just through the normal path. Say so, or the
        // organizer sees their guest silently vanish from the list.
        for (const email of (data.rejectedAsMembers ?? []) as string[]) {
          lines.push(t.meetings.guests.isMember.replace('{email}', email));
        }
        setResult(lines.join(' '));
        setTitle('');
        setDate('');
        setTime('');
        setMeetLink('');
        setGuests([]);
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.meetings.title}</h1>
        <p className="text-gray-500 mt-1">{t.meetings.subtitle}</p>
      </div>

      {interviewRelationId && interviewRequestId && interviewRequisitionId && (
        <Card className="mb-4" data-testid="interview-meeting-context">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t.interviewRequests.meetingContext
              .replace('{requestId}', interviewRequestId)
              .replace('{requisition}', interviewRequisitionTitle || interviewRequisitionId)}
          </p>
        </Card>
      )}

      {result && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{result}</div>
      )}

      {loadError && (
        <Card className="mb-4" data-testid="meetings-load-error">
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-red-500">{t.meetings.loadError}</p>
            <Button variant="outline" size="sm" onClick={load}>{t.errorBoundary.retry}</Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>{t.meetings.schedule} ({chosen.length})</CardTitle>
              {/* Same selection, the other intent: skip the date/time and open a
                  room for everyone ticked, right now (#1053). */}
              {chosen.length > 0 && (
                <StartMeetingButton
                  className="ml-auto"
                  target={{ relationIds: chosen }}
                  defaultTitle={title.trim() || undefined}
                  testId="start-meeting-bulk"
                />
              )}
            </div>
          </CardHeader>
          <div className="space-y-4">
            <div className="max-h-40 overflow-y-auto border border-gray-100 dark:border-gray-800 rounded-lg p-2">
              {loading ? (
                <div data-testid="meetings-relations-loading"><SkeletonRows rows={2} /></div>
              ) : loadError ? null : relations.length === 0 ? (
                <p className="text-sm text-gray-400">{t.mentor.noMenteesAssigned}</p>
              ) : (
                <>
                <label className="flex items-center gap-2 text-sm py-1 mb-1 border-b border-gray-100 dark:border-gray-800 font-medium">
                  <input
                    type="checkbox"
                    checked={relations.every((r) => selected[r.id])}
                    onChange={(e) => setSelected(e.target.checked ? Object.fromEntries(relations.map((r) => [r.id, true])) : {})}
                  />
                  <span>{t.meetings.selectAll}</span>
                </label>
                {relations.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={!!selected[r.id]}
                      onChange={(e) => setSelected((p) => ({ ...p, [r.id]: e.target.checked }))}
                    />
                    {/* Inside a <label>: the card suppresses the click that
                        would otherwise tick this invitee's checkbox. */}
                    <PersonHoverCard personId={r.mentee.id} name={r.mentee.fullName} role="MENTEE" className="truncate" />
                  </label>
                ))}
                </>
              )}
            </div>
            <div>
              <Input label={t.meetings.meetingTitle} value={title} onChange={(e) => setTitle(e.target.value)} list="meeting-topics" />
              <datalist id="meeting-topics">
                {(t.meetings.topics as string[]).map((topic) => <option key={topic} value={topic} />)}
              </datalist>
            </div>
            {/* Separate date + time so entering a time doesn't pop a calendar. */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t.meetings.date}</label>
                <input
                  type="date"
                  aria-label={t.meetings.date}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t.meetings.time}</label>
                <input
                  type="time"
                  aria-label={t.meetings.time}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm"
                />
              </div>
            </div>
            {scheduledAt && chosen.length > 0 && <AttendeeTimes instantISO={scheduledAt} people={attendees} />}
            <Input
              label={t.meetings.meetLink}
              placeholder="https://meet.google.com/abc-defg-hij"
              hint={t.meetings.meetLinkHint}
              value={meetLink}
              onChange={(e) => setMeetLink(e.target.value)}
            />
            {/* Outsiders are additive to the selection above, never a
                replacement for it: this endpoint schedules against relations. */}
            <GuestInviteField guests={guests} onChange={setGuests} max={MAX_GUESTS_PER_MEETING} disabled={busy} testIdPrefix="guest" />
            <Button onClick={schedule} loading={busy} disabled={chosen.length === 0 || !title}>
              {t.meetings.sendInvite}
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.meetings.upcoming}{!loading && !loadError ? ` (${meetings.length})` : ''}</CardTitle>
          </CardHeader>
          {loading ? (
            <div data-testid="meetings-list-loading"><SkeletonRows rows={3} /></div>
          ) : loadError ? null : meetings.length === 0 ? (
            <p className="text-sm text-gray-400">{t.meetings.none}</p>
          ) : (
            <div className="divide-y divide-gray-50 dark:divide-gray-800">
              {meetings.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{m.title}</p>
                    <p className="text-xs text-gray-500 truncate">
                      <PersonHoverCard personId={m.relation.mentee.id} name={m.relation.mentee.fullName} role="MENTEE" />
                      {m.scheduledAt ? ` · ${formatDateTime(m.scheduledAt, locale)}` : ` · ${t.meetings.noTime}`}
                    </p>
                    {m.meetLink && (
                      <a
                        href={m.meetLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate block max-w-[16rem]"
                      >
                        {m.meetLink}
                      </a>
                    )}
                    <MeetingGuestList guests={m.guests ?? []} />
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {m.meetLink && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyLink(m)}
                        aria-label={t.meetings.copyLink}
                      >
                        {copiedId === m.id ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                        {copiedId === m.id ? t.meetings.linkCopied : t.meetings.copyLink}
                      </Button>
                    )}
                    {m.scheduledAt && <Badge variant={RSVP_VARIANT[m.rsvp]}>{t.meetings[m.rsvp.toLowerCase() as 'pending' | 'accepted' | 'declined']}</Badge>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
