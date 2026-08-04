'use client';

import { CalendarClock, Video } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { useUpcomingMeeting } from '@/hooks/useUpcomingMeeting';

// The dashboard's "you have a meeting" strip (#51 follow-up): appears half an
// hour before the start and stays for as long as the meeting is running, with the
// join link right in it. Nothing is rendered when there is no such meeting, so the
// dashboard is unchanged the rest of the time.
export function UpcomingMeetingBanner() {
  const t = useT();
  const locale = useLocale();
  const { meeting } = useUpcomingMeeting();

  if (!meeting) return null;

  const when = meeting.ongoing
    ? t.upcomingMeeting.inProgress
    : meeting.minutesUntilStart <= 1
      ? t.upcomingMeeting.startingNow
      : t.upcomingMeeting.startingIn.replace('{n}', String(meeting.minutesUntilStart));

  return (
    <div
      data-testid="upcoming-meeting-banner"
      className={`mb-6 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center ${
        meeting.ongoing
          ? 'border-green-200 bg-green-50 dark:border-green-800'
          : 'border-blue-200 bg-blue-50 dark:border-blue-800'
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <CalendarClock className={`mt-0.5 h-5 w-5 flex-shrink-0 ${meeting.ongoing ? 'text-green-600' : 'text-blue-600'}`} />
        <div className="min-w-0">
          <p className={`font-medium ${meeting.ongoing ? 'text-green-800' : 'text-blue-800'}`}>
            {meeting.title} · {when}
          </p>
          <p className={`mt-0.5 text-sm ${meeting.ongoing ? 'text-green-700' : 'text-blue-700'}`}>
            {meeting.projectName ? `${meeting.projectName} · ` : ''}
            {formatDateTime(meeting.startsAt, locale)}
          </p>
        </div>
      </div>
      <div className="sm:ml-auto">
        {meeting.meetLink ? (
          <a
            href={meeting.meetLink}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="upcoming-meeting-join"
            className={`inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white sm:w-auto ${
              meeting.ongoing ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            <Video className="h-4 w-4" /> {t.upcomingMeeting.join}
          </a>
        ) : (
          <p className="text-xs text-gray-500">{t.upcomingMeeting.noLink}</p>
        )}
      </div>
    </div>
  );
}
