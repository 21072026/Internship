'use client';

import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

export interface MeetingGuest {
  id: string;
  email: string;
  name?: string | null;
  rsvp: 'PENDING' | 'ACCEPTED' | 'DECLINED';
}

const RSVP_VARIANT = { PENDING: 'warning', ACCEPTED: 'success', DECLINED: 'danger' } as const;

/**
 * The outsiders on a meeting and what each of them answered (#1446).
 *
 * Rendered next to the meeting rather than folded into the participant list:
 * an outside guest is reached only by the address someone typed, so "did that
 * address actually reply?" is the question the organizer has — and the one an
 * invite with no visible answer leaves open.
 */
export function MeetingGuestList({ guests }: { guests: MeetingGuest[] }) {
  const t = useT();
  if (guests.length === 0) return null;

  return (
    <div className="mt-1" data-testid="meeting-guests">
      <p className="text-xs font-medium text-gray-500">{t.meetings.guests.title}</p>
      <ul className="mt-0.5 space-y-0.5">
        {guests.map((g) => (
          <li key={g.id} className="flex items-center gap-2 text-xs" data-testid={`meeting-guest-${g.email}`}>
            <span className="truncate text-gray-600 dark:text-gray-300 max-w-[14rem]">
              {g.name ? `${g.name} · ${g.email}` : g.email}
            </span>
            <Badge variant={RSVP_VARIANT[g.rsvp]}>
              {t.meetings[g.rsvp.toLowerCase() as 'pending' | 'accepted' | 'declined']}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
