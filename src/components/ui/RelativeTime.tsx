'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocale } from '@/i18n/client';
import { formatDateTime, relativeTime } from '@/lib/relativeTime';

// "5 dk. önce" on the screen, "25.08.2026 16:30" on hover.
//
// A past instant reads faster as a distance than as a date — nobody wants to
// subtract "25.08.2026 16:30" from today in their head — but the exact reading
// must stay one hover away, so the absolute value rides along as the `title`
// and as the machine-readable `dateTime` of the <time> element.
//
// Only for INSTANTS that already happened or are about to: "sent", "last
// seen", "updated". A calendar date (a birthday, an internship start date,
// a deadline someone reads on a calendar) or a schedule (a meeting at 16:30)
// keeps its absolute form — "in 3 days" is not an appointment.

// One shared 30-second clock for every mounted <RelativeTime>, so a list of
// two hundred timestamps does not run two hundred intervals. "5 min. ago"
// would otherwise freeze at whatever it said when the page was rendered.
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribeToClock(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((l) => l()), TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noop = () => () => {};

interface Props {
  date: Date | string | number;
  /** The app locale, read from context when absent. */
  locale?: string;
  /**
   * The absolute reading shown on hover. Defaults to `formatDateTime` in the
   * viewer's own zone, which only the browser knows — so a default title is
   * attached after hydration, while an explicit one is rendered by the server.
   */
  title?: string;
  /** `'short'` ("5 dk. önce") unless the sentence around it wants the long form. */
  style?: Intl.RelativeTimeFormatStyle;
  className?: string;
  'data-testid'?: string;
}

export function RelativeTime({ date, locale, title, style = 'short', className, 'data-testid': testId }: Props) {
  const appLocale = useLocale();
  const lang = locale ?? appLocale;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeToClock(() => setNow(Date.now())), []);

  // The server's "now" and the browser's are different instants, and a page
  // served from a cache may be minutes old. The server's text is therefore
  // only ever a placeholder: the <time> is keyed on hydration, so the first
  // client render replaces it outright instead of trusting a reconciler that
  // assumes server and client agreed.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);

  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  return (
    <time
      key={hydrated ? 'client' : 'server'}
      dateTime={d.toISOString()}
      title={title ?? (hydrated ? formatDateTime(d, lang) : undefined)}
      className={className}
      data-testid={testId}
      suppressHydrationWarning
    >
      {relativeTime(d, lang, { style, now })}
    </time>
  );
}
