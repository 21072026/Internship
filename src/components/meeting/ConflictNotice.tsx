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
