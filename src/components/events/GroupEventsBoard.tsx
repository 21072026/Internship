'use client';

// Group sessions and office hours (#1856) — one board for the three shells.
// Everyone sees the sessions open to them and registers or leaves; a host (a
// mentor for their own sessions, an admin for the org's) also creates,
// publishes, cancels and records attendance. What a viewer may do is decided
// by the API (`canManage`, the join link it returns or withholds); this
// component only renders what it was given.

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, MapPin, Users, Video } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { formatDateTimeWithZone } from '@/lib/relativeTime';
import { parseWallClockInZone, timeZoneOptions, viewerTimeZone } from '@/lib/timezone';
import { EVENT_ATTENDANCE_STATES, EVENT_AUDIENCES, eventPhase } from '@/lib/groupEventRule';

interface MyRegistration {
  state: 'REGISTERED' | 'WAITLISTED' | 'CANCELLED';
  attendance: string | null;
}

interface EventItem {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  timeZone: string;
  durationMinutes: number;
  capacity: number | null;
  seatsTaken: number;
  location: string | null;
  joinUrl: string | null;
  audience: string;
  publishedAt: string | null;
  cancelledAt: string | null;
  host: { id: string; fullName: string };
  program: { id: string; name: string } | null;
  waitlisted: number;
  canManage: boolean;
  myRegistration: MyRegistration | null;
}

