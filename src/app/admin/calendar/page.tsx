'use client';

import { CalendarView } from '@/components/CalendarView';
import { IcsFeedCard } from '@/components/IcsFeedCard';
import { useT } from '@/i18n/client';

export default function AdminCalendarPage() {
  const t = useT();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.calendar.title}</h1>
        <p className="text-gray-500 mt-1">{t.calendar.subtitle}</p>
      </div>
      <CalendarView />
      {/* Every role gets its own subscription token, not just the mentee portal (#2015). */}
      <IcsFeedCard />
    </div>
  );
}
