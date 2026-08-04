'use client';

import { Video } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useUpcomingMeeting } from '@/hooks/useUpcomingMeeting';

// The "Join" link that sits in the header for as long as a meeting is running
// (#51 follow-up). Deliberately only while it is *in progress*: before that the
// dashboard banner is the announcement, and a permanent button would stop meaning
// anything.
export function JoinMeetingPill() {
  const t = useT();
  const { meeting } = useUpcomingMeeting();

  if (!meeting?.ongoing || !meeting.meetLink) return null;

  return (
    <a
      href={meeting.meetLink}
      target="_blank"
      rel="noopener noreferrer"
      title={`${meeting.title} — ${t.upcomingMeeting.inProgress}`}
      aria-label={t.upcomingMeeting.joinAria}
      data-testid="join-meeting-pill"
      className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700"
    >
      {/* The mobile bar has room for three icon buttons and a wordmark, so the
          label is desktop-only there (#936). */}
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
      </span>
      <Video className="h-4 w-4" />
      <span className="hidden sm:inline">{t.upcomingMeeting.join}</span>
    </a>
  );
}
