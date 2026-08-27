import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { authOptions } from '@/lib/auth';
import { CalendarView } from '@/components/CalendarView';
import { IcsFeedCard } from '@/components/IcsFeedCard';

// The mentee's own calendar (#915): the same CalendarView the mentor and admin
// use — /api/calendar-events already scopes MENTEE to their own relations —
// plus a personal, revocable ICS subscription feed.
export default async function PortalCalendarPage() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t } = await getServerDictionary();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.calendarTitle}</h1>
        <p className="text-gray-500 mt-1">{t.portal.calendarSubtitle}</p>
      </div>
      <CalendarView />
      <IcsFeedCard />
    </div>
  );
}
