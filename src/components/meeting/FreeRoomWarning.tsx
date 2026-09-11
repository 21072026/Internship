'use client';

import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useT } from '@/i18n/client';
import { isFreeInstanceMeetingLink } from '@/lib/meetingLink';

// Say it BEFORE the call, not during it (#2011).
//
// The public Jitsi instance hangs up an EMBEDDED call after about five minutes.
// Until now nothing said so: a project standup opened in the side panel, ran
// for five minutes and dropped everyone mid-sentence, and the only way to learn
// that was to have it happen. An announced limitation is a different product
// from a silent failure, even when the limitation is identical.
//
// Two things make this honest rather than an apology:
//   · it names the actual limit and the actual escape — the SAME room opened in
//     a browser tab has no cutoff, and that button is right here;
//   · it appears for a degraded 1:1 too. Once the month's JaaS allowance is
//     spent, a pair's room is a public room and dies exactly the same way; a
//     warning shown only to groups would be a warning that lies by omission.
//
// It appears whenever the room is on the public host, whatever put it there —
// the allowance being spent, a deployment with no JaaS credentials at all, or a
// link created before the tenant existed. `group` only sharpens the wording:
// a standup with six people has more to lose than a pair does.
export function FreeRoomWarning({
  meetLink,
  group,
  className = '',
  testId = 'meeting-free-room-warning',
}: {
  meetLink: string;
  /** More than two people in the call — the organiser plus at least two others. */
  group?: boolean;
  className?: string;
  testId?: string;
}) {
  const t = useT();
  if (!isFreeInstanceMeetingLink(meetLink)) return null;

  return (
    <div
      data-testid={testId}
      role="status"
      className={`flex items-start gap-2 bg-amber-50 border-b border-amber-200 px-3 py-2 text-xs text-amber-800 ${className}`}
    >
      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0">
        <p>{group ? t.meetings.instant.freeRoomGroupWarning : t.meetings.instant.freeRoomWarning}</p>
        <a
          href={meetLink}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`${testId}-open`}
          className="mt-1 inline-flex items-center gap-1 font-medium underline underline-offset-2"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          {t.meetings.instant.freeRoomWarningAction}
        </a>
      </div>
    </div>
  );
}
