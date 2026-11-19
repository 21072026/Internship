'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { DEFAULT_MEETING_MINUTES, MEETING_DURATION_PRESETS } from '@/lib/meetingDuration';

// "Plan a meeting" with one of the rep's own leads (#3778) — on the sales
// calendar ("New meeting") and on the lead page ("Plan meeting", prefilled).
//
// No endpoint of its own: it posts to POST /api/meetings, the one scheduling
// path, which resolves the room through resolveMeetingLink() (a pasted link is
// checked there, never here), books against conflicts and booking rules, and
// mails the invite. Who may schedule on which record is decided THERE, on the
// server: the owner, a sales dispatcher or an admin of the org; a lead outside
// that reach answers 404. The lead list below is only what the rep can pick.

interface LeadOption {
  id: string;
  name: string;
}

/** Today in the browser's zone, as the `YYYY-MM-DD` a date input reads. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The next whole hour on the viewer's clock, as `HH:MM`. */
function nextHour(): string {
  return `${String((new Date().getHours() + 1) % 24).padStart(2, '0')}:00`;
}

export function PlanMeetingButton({
  relationId,
  leadName,
  onCreated,
  variant = 'primary',
}: {
  /** Prefill and lock the lead (the lead page). */
  relationId?: string;
  leadName?: string;
  onCreated?: () => void;
  variant?: 'primary' | 'outline';
}) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        className="min-h-11"
        onClick={() => setOpen(true)}
        data-testid={relationId ? 'sales-lead-plan-meeting' : 'sales-calendar-new-meeting'}
      >
        <CalendarPlus className="mr-1 h-4 w-4" aria-hidden="true" />
        {relationId ? t.salesCalendar.planMeeting : t.salesCalendar.newMeeting}
      </Button>
      {open && (
        <PlanMeetingDialog
          relationId={relationId}
          leadName={leadName}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            // A caller that keeps its own list reloads it; a server-rendered page
            // (the lead page, #3853) is re-rendered so the new meeting shows up.
            if (onCreated) onCreated();
            else router.refresh();
          }}
        />
      )}
    </>
  );
}

function PlanMeetingDialog({
  relationId,
  leadName,
  onClose,
  onCreated,
}: {
  relationId?: string;
  leadName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const s = t.salesCalendar;
  const toast = useToast();
  const dialogRef = useModalFocus<HTMLDivElement>(true, onClose);
  const [leads, setLeads] = useState<LeadOption[] | null>(relationId ? [{ id: relationId, name: leadName ?? '' }] : null);
  const [leadId, setLeadId] = useState(relationId ?? '');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [date, setDate] = useState(localToday);
  const [time, setTime] = useState(nextHour);
  const [duration, setDuration] = useState(String(DEFAULT_MEETING_MINUTES));
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The rep's own open records — the same list their board reads.
  useEffect(() => {
    if (relationId) return;
    let cancelled = false;
    fetch('/api/mentorship?status=ACTIVE')
      .then((r) => (r.ok ? r.json() : { relations: [] }))
      .then((d: { relations?: Array<{ id: string; mentee?: { fullName?: string | null } | null }> }) => {
        if (cancelled) return;
        setLeads(
          (d.relations ?? [])
            .map((r) => ({ id: r.id, name: r.mentee?.fullName ?? '' }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      })
      .catch(() => !cancelled && setLeads([]));
    return () => {
      cancelled = true;
    };
  }, [relationId]);

  const pickedName = leads?.find((l) => l.id === leadId)?.name ?? '';
  // The title follows the picked lead until the rep writes their own.
  useEffect(() => {
    if (!titleTouched) setTitle(pickedName ? s.titleDefault.replace('{lead}', pickedName) : '');
  }, [pickedName, titleTouched, s.titleDefault]);

  const canSubmit = !!leadId && !!title.trim() && !!date && !!time && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    // The wall clock the rep typed, on their own clock, sent as an instant —
    // the server never reads a bare time in its own zone (#1061).
    const when = new Date(`${date}T${time}`);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relationIds: [leadId],
          title: title.trim(),
          scheduledAt: when.toISOString(),
          durationMinutes: Number(duration),
          timeZone,
          ...(link.trim() ? { meetLink: link.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && (body.created ?? 0) > 0) {
        toast(s.created, 'success');
        onCreated();
        return;
      }
      if (res.status === 409) setError(body.code === 'conflict' ? s.conflict : body.error || s.conflict);
      else if (res.status === 404 || res.status === 403) setError(s.refused);
      else setError(body.error && typeof body.error === 'string' && res.status === 400 ? body.error : s.error);
    } catch {
      setError(s.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-meeting-title"
        data-testid="plan-meeting-dialog"
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="plan-meeting-title" className="mb-4 text-base font-semibold text-gray-900 dark:text-gray-100">
          {s.dialogTitle}
        </h2>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {relationId ? (
            <p className="text-sm text-gray-700 dark:text-gray-200" data-testid="plan-meeting-lead-fixed">
              <span className="font-medium">{s.lead}:</span> {leadName}
            </p>
          ) : leads && leads.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="plan-meeting-no-leads">
              {s.noLeads}
            </p>
          ) : (
            <Select
              id="plan-meeting-lead"
              label={s.lead}
              required
              value={leadId}
              disabled={!leads}
              onChange={(e) => setLeadId(e.target.value)}
              placeholder={s.leadPlaceholder}
              options={(leads ?? []).map((l) => ({ value: l.id, label: l.name }))}
              data-testid="plan-meeting-lead"
            />
          )}
          <Input
            id="plan-meeting-title-input"
            label={s.meetingTitle}
            required
            maxLength={200}
            value={title}
            onChange={(e) => {
              setTitleTouched(true);
              setTitle(e.target.value);
            }}
            data-testid="plan-meeting-title-input"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              id="plan-meeting-date"
              type="date"
              label={s.date}
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="plan-meeting-date"
            />
            <Input
              id="plan-meeting-time"
              type="time"
              label={s.time}
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
              data-testid="plan-meeting-time"
            />
          </div>
          <Select
            id="plan-meeting-duration"
            label={s.duration}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            options={MEETING_DURATION_PRESETS.map((m) => ({ value: String(m), label: s.minutes.replace('{n}', String(m)) }))}
            data-testid="plan-meeting-duration"
          />
          <Input
            id="plan-meeting-link"
            type="url"
            inputMode="url"
            label={s.link}
            hint={s.linkHint}
            maxLength={191}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            data-testid="plan-meeting-link"
          />
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400" data-testid="plan-meeting-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" className="min-h-11" disabled={busy} onClick={onClose} data-testid="plan-meeting-cancel">
              {s.cancel}
            </Button>
            <Button type="submit" className="min-h-11" loading={busy} disabled={!canSubmit} data-testid="plan-meeting-submit">
              {s.create}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
