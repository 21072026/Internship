import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { loadSalesCalendar } from '@/lib/salesCalendar';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Widest window one request may ask for — a month grid is 42 days. */
const MAX_RANGE_DAYS = 62;

// GET ?from=&to= — the sales rep's calendar (#3778): what is on THEIR book in
// the window on screen — their meetings, their records' follow-up days and
// trial ends. The items and their scope are src/lib/salesCalendar.ts, shared
// with the "Today" card on /sales.
//
// MARKETING sales surface only, the caller's own org only — the same door as
// the lead pool (salesPoolGate). The team view waits for the shared sales-book
// read rule rather than growing a second one here. A follow-up and a trial end
// are DAYS, not instants, so they travel as `YYYY-MM-DD` with `allDay` and are
// placed on that day whatever the viewer's zone; a meeting is an instant the
// browser renders on its own clock.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;

    const url = new URL(request.url);
    const from = rangeStart(url.searchParams.get('from'));
    let to = rangeEnd(url.searchParams.get('to'));
    if (!from || !to || to < from) {
      return NextResponse.json({ error: 'Validation failed', code: 'invalid_range' }, { status: 400 });
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) to = new Date(from.getTime() + MAX_RANGE_DAYS * DAY_MS);

    return withTenantScope(session, async () => {
      const events = await loadSalesCalendar({ orgId: g.orgId, userId: g.userId, from, to });
      return NextResponse.json({ events, from: from.toISOString(), to: to.toISOString() });
    });
  });
}
