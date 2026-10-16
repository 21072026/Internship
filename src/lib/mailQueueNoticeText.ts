// The sentence an admin reads after a send that put mail on the queue (#2951):
// "40 e-mails are queued and will be delivered over about 8 min, paced so the
// mail server is not overloaded." Client-safe and dependency-free — the three
// admin screens that send many mails (announcements, newsletters, bulk invite)
// render it from the `mailQueue` block their route returns
// (`mailQueueNotice()` in src/lib/mailOutbox.ts).

export interface MailQueueNoticeData {
  queued: number;
  etaMinutes: number;
  paced?: boolean;
}

export interface MailQueueCopy {
  queuedNotice: string;
  minutes: string;
  hours: string;
}

/** Rough duration text: minutes under an hour, whole hours (rounded up) above. */
export function etaText(minutes: number, copy: Pick<MailQueueCopy, 'minutes' | 'hours'>): string {
  const m = Math.max(1, Math.ceil(minutes));
  if (m < 60) return copy.minutes.replace('{n}', String(m));
  return copy.hours.replace('{n}', String(Math.ceil(m / 60)));
}

/** The whole sentence, or null when nothing was queued. */
export function mailQueueNoticeText(data: MailQueueNoticeData | null | undefined, copy: MailQueueCopy): string | null {
  if (!data || !(data.queued > 0)) return null;
  return copy.queuedNotice.replace('{n}', String(data.queued)).replace('{eta}', etaText(data.etaMinutes, copy));
}
