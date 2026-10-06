'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import type { ProgrammeAttendance, Ratio } from '@/lib/meetingCadence';

// Meeting attendance (#2014): the cadence number a sponsor asks for, with the
// count behind each figure. Counted, never predicted (src/lib/meetingCadence.ts);
// a figure over fewer pairs than the reporting floor says so instead of a number.
export function MeetingAttendanceCard() {
  const t = useT();
  const a = t.meetingAttendance;
  const [data, setData] = useState<ProgrammeAttendance | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/analytics/attendance')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setData(d?.attendance ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data || data.activePairs === 0) return null;

  const pct = (r: Ratio, empty: string) => (r.basis === 0 ? empty : r.pct === null ? a.suppressed : `${r.pct}%`);
  const tiles = [
    { key: 'met', label: a.metRecently, value: pct(data.metRecently, '—'), basis: a.ofPairs.replace('{n}', String(data.metRecently.basis)) },
    { key: 'cadence', label: a.onCadence, value: pct(data.onCadence, a.noPromise), basis: a.ofPromised.replace('{n}', String(data.onCadence.basis)) },
    { key: 'noShow', label: a.noShowRate, value: pct(data.noShowRate, '—'), basis: a.ofMeetings.replace('{n}', String(data.noShowRate.basis)) },
    { key: 'gap', label: a.medianGap, value: data.medianDaysBetween === null ? '—' : a.days.replace('{n}', String(data.medianDaysBetween)), basis: '' },
  ];

  return (
    <Card className="mb-6 break-inside-avoid" data-testid="meeting-attendance">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarCheck className="h-5 w-5 text-green-600" />
          <CardTitle>{a.title}</CardTitle>
        </div>
        <p className="mt-1 text-sm text-gray-500">{a.subtitle}</p>
      </CardHeader>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.key} className="rounded-xl border border-gray-200 p-3 dark:border-gray-800" data-testid={`attendance-${tile.key}`}>
            <p className="text-xs text-gray-500">{tile.label}</p>
            <p className="text-xl font-bold text-gray-900 dark:text-gray-100" data-testid={`attendance-${tile.key}-value`}>{tile.value}</p>
            {tile.basis && <p className="text-xs text-gray-500">{tile.basis}</p>}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-gray-500">{a.deterministic}</p>
    </Card>
  );
}