interface Participant {
  userId: string;
  state: string;
  attendance: string | null;
  user: { fullName: string; role: string };
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

/** The public Jitsi instance cuts embedded calls at five minutes; say so wherever its link shows. */
const isPublicJitsi = (url: string | null) => {
  try {
    return url ? new URL(url).hostname === 'meet.jit.si' : false;
  } catch {
    return false;
  }
};

export function GroupEventsBoard({ canCreate = false, isAdmin = false }: { canCreate?: boolean; isAdmin?: boolean }) {
  const t = useT();
  const g = t.groupEvents;
  const locale = useLocale();
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/events${when === 'past' ? '?when=past' : ''}`);
      if (!res.ok) throw new Error(String(res.status));
      setEvents((await res.json()).events);
    } catch {
      setError(g.loadError);
    }
  }, [when, g.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link from a notification: `?event=<id>` opens that card.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('event');
    if (id) setOpen(id);
  }, []);

  async function act(id: string, run: () => Promise<Response>, ok?: (body: { state?: string }) => void) {
    setBusy(id);
    setNotice(null);
    try {
      const res = await run();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNotice(g.actionError);
      else ok?.(body);
      await load();
    } finally {
      setBusy(null);
    }
  }

  const register = (e: EventItem) =>
    act(e.id, () => fetch(`/api/events/${e.id}/register`, { method: 'POST' }), (b) =>
      setNotice(b.state === 'WAITLISTED' ? g.waitlisted : g.registered),
    );
  const unregister = (e: EventItem) => act(e.id, () => fetch(`/api/events/${e.id}/register`, { method: 'DELETE' }));
  const publish = (e: EventItem) =>
    act(e.id, () =>
      fetch(`/api/events/${e.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publish: true }) }),
    );

  const when_ = (iso: string) => formatDateTimeWithZone(iso, locale, viewerTimeZone());

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{g.title}</h1>
          <p className="mt-1 text-gray-500">{g.subtitle}</p>
        </div>
        {canCreate && !creating && <Button onClick={() => setCreating(true)} data-testid="event-create-open">{g.create}</Button>}
      </div>

      {creating && (
        <CreateEventForm
          isAdmin={isAdmin}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      <div className="mb-4 flex gap-2" role="tablist">
        {(['upcoming', 'past'] as const).map((w) => (
          <Button key={w} size="sm" role="tab" aria-selected={when === w} variant={when === w ? 'primary' : 'outline'} onClick={() => setWhen(w)}>
            {w === 'upcoming' ? g.upcoming : g.past}
          </Button>
        ))}
      </div>

      {notice && (
        <p role="status" className="mb-4 rounded-md bg-blue-50 p-3 text-sm text-blue-700" data-testid="event-notice">
          {notice}
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {events && events.length === 0 && <p className="text-gray-500">{when === 'past' ? g.emptyPast : g.empty}</p>}

      <div className="space-y-4">
        {events?.map((e) => {
          const phase = eventPhase(
            { startsAt: new Date(e.startsAt), durationMinutes: e.durationMinutes, publishedAt: e.publishedAt ? new Date(e.publishedAt) : null, cancelledAt: e.cancelledAt ? new Date(e.cancelledAt) : null },
            new Date(),
          );
          const mine = e.myRegistration?.state === 'CANCELLED' ? null : e.myRegistration;
          const isHost = e.canManage;
          return (
            <Card key={e.id} className="p-4" data-testid={`event-card-${e.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{e.title}</h2>
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {when_(e.startsAt)} · {fill(g.minutes, { n: e.durationMinutes })} · {fill(g.hostedBy, { name: e.host.fullName })}
                  </p>
                  <p className="text-sm text-gray-500">
                    {g.audience[e.audience as keyof typeof g.audience] ?? e.audience}
                    {e.program ? ` · ${e.program.name}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {phase === 'draft' && <Badge variant="warning">{g.draft}</Badge>}
                  {phase === 'cancelled' && <Badge variant="danger">{g.cancelled}</Badge>}
                  {phase === 'live' && <Badge variant="success">{g.live}</Badge>}
                  {mine && (
                    <Badge variant={mine.state === 'REGISTERED' ? 'success' : 'info'} data-testid={`event-my-state-${e.id}`}>
                      {g.state[mine.state]}
                    </Badge>
                  )}
                </div>
              </div>

              {e.description && <p className="mt-2 whitespace-pre-line text-sm text-gray-700 dark:text-gray-300">{e.description}</p>}

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-300">
                <span className="inline-flex items-center gap-1" data-testid={`event-seats-${e.id}`}>
                  <Users className="h-4 w-4" aria-hidden />
                  {e.capacity != null ? fill(g.seats, { taken: e.seatsTaken, capacity: e.capacity }) : fill(g.seatsOpen, { taken: e.seatsTaken })}
                  {e.waitlisted > 0 && ` · ${fill(g.waiting, { count: e.waitlisted })}`}
                </span>
                {e.location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-4 w-4" aria-hidden />
                    {fill(g.inPerson, { location: e.location })}
                  </span>
                )}
              </div>

              {e.joinUrl && (phase === 'upcoming' || phase === 'live' || phase === 'draft') && (
                <div className="mt-3">
                  <a href={e.joinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
                    <Video className="h-4 w-4" aria-hidden />
                    {g.join}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                  {isPublicJitsi(e.joinUrl) && (
                    <p className="mt-1 text-xs text-gray-500" data-testid={`event-video-note-${e.id}`}>
                      {g.videoNote}
                    </p>
                  )}
                </div>
              )}

              {mine?.attendance && (
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300" data-testid={`event-my-attendance-${e.id}`}>
                  {fill(g.yourAttendance, { state: g.attendance[mine.attendance as keyof typeof g.attendance] ?? mine.attendance })}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {!isHost && phase === 'upcoming' && !mine && (
                  <Button size="sm" loading={busy === e.id} onClick={() => register(e)} data-testid={`event-register-${e.id}`}>
                    {e.capacity != null && e.seatsTaken >= e.capacity ? g.joinWaitlist : g.register}
                  </Button>
                )}
                {!isHost && phase === 'upcoming' && mine && (
                  <Button size="sm" variant="outline" loading={busy === e.id} onClick={() => unregister(e)} data-testid={`event-unregister-${e.id}`}>
                    {mine.state === 'WAITLISTED' ? g.leaveWaitlist : g.cancelRegistration}
                  </Button>
                )}
                {isHost && phase === 'draft' && (
                  <Button size="sm" loading={busy === e.id} onClick={() => publish(e)} data-testid={`event-publish-${e.id}`}>
                    {g.publish}
                  </Button>
                )}
                {isHost && (
                  <Button size="sm" variant="outline" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id} data-testid={`event-participants-${e.id}`}>
                    {g.participants}
                  </Button>
                )}
                {isHost && (phase === 'draft' || phase === 'upcoming') && (
                  <Button size="sm" variant="ghost" onClick={() => setCancelId(e.id)} data-testid={`event-cancel-${e.id}`}>
                    {g.cancelEvent}
                  </Button>
                )}
              </div>

              {isHost && open === e.id && <ParticipantsPanel event={e} attendanceOpen={phase === 'live' || phase === 'past'} />}
            </Card>
          );
        })}
      </div>

      <ConfirmDialog
        open={cancelId !== null}
        message={g.cancelConfirm}
        confirmLabel={g.cancelEvent}
        cancelLabel={g.form.close}
        variant="danger"
        loading={busy === cancelId}
        onCancel={() => setCancelId(null)}
        onConfirm={() => {
          const id = cancelId;
          if (!id) return;
          void act(id, () => fetch(`/api/events/${id}/cancel`, { method: 'POST' })).then(() => setCancelId(null));
        }}
      />
    </div>
  );
}

function ParticipantsPanel({ event, attendanceOpen }: { event: EventItem; attendanceOpen: boolean }) {
  const t = useT();
  const g = t.groupEvents;
  const [rows, setRows] = useState<Participant[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/events/${event.id}`);
    if (!res.ok) {
      setFailed(true);
      return;
    }
    setRows((await res.json()).participants ?? []);
  }, [event.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mark(userId: string, attendance: string) {
    const res = await fetch(`/api/events/${event.id}/attendance`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, attendance: attendance || null }),
    });
    if (!res.ok) setFailed(true);
    await load();
  }

  const options = [{ value: '', label: g.attendance.none }, ...EVENT_ATTENDANCE_STATES.map((s) => ({ value: s, label: g.attendance[s] }))];
  return (
    <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700" data-testid={`event-participant-list-${event.id}`}>
      {failed && <p className="text-sm text-red-600">{g.actionError}</p>}
      {!attendanceOpen && <p className="mb-2 text-xs text-gray-500">{g.attendanceOpensLater}</p>}
      {rows && rows.length === 0 && <p className="text-sm text-gray-500">{g.noParticipants}</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {rows?.map((p) => (
          <li key={p.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-sm text-gray-800 dark:text-gray-200">
              {p.user.fullName} <span className="text-gray-500">· {g.state[p.state as keyof typeof g.state] ?? p.state}</span>
            </span>
            {attendanceOpen && p.state !== 'WAITLISTED' && (
              <select
                aria-label={g.attendanceLabel.replace('{name}', p.user.fullName)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
                value={p.attendance ?? ''}
                onChange={(ev) => void mark(p.userId, ev.target.value)}
                data-testid={`event-attendance-${p.userId}`}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateEventForm({ isAdmin, onClose, onCreated }: { isAdmin: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const g = t.groupEvents;
  const f = g.form;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [timeZone, setTimeZone] = useState(() => viewerTimeZone());
  const [duration, setDuration] = useState('60');
  const [capacity, setCapacity] = useState('');
  const [audience, setAudience] = useState<string>('MENTEES');
  const [programId, setProgramId] = useState('');
  const [programs, setPrograms] = useState<{ id: string; name: string }[]>([]);
  const [location, setLocation] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const [publishNow, setPublishNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((b: { cohorts?: { id: string; name: string }[] }) => setPrograms(b.cohorts ?? []))
      .catch(() => setPrograms([]));
  }, [isAdmin]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    const instant = parseWallClockInZone(startsAt, timeZone);
    if (!title.trim() || !instant) {
      setError(g.actionError);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          startsAt: instant.toISOString(),
          timeZone,
          durationMinutes: Number(duration) || 60,
          capacity: capacity ? Number(capacity) : null,
          audience,
          programId: programId || null,
          location: location.trim() || null,
          joinUrl: joinUrl.trim() || null,
          publish: publishNow,
        }),
      });
      if (!res.ok) {
        setError(g.actionError);
        return;
      }
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-6 p-4">
      <form onSubmit={submit} className="space-y-3" data-testid="event-create-form">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{f.heading}</h2>
        <Input label={f.title} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={191} required data-testid="event-title" />
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {f.description}
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} rows={3} className="mt-1" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={f.startsAt} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required data-testid="event-starts-at" />
          <Select label={f.timeZone} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} options={timeZoneOptions()} />
          <Input label={f.duration} type="number" min={5} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} />
          <Input label={f.capacity} type="number" min={1} max={1000} value={capacity} onChange={(e) => setCapacity(e.target.value)} hint={f.capacityHint} data-testid="event-capacity" />
          <Select
            label={f.audience}
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            options={EVENT_AUDIENCES.map((a) => ({ value: a, label: g.audience[a] }))}
          />
          {isAdmin && (
            <Select
              label={f.program}
              value={programId}
              onChange={(e) => setProgramId(e.target.value)}
              options={[{ value: '', label: f.wholeOrg }, ...programs.map((p) => ({ value: p.id, label: p.name }))]}
            />
          )}
          <Input label={f.location} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={191} />
          <Input label={f.joinUrl} type="url" value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} hint={f.joinUrlHint} />
        </div>
        <p className="text-xs text-gray-500">{g.videoNote}</p>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />
          {f.publishNow}
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" loading={saving} data-testid="event-create-submit">
            {f.save}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {f.close}
          </Button>
        </div>
      </form>
    </Card>
  );
}
