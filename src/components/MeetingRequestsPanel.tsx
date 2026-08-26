'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { AttendeeTimes } from '@/components/meeting/AttendeeTimes';
import { browserTimeZone, wallClockToInstantISO } from '@/lib/timezone';
import { expandSlots, matchesSlot, type SlotOccurrence, type WeeklySlot } from '@/lib/availabilitySlots';

interface MReq {
  id: string;
  topic: string;
  proposedAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
}

// mode='request' → the mentee proposes meetings + sees status.
// mode='manage'  → the mentor accepts/declines pending requests.
export function MeetingRequestsPanel({
  relationId,
  mode,
  counterpart,
}: {
  relationId: string;
  mode: 'request' | 'manage';
  /**
   * The other side of the relation. A mentee proposing a slot is proposing it
   * on their own clock to somebody who may be on another one, so the proposal
   * form previews both before it is sent (#1210).
   *
   * `id` (#1361) lets the mentee side read the mentor's posted availability and
   * offer those hours as concrete choices instead of an empty datetime field.
   */
  counterpart?: { id?: string; name: string; timezone?: string | null };
}) {
  const t = useT();
  const locale = useLocale();
  const [reqs, setReqs] = useState<MReq[]>([]);
  const [topic, setTopic] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  // The mentor's posted weekly hours, and the zone they are written in (#1361).
  // Empty is the normal, supported state: a mentor who has posted nothing still
  // gets free-text requests, which is how this worked before.
  const [slots, setSlots] = useState<WeeklySlot[] | null>(null);
  const [slotZone, setSlotZone] = useState<string | null>(null);
  // A picked occurrence is kept as an exact instant, NOT as a datetime-local
  // string. The slot's wall clock belongs to the mentor's zone; round-tripping
  // it through the date field would re-read it on the mentee's clock and move
  // the meeting by the offset between them.
  const [picked, setPicked] = useState<SlotOccurrence | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/meeting-requests?relationId=${relationId}`);
    if (res.ok) setReqs((await res.json()).requests ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  // Both sides read availability, for opposite reasons: the mentee to be
  // offered the hours, the mentor to see which of their own hours a request
  // landed on. The mentor reads their own (no query parameter); the mentee
  // reads their mentor's, which the endpoint allows precisely because they are
  // paired (#1358).
  const availabilityUrl =
    mode === 'manage' ? '/api/availability' : counterpart?.id ? `/api/availability?mentorId=${counterpart.id}` : null;
  useEffect(() => {
    if (!availabilityUrl) { setSlots([]); return; }
    let cancelled = false;
    fetch(availabilityUrl)
      .then((r) => (r.ok ? r.json() : { slots: [] }))
      .then((d) => {
        if (cancelled) return;
        setSlots(d.slots ?? []);
        setSlotZone(d.timezone ?? null);
      })
      // A failed read must not strand the form: fall back to free text rather
      // than leaving the picker in a permanent loading state (#1374's shape).
      .catch(() => { if (!cancelled) setSlots([]); });
    return () => { cancelled = true; };
  }, [availabilityUrl]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const proposedAt = picked ? picked.startISO : when ? new Date(when).toISOString() : '';
    if (!topic.trim() || !proposedAt) return;
    setBusy(true);
    try {
      const res = await fetch('/api/meeting-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, topic, proposedAt }),
      });
      if (res.ok) { setTopic(''); setWhen(''); setPicked(null); await load(); }
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

  // `datetime-local` yields "2026-08-03T16:30" with no zone; read it on the
  // browser's clock, which is the one the mentee picked it on (#1061).
  const [proposedDate = '', proposedTime = ''] = when.split('T');
  const proposedInstantISO = when ? wallClockToInstantISO(proposedDate, proposedTime) : '';

  // Concrete date-times from the mentor's weekly hours. Recomputed on render is
  // fine: the list is at most `limit` entries and the maths is arithmetic.
  const offers = slots && slots.length > 0 ? expandSlots(slots, slotZone, { from: new Date(), weeks: 3, limit: 12 }) : [];
  const hasOffers = offers.length > 0;

  const statusLabel = (s: string) => (t.portal.meetingRequests.status as Record<string, string>)[s] ?? s;
  const variant = (s: string) => (s === 'ACCEPTED' ? 'success' : s === 'DECLINED' ? 'danger' : 'warning');
  const pending = reqs.filter((r) => r.status === 'PENDING');
  const list = mode === 'manage' ? pending : reqs;

  return (
    <Card>
      <CardHeader><CardTitle>{mode === 'manage' ? t.portal.meetingRequests.titleManage : t.portal.meetingRequests.title}</CardTitle></CardHeader>

      {mode === 'request' && hasOffers && (
        <div className="mb-4" data-testid="slot-offers">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            {t.portal.meetingRequests.pickSlot}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {offers.map((o) => {
              const isPicked = picked?.startISO === o.startISO;
              return (
                <button
                  key={o.startISO}
                  type="button"
                  aria-pressed={isPicked}
                  data-testid={`slot-offer-${o.startISO}`}
                  onClick={() => {
                    // Picking a slot and typing a time are two ways to say the
                    // same thing, so choosing one clears the other — otherwise
                    // the form would hold two answers and silently prefer one.
                    setPicked(isPicked ? null : o);
                    setWhen('');
                  }}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    isPicked
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200 font-medium'
                      : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400'
                  }`}
                >
                  {formatDateTime(o.startISO, locale)}
                </button>
              );
            })}
          </div>
          {slotZone && (
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {t.portal.meetingRequests.slotZone
                .replace('{name}', counterpart?.name ?? '')
                .replace('{zone}', slotZone)}
            </p>
          )}
        </div>
      )}

      {mode === 'request' && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2 mb-4">
          <div className="flex-1 min-w-[160px]"><Input label={t.portal.meetingRequests.topic} value={topic} onChange={(e) => setTopic(e.target.value)} /></div>
          <div className="min-w-[180px]">
            <Input
              label={hasOffers ? t.portal.meetingRequests.whenOther : t.portal.meetingRequests.when}
              type="datetime-local"
              value={when}
              onChange={(e) => { setWhen(e.target.value); setPicked(null); }}
            />
          </div>
          <Button type="submit" size="sm" loading={busy} disabled={!topic.trim() || (!when && !picked)}>{t.portal.meetingRequests.request}</Button>
          {(when || picked) && counterpart && (
            <div className="w-full">
              <AttendeeTimes
                instantISO={picked ? picked.startISO : proposedInstantISO}
                people={[
                  { name: t.meetings.you, timezone: browserTimeZone() },
                  { name: counterpart.name, timezone: counterpart.timezone },
                ]}
              />
            </div>
          )}
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
                <p className="text-xs text-gray-400">
                  {formatDateTime(r.proposedAt, locale)}
                  {/* Derived, never stored: the request keeps only an instant,
                      and hours the mentor has since deleted should stop being
                      claimed as theirs (#1361). */}
                  {mode === 'manage' && slots && matchesSlot(new Date(r.proposedAt), slots, slotZone) && (
                    <span data-testid={`mreq-from-slot-${r.id}`} className="ml-2 text-green-700 dark:text-green-400">
                      {t.portal.meetingRequests.fromYourHours}
                    </span>
                  )}
                </p>
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
