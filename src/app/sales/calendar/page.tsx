'use client';

import { useState } from 'react';
import { CalendarView } from '@/components/CalendarView';
import { IcsFeedCard } from '@/components/IcsFeedCard';
import { useT } from '@/i18n/client';
import { PlanMeetingButton } from './PlanMeetingDialog';

// The sales rep's calendar (#3778): their meetings, their records' follow-up
// days and trial ends, from GET /api/sales/calendar — the rep's own book only.
// The shell (src/app/sales/layout.tsx) is the door: a MARKETING sales surface,
// nobody else; the API re-checks the same gate. Week view by default, the
// agenda on a phone, and the subscription card so the same items reach Google
// or Outlook. The team view waits for the shared sales-book read rule.
export default function SalesCalendarPage() {
  const t = useT();
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.salesCalendar.title}</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">{t.salesCalendar.subtitle}</p>
        </div>
        <PlanMeetingButton onCreated={() => setRefreshKey((k) => k + 1)} />
      </div>
      <CalendarView
        source="/api/sales/calendar"
        defaultView="week"
        storageKey="crm.salesCalendar.view"
        refreshKey={refreshKey}
        legend={['meeting', 'followup', 'trial', 'overdue']}
      />
      <IcsFeedCard />
    </div>
  );
}
