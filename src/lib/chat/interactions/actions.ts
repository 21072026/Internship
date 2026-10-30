import { prisma } from '@/lib/prisma';
import { getDictionary } from '@/i18n/dictionaries';
import { formatInTimeZone } from '@/lib/timezone';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { interpolate } from '@/lib/notificationText';
import { registerChatAction } from './dispatch';

// The built-in chat actions (#1948). Each one is something the person could
// do in the app, asking the same rule the app asks.

/**
 * `meetings.upcoming` — "my next meetings": the clicking person's own next
 * three scheduled meetings, in THEIR zone and language. Read-only, so a
 * platform retry is harmless. Scoped exactly like the mentor's and mentee's
 * GET /api/meetings: meetings of a relation the person is a side of, in their
 * own org. An admin has no such relation and gets the empty answer — this is
 * "mine", not the org's calendar.
 */
registerChatAction('meetings.upcoming', async ({ user }) => {
  const t = getDictionary(user.locale).chatInteraction;
  const rows = await prisma.meeting.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { gte: new Date() },
      relation: { is: { orgId: user.orgId, OR: [{ mentorId: user.id }, { menteeId: user.id }] } },
    },
    select: { title: true, scheduledAt: true },
    orderBy: { scheduledAt: 'asc' },
    take: 3,
  });
  if (rows.length === 0) return { text: t.upcomingNone };
  const lines = rows.map(
    (m) => `• ${interpolate(t.upcomingLine, { title: m.title, when: formatInTimeZone(m.scheduledAt!, user.timeZone, undefined, intlLocaleFor(user.locale)) })}`,
  );
  return { text: `${t.upcomingHeader}\n${lines.join('\n')}` };
});
