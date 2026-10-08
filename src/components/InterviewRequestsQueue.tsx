'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { CalendarClock } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTimeWithZone } from '@/lib/relativeTime';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { parseWallClockInZone, timeZoneOptions, viewerTimeZone } from '@/lib/timezone';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { InterviewDeclineDialog } from '@/components/InterviewDeclineDialog';

type Item = {
  id: string;
  status: string;
  note: string | null;
  proposedSlots: unknown;
  createdAt: string;
  meetingId: string | null;
  scheduledAt: string | null;
  cancelReason: string | null;
  company: { name: string };
  requisition: { id: string; title: string };
  mentee: { id: string; fullName: string; menteeRelations: { id: string }[] };
};

function proposedSlots(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((slot): slot is string => typeof slot === 'string') : [];
}

type Text = ReturnType<typeof useT>['interviewRequests'];

// The approver picks one of the company's slots — or another time, saying so —
// on a named clock, optionally names the company's interviewers, and the
// server creates the Meeting (#1844). Every time shown here carries its zone.
function ScheduleForm({ item, slots, zone, locale, text, onDone }: {
  item: Item; slots: string[]; zone: string; locale: string; text: Text; onDone: () => Promise<void>;
}) {
  const [choice, setChoice] = useState<string>(slots[0] ?? 'other');
  const [other, setOther] = useState('');
  const [timeZone, setTimeZone] = useState(zone);
  const [guests, setGuests] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submit = async () => {
    setError('');
    setNotice('');
    const slot = choice === 'other' ? parseWallClockInZone(other, timeZone)?.toISOString() : choice;
    if (!slot) { setError(text.errors.saveFailed); return; }
    const guestEmails = guests.split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean);
    setBusy(true);
    try {
      const res = await fetch(`/api/interview-requests/${item.id}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, timeZone, ...(guestEmails.length ? { guestEmails } : {}), ...(choice === 'other' ? { override: true } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? text.errors.saveFailed); return; }
      if (Array.isArray(data.rejectedGuests) && data.rejectedGuests.length > 0) {
        setNotice(text.rejectedGuests.replace('{emails}', data.rejectedGuests.join(', ')));
      }
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="interview-schedule-form">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{text.schedulePick}</p>
      <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
        {slots.map((slot) => (
          <label key={slot} className="flex items-center gap-2">
            <input type="radio" name={`slot-${item.id}`} value={slot} checked={choice === slot} onChange={() => setChoice(slot)} data-testid="interview-slot-option" />
            <span>{formatDateTimeWithZone(slot, locale, timeZone)}</span>
          </label>
        ))}
        <label className="flex items-center gap-2">
          <input type="radio" name={`slot-${item.id}`} value="other" checked={choice === 'other'} onChange={() => setChoice('other')} data-testid="interview-slot-other" />
          <span>{text.scheduleOther}</span>
        </label>
        {choice === 'other' && (
          <div className="pl-6">
            <Input type="datetime-local" value={other} onChange={(e) => setOther(e.target.value)} data-testid="interview-slot-other-input" />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{text.scheduleOtherHint}</p>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Select label={text.scheduleTimeZone} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} options={timeZoneOptions()} data-testid="interview-timezone" />
        <div>
          <Input label={text.scheduleGuests} value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="name@company.example" data-testid="interview-guests" />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{text.scheduleGuestsHint}</p>
        </div>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
      <Button size="sm" loading={busy} onClick={() => void submit()} data-testid="interview-schedule">{text.scheduleConfirm}</Button>
    </div>
  );
}

function CancelForm({ item, text, onDone }: { item: Item; text: Text; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/interview-requests/${item.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? text.errors.saveFailed); return; }
      setOpen(false);
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="interview-cancel">{text.cancelRequest}</Button>;
  }
  return (
    <div className="mt-2 w-full space-y-2" data-testid="interview-cancel-form">
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={text.cancelReason} data-testid="interview-cancel-reason" />
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="danger" loading={busy} onClick={() => void submit()} data-testid="interview-cancel-confirm">{text.cancelConfirm}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>{text.declineCancel}</Button>
      </div>
    </div>
  );
}

export function InterviewRequestsQueue({ mentor = false }: { mentor?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const text = t.interviewRequests;
  const [items, setItems] = useState<Item[]>([]);
  // Which clock the proposed slots are printed on. The endpoint hands back the
  // viewer's saved `User.timezone`; `viewerTimeZone` falls back to the browser's
  // own zone and then to the deployment default, so the "(GMT+3)" label always
  // names a real zone. Null until the first load resolves, which is harmless:
  // the list is fetched in an effect, so no date exists in the server-rendered
  // HTML for a client re-render to disagree with.
  const [timezone, setTimezone] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch('/api/interview-requests');
    const data = await res.json();
    if (res.ok) {
      setItems(data.requests ?? []);
      setTimezone(data.viewerTimezone ?? null);
    } else setError(data.error ?? text.errors.loadFailed);
  }, [text.errors.loadFailed]);

  useEffect(() => { void load(); }, [load]);
  const decide = async (id: string, action: 'approve' | 'decline', declineReasonCode?: string, declineNote?: string) => {
    setSavingId(id);
    setError('');
    try {
      const res = await fetch(`/api/interview-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'decline' ? { declineReasonCode, declineNote: declineNote || undefined } : {}),
        }),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? text.errors.saveFailed);
        return;
      }
      setDecliningId(null);
      await load();
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div data-testid={mentor ? 'mentor-interview-requests' : 'admin-interview-requests'}>
      <h1 className="mb-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{text.title}</h1>
      <p className="mb-6 text-gray-500 dark:text-gray-400">{text.subtitle}</p>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {items.length === 0 ? (
        <Card>
          <EmptyState
            testId="interview-requests"
            icon={CalendarClock}
            role={mentor ? 'MENTOR' : 'ADMIN'}
            title={t.emptyStates.interviewRequests.title}
            byRole={{
              ADMIN: {
                body: t.emptyStates.interviewRequests.adminBody,
                action: { label: t.emptyStates.interviewRequests.adminCta, href: '/admin/requisitions' },
              },
              // A mentor cannot open a requisition, so they get the explanation
              // and nothing that would walk into a 403.
              MENTOR: { body: t.emptyStates.interviewRequests.mentorBody },
            }}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const slots = proposedSlots(item.proposedSlots);
            const zone = viewerTimeZone(timezone);
            const meetingHref = item.meetingId ? `${mentor ? '/mentor/meetings' : '/admin/meetings'}?meetingId=${item.meetingId}` : null;
            return (
              <Card key={item.id} data-testid={`interview-request-${item.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words font-semibold text-gray-900 dark:text-gray-100">{item.requisition.title}</h2>
                    <p className="break-words text-sm text-gray-600 dark:text-gray-300">
                      {item.company.name} · <PersonHoverCard personId={item.mentee.id} name={item.mentee.fullName} role="MENTEE" />
                    </p>
                    {/* When it was asked reads as a distance; the hover is on the
                        same named clock as the slots below, not the browser's. */}
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      <RelativeTime
                        date={item.createdAt}
                        title={formatDateTimeWithZone(item.createdAt, locale, viewerTimeZone(timezone))}
                        data-testid="interview-request-requested-at"
                      />
                    </p>
                    {item.note && <p className="mt-2 break-words text-sm text-gray-700 dark:text-gray-300">{item.note}</p>}
                    {slots.length > 0 && (
                      <div className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                        <p className="font-medium">{text.proposedSlots}</p>
                        <ul className="list-inside list-disc">
                          {/* A proposed slot is an appointment someone will be
                              held to, and this queue is read from Turkey and
                              from Germany — so it names its zone (#1422). */}
                          {slots.map((slot) => (
                            <li key={slot}>{formatDateTimeWithZone(slot, locale, viewerTimeZone(timezone))}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <Badge>{text.statuses[item.status as keyof typeof text.statuses] ?? item.status}</Badge>
                </div>
                {item.status === 'PENDING' && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" loading={savingId === item.id} onClick={() => void decide(item.id, 'approve')}>{text.approve}</Button>
                    <Button size="sm" variant="outline" disabled={savingId === item.id} onClick={() => setDecliningId(item.id)}>{text.decline}</Button>
                  </div>
                )}
                {item.status === 'APPROVED' && (
                  <>
                    <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">{text.pipelineRecommendation}</p>
                    <ScheduleForm item={item} slots={slots} zone={zone} locale={locale} text={text} onDone={load} />
                    <div className="mt-2"><CancelForm item={item} text={text} onDone={load} /></div>
                  </>
                )}
                {item.status === 'SCHEDULED' && item.scheduledAt && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {/* The confirmed time, on the viewer's named clock (#1422). */}
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100" data-testid="interview-scheduled-at">
                      {text.scheduledAt.replace('{when}', formatDateTimeWithZone(item.scheduledAt, locale, zone))}
                    </p>
                    {meetingHref && (
                      <Link href={meetingHref} className="text-sm font-medium text-blue-600 dark:text-blue-400" data-testid="interview-open-meeting">
                        {text.openMeeting}
                      </Link>
                    )}
                    <CancelForm item={item} text={text} onDone={load} />
                  </div>
                )}
                {item.status === 'CANCELLED' && (
                  <p className="mt-3 text-sm text-gray-600 dark:text-gray-300" data-testid="interview-cancelled">
                    {item.cancelReason ? text.cancelledWithReason.replace('{reason}', item.cancelReason) : text.cancelledNoReason}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <InterviewDeclineDialog
        open={decliningId !== null}
        loading={decliningId !== null && savingId === decliningId}
        onCancel={() => setDecliningId(null)}
        onConfirm={(reasonCode, note) => {
          if (decliningId) void decide(decliningId, 'decline', reasonCode, note);
        }}
      />
    </div>
  );
}
