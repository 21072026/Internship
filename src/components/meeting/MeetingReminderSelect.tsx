'use client';

// A meeting's own reminder lead (#1636): the programme default, or one
// reminder a day / an hour / 30 minutes before, or none. Changes WHEN the
// reminder fires, never whether a person who opted out of meeting reminders
// gets one — that preference is applied by the sender.

import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { MEETING_LEAD_CHOICES } from '@/lib/meetingReminderLeads';

export function MeetingReminderSelect({
  value,
  onChange,
  disabled,
}: {
  /** null = the programme default. */
  value: number | null;
  onChange: (lead: number | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const R = t.meetings.reminderLead;
  const label = (n: number) => (n === 0 ? R.none : n === 1440 ? R.dayBefore : n === 60 ? R.hourBefore : R.minutesBefore.replace('{n}', String(n)));
  const choices: number[] = [...MEETING_LEAD_CHOICES];
  if (value != null && !choices.includes(value)) choices.push(value);
  return (
    <Select
      label={R.label}
      data-testid="meeting-reminder-select"
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      options={[{ value: '', label: R.default }, ...choices.map((n) => ({ value: String(n), label: label(n) }))]}
      disabled={disabled}
    />
  );
}
