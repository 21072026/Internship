// Announcement reach (#1921, slice 2): who an announcement reached and how many
// read it, as COUNTS. Pure and client-safe — the history route, the report
// registry and the unit test read one rule.
//
// The read signal is the in-app one #1721 already keeps: the `read` flag on the
// bell rows a broadcast wrote (`Notification.announcementId`). No mail pixel,
// no tracking link, no per-person list. Two rules decide when that count is
// shown at all:
//
//   · SMALL AUDIENCE. Below `ANNOUNCEMENT_READ_FLOOR` bell rows a read count
//     stops being a total and starts naming people — "1 of 1 read" is one
//     person's behaviour. The count is withheld, the same floor as the report
//     registry's privacy floor (src/lib/reports/definitions.ts).
//   · PRUNED. The nightly retention sweep (#1646) deletes bell rows older than
//     the org's window, read and unread alike, so an announcement sent before
//     the cutoff would report a shrinking, meaningless count. It is withheld
//     rather than shown wrong. Recipients and e-mailed stay: they are columns
//     on the announcement itself and never age out.

/** Fewer bell rows than this and the read count is not shown. */
export const ANNOUNCEMENT_READ_FLOOR = 5;

export type ReadWithheld = 'not_sent' | 'small_audience' | 'pruned';

export interface ReachInput {
  status: string;
  /** When the announcement went out: its schedule, else its creation. */
  sentAt: Date | string;
  /** Bell rows written (`Notification` rows with this announcementId). */
  delivered: number;
  /** …of which the reader opened. */
  read: number;
}

export type ReadReach = { read: number; delivered: number; rate: number; withheld: null } | { read: null; delivered: number; rate: null; withheld: ReadWithheld };

/** The read count to show, or why it is withheld. `cutoff` is the org's retention cutoff (null = kept forever). */
export function readReach(input: ReachInput, cutoff: Date | null): ReadReach {
  const withheld = (reason: ReadWithheld): ReadReach => ({ read: null, delivered: input.delivered, rate: null, withheld: reason });
  if (input.status !== 'SENT') return withheld('not_sent');
  const sentAt = input.sentAt instanceof Date ? input.sentAt : new Date(input.sentAt);
  if (cutoff && sentAt.getTime() < cutoff.getTime()) return withheld('pruned');
  if (input.delivered < ANNOUNCEMENT_READ_FLOOR) return withheld('small_audience');
  return { read: input.read, delivered: input.delivered, rate: Math.round((input.read / input.delivered) * 100), withheld: null };
}

/** When an announcement went out: a scheduled one at its schedule, every other at creation. */
export function announcementSentAt(a: { scheduledAt: Date | string | null; createdAt: Date | string }): Date {
  const at = a.scheduledAt ?? a.createdAt;
  return at instanceof Date ? at : new Date(at);
}
