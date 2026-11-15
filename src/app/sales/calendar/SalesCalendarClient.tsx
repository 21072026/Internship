'use client';

import { useState } from 'react';
import { CalendarView } from '@/components/CalendarView';
import { IcsFeedCard } from '@/components/IcsFeedCard';
import { useT } from '@/i18n/client';
import { PlanMeetingButton } from './PlanMeetingDialog';

type Scope = 'me' | 'team';

// The sales rep's calendar (#3778), client half. "Me" is GET /api/sales/calendar
// (the rep's own book); "Team" is GET /api/sales/calendar/team (their own items
// plus colleagues' — read-only, the owner's initials and the lead's name, never
// a note). The toggle is only offered when the shared team-read rule lets this
// viewer read the org's book (the server page asks it); the API asks again.
export function SalesCalendarClient({ teamAllowed }: { teamAllowed: boolean }) {
  const t = useT();
  const s = t.salesCalendar;
  const [refreshKey, setRefreshKey] = useState(0);
  const [scope, setScope] = useState<Scope>('me');
  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.title}</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">{s.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {teamAllowed && (
            <div
              role="group"
              aria-label={s.scopeLabel}
              className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800"
              data-testid="sales-calendar-scope"
            >
              {(['me', 'team'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={scope === v}
                  onClick={() => setScope(v)}
                  data-testid={`sales-calendar-scope-${v}`}
                  className={`min-h-11 rounded-md px-4 text-sm font-medium transition ${
                    scope === v
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100'
                      : 'text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'
                  }`}
                >
                  {v === 'me' ? s.scopeMe : s.scopeTeam}
                </button>
              ))}
            </div>
          )}
          <PlanMeetingButton onCreated={() => setRefreshKey((k) => k + 1)} />
        </div>
      </div>
      {scope === 'team' && <p className="mb-3 text-sm text-gray-500 dark:text-gray-400" data-testid="sales-calendar-team-hint">{s.teamHint}</p>}
      <CalendarView
        source={scope === 'team' ? '/api/sales/calendar/team' : '/api/sales/calendar'}
        defaultView="week"
        storageKey="crm.salesCalendar.view"
        refreshKey={refreshKey}
        legend={['meeting', 'followup', 'trial', 'overdue']}
      />
      <IcsFeedCard />
    </div>
  );
}
