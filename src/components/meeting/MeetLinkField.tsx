'use client';

import { AlertTriangle } from 'lucide-react';
import { useT } from '@/i18n/client';
import { isEmbeddableMeetingLink, meetingProviderName } from '@/lib/meetingLink';

// Bring your own link (#2007) — the two things every form with a meeting-link
// box needs to say, in one place so the schedule panel, the meetings page and
// the account page cannot drift apart:
//
//   · under the box, whether the link will show inside the app or open the
//     provider in a new tab (Meet/Zoom/Teams refuse to be framed — see
//     EMBEDDABLE_MEETING_HOSTS);
//   · after a refused save, WHY: the link cannot be used as typed, or the
//     tenant's policy wants an external link and none was offered.

/** The refusal body resolveMeetingLink's callers return (src/lib/meetingRoom.ts), or null. */
export type MeetingLinkRefusal = 'invalid_link' | 'external_link_required';

export function readLinkRefusal(body: unknown): MeetingLinkRefusal | null {
  const code = (body as { code?: string } | null)?.code;
  // `invalid_meeting_link` is the profile route's spelling of the same refusal.
  if (code === 'invalid_link' || code === 'invalid_meeting_link') return 'invalid_link';
  if (code === 'external_link_required') return 'external_link_required';
  return null;
}

/** "Opens inside the app" / "opens in Zoom, in a new tab" — nothing for an empty box. */
export function MeetLinkHint({ link, className = '' }: { link: string; className?: string }) {
  const t = useT();
  const trimmed = link.trim();
  if (!trimmed) return null;
  const embeds = isEmbeddableMeetingLink(trimmed);
  const provider = meetingProviderName(trimmed);
  if (!embeds && !provider) return null;
  return (
    <p data-testid="meet-link-hint" className={`text-xs text-gray-500 dark:text-gray-400 ${className}`}>
      {embeds ? t.meetings.linkEmbeds : t.meetings.linkOpensIn.replace('{provider}', provider ?? '')}
    </p>
  );
}

export function LinkRefusalNotice({ refusal }: { refusal: MeetingLinkRefusal }) {
  const t = useT();
  return (
    <div
      data-testid="meet-link-refusal"
      role="alert"
      className="flex items-start gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{refusal === 'invalid_link' ? t.meetings.linkInvalid : t.meetings.linkRequired}</span>
    </div>
  );
}
