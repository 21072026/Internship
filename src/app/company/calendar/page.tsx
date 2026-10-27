'use client';

import { CalendarView } from '@/components/CalendarView';
import { useT } from '@/i18n/client';

// The company's own interview schedule (#2005). The scoping lives in
// GET /api/calendar-events — a COMPANY session gets the meetings scheduled from
// its own interview requests and nothing else. No subscription card: the feed's
// COMPANY branch is #2015's to mirror.
export default function CompanyCalendarPage() {
  const t = useT();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.calendar.title}</h1>
        <p className="text-gray-500 mt-1">{t.calendar.companySubtitle}</p>
      </div>
      <CalendarView emptyText={t.calendar.companyEmpty} />
    </div>
  );
}
