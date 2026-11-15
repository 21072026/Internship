import Link from 'next/link';
import { AlertTriangle, CalendarClock, CheckSquare, Video } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { getServerDictionary } from '@/i18n/server';
import { loadSalesCalendar, utcDay } from '@/lib/salesCalendar';
import { formatInTimeZone, parseUserDateTime, resolveTimeZone } from '@/lib/timezone';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { resolveTemplateTitle } from '@/lib/goalTemplates';

// "Today" on the sales dashboard (#3778): what the rep has to do today, each
// line a link to where it is done —
//   • follow-ups due today and overdue ones (red), → the lead page;
//   • today's meetings, at their time on the rep's own clock, → the lead page;
//   • their open to-dos, → /todos.
// Follow-ups and meetings come from the calendar's own loader
// (src/lib/salesCalendar.ts), so the card and /sales/calendar never disagree;
// the to-dos are the rep's own list (ProjectTask assigned to them, open).
//
// "Today" is the rep's day in their saved zone; a follow-up is due by the one
// UTC-day rule the panel, the reminder and the queue share.

const TODO_LIMIT = 5;
const LIST_LIMIT = 8;

/** The calendar day `now` falls on in `tz`, as `YYYY-MM-DD`. */
function dayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function SalesTodayCard({ userId, orgId }: { userId: string; orgId: string | null | undefined }) {
  if (!orgId) return null;
  const { t, locale } = await getServerDictionary();
  const s = t.salesToday;
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const tz = resolveTimeZone(me?.timezone);
  const now = new Date();
  const today = dayIn(tz, now);
  const start = parseUserDateTime(`${today}T00:00`, tz) ?? new Date(now.getTime() - 12 * 3600_000);
  const end = new Date((parseUserDateTime(`${today}T23:59`, tz) ?? new Date(now.getTime() + 12 * 3600_000)).getTime() + 59_999);

  const [events, todoRows, todoCount] = await Promise.all([
    // Every overdue follow-up, however old: `followUpsFrom` reaches back.
    loadSalesCalendar({ orgId, userId, from: start, to: end, followUpsFrom: new Date(0), now: now.getTime() }),
    prisma.projectTask.findMany({
      where: { assigneeId: userId, done: false, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, title: true, dueDate: true, template: { select: { title: true, translations: true } } },
    }),
    prisma.projectTask.count({ where: { assigneeId: userId, done: false, archivedAt: null } }),
  ]);

  const todayUtc = utcDay(now);
  const followUps = events.filter((e) => e.type === 'followup' && (e.overdue || e.date === todayUtc));
  const meetings = events.filter((e) => e.type === 'meeting');
  // Dated to-dos first, soonest due; undated after, newest first.
  const todos = [...todoRows]
    .sort((a, b) => (a.dueDate && b.dueDate ? a.dueDate.getTime() - b.dueDate.getTime() : a.dueDate ? -1 : b.dueDate ? 1 : 0))
    .slice(0, TODO_LIMIT);
  const time = (iso: string) => formatInTimeZone(new Date(iso), tz, { dateStyle: undefined, timeStyle: 'short' }, intlLocaleFor(locale));
  const empty = followUps.length === 0 && meetings.length === 0 && todoCount === 0;

  const rowClass =
    'flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

  return (
    <Card className="mb-8" data-testid="sales-today">
      <CardHeader>
        <CardTitle>{s.title}</CardTitle>
      </CardHeader>
      {empty ? (
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="sales-today-empty">{s.empty}</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <section aria-labelledby="sales-today-followups">
            <h3 id="sales-today-followups" className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{s.followUps}</h3>
            {followUps.length === 0 ? (
              <p className="px-2 text-sm text-gray-400">{s.none}</p>
            ) : (
              <ul data-testid="sales-today-followups">
                {followUps.slice(0, LIST_LIMIT).map((e) => {
                  const overdue = e.type === 'followup' && e.overdue;
                  return (
                    <li key={e.id}>
                      <Link href={e.link} className={rowClass} data-testid={`sales-today-${e.id}`} data-overdue={overdue ? 'true' : 'false'}>
                        {overdue ? (
                          <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
                        ) : (
                          <CalendarClock className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-gray-800 dark:text-gray-100">{e.who}</span>
                          <span className={`block truncate text-xs ${overdue ? 'text-red-700 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                            {overdue ? `${s.overdue} · ` : ''}
                            {e.title || s.noStep}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section aria-labelledby="sales-today-meetings">
            <h3 id="sales-today-meetings" className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{s.meetings}</h3>
            {meetings.length === 0 ? (
              <p className="px-2 text-sm text-gray-400">{s.none}</p>
            ) : (
              <ul data-testid="sales-today-meetings">
                {meetings.slice(0, LIST_LIMIT).map((e) => (
                  <li key={e.id}>
                    <Link href={e.link} className={rowClass} data-testid={`sales-today-${e.id}`}>
                      <Video className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-gray-800 dark:text-gray-100">{e.who}</span>
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          <span className="tabular-nums">{time(e.date)}</span> · {e.title}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="sales-today-todos">
            <h3 id="sales-today-todos" className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{s.todos}</h3>
            {todos.length === 0 ? (
              <p className="px-2 text-sm text-gray-400">{s.none}</p>
            ) : (
              <ul data-testid="sales-today-todos">
                {todos.map((task) => (
                  <li key={task.id}>
                    <Link href="/todos" className={rowClass} data-testid={`sales-today-todo-${task.id}`}>
                      <CheckSquare className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-100">
                        {task.template ? resolveTemplateTitle(task.template, locale) : task.title}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {todoCount > TODO_LIMIT && (
              <Link href="/todos" className="mt-1 inline-flex min-h-11 items-center px-2 text-xs text-blue-600 hover:underline dark:text-blue-400" data-testid="sales-today-todos-all">
                {s.allTodos.replace('{n}', String(todoCount))}
              </Link>
            )}
          </section>
        </div>
      )}
    </Card>
  );
}
