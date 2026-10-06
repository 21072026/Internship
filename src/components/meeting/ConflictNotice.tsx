'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

export interface MeetingConflict {
  title: string;
  startsAt: string;
}

/** The 409 body every booking path returns on a collision (#1995), or null. */
export function readConflict(body: unknown): MeetingConflict | null {
  const b = body as { code?: string; conflictsWith?: MeetingConflict } | null;
  return b?.code === 'conflict' && b.conflictsWith ? b.conflictsWith : null;
}

/** "Collides with X (time)" — the words both the notice and a bulk report use. */
export function useConflictText() {
  const t = useT();
  const locale = useLocale();
  // An empty title is the server withholding someone else's meeting name.
  return (c: MeetingConflict, name?: string) => {
    const k = t.meetings.conflict;
    const template = name ? (c.title ? k.skipped : k.skippedBusy).replace('{name}', name) : c.title ? k.collides : k.collidesBusy;
    return template.replace('{title}', c.title).replace('{time}', formatDateTime(c.startsAt, locale));
  };
}

// A booking refused because the hour is taken (#1995). `onForce` is offered
// only where the caller may book over it — the organiser, never a requester.
export function ConflictNotice({ conflict, onForce, busy }: { conflict: MeetingConflict; onForce?: () => void; busy?: boolean }) {
  const t = useT();
  const text = useConflictText();
  return (
    <div data-testid="meeting-conflict" role="alert" className="flex flex-wrap items-center gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{text(conflict)}</span>
      {onForce && (
        <Button size="sm" variant="outline" loading={busy} onClick={onForce} data-testid="meeting-conflict-force">
          {t.meetings.conflict.bookAnyway}
        </Button>
      )}
    </div>
  );
}

// ── Booking rules (#2003) ────────────────────────────────────────────────────

export interface MeetingPolicyRefusal {
  rule: 'min_notice' | 'buffer' | 'weekly_cap' | 'monthly_cap';
  limit: number;
  windowStart: string;
}

/** The 409 body a mentor's booking rules return, or null. */
export function readPolicy(body: unknown): MeetingPolicyRefusal | null {
  const b = body as { code?: string; rule?: MeetingPolicyRefusal['rule']; limit?: number; windowStart?: string } | null;
  return b?.code === 'policy' && b.rule && typeof b.limit === 'number' ? { rule: b.rule, limit: b.limit, windowStart: b.windowStart ?? '' } : null;
}

/** "4 hours", "90 minutes", "2 days" — the shortest unit that is a whole number. */
export function useDurationText() {
  const u = useT().meetings.policy.units;
  return (minutes: number) =>
    minutes % 1440 === 0 && minutes >= 1440
      ? u.days.replace('{n}', String(minutes / 1440))
      : minutes % 60 === 0 && minutes >= 60
        ? u.hours.replace('{n}', String(minutes / 60))
        : u.minutes.replace('{n}', String(minutes));
}

/** The rule as a sentence — named after the person when the caller knows them. */
export function usePolicyText() {
  const p = useT().meetings.policy as unknown as Record<string, string>;
  const duration = useDurationText();
  return (r: MeetingPolicyRefusal, name?: string) => {
    const limit = r.rule === 'min_notice' || r.rule === 'buffer' ? duration(r.limit) : String(r.limit);
    return (name ? p[`${r.rule}_named`].replace('{name}', name) : p[r.rule]).replace('{limit}', limit);
  };
}

// A booking a mentor's rules refused. `onForce` only where the caller may book
// over them — an admin; a mentee asking is told why, never offered a way round.
export function PolicyNotice({ refusal, name, onForce, busy }: { refusal: MeetingPolicyRefusal; name?: string; onForce?: () => void; busy?: boolean }) {
  const t = useT();
  const text = usePolicyText();
  return (
    <div data-testid="meeting-policy" role="alert" className="flex flex-wrap items-center gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{text(refusal, name)}</span>
      {onForce && (
        <Button size="sm" variant="outline" loading={busy} onClick={onForce} data-testid="meeting-policy-force">
          {t.meetings.conflict.bookAnyway}
        </Button>
      )}
    </div>
  );
}
