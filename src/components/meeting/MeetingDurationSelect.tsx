'use client';

import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { DEFAULT_MEETING_MINUTES, MEETING_DURATION_PRESETS } from '@/lib/meetingDuration';

// The session-length picker every scheduling form shares (#1984): the presets
// and the default come from src/lib/meetingDuration.ts, so a form cannot offer a
// length the rest of the app would render differently.
export function MeetingDurationSelect({
  value,
  onChange,
  disabled,
  className,
  compact,
}: {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
  className?: string;
  /** No visible label (the series form lays its inputs out in one row); the select keeps an aria-label. */
  compact?: boolean;
}) {
  const t = useT();
  // A stored length that is not a preset (an API client may send 50) stays
  // selectable instead of silently snapping to another value on save.
  const presets: number[] = [...MEETING_DURATION_PRESETS];
  const options = (presets.includes(value) ? presets : [...presets, value].sort((a, b) => a - b)).map((n) => ({
    value: String(n),
    label: t.meetings.durationOption.replace('{n}', String(n)),
  }));
  return (
    <Select
      label={compact ? undefined : t.meetings.duration}
      aria-label={t.meetings.duration}
      data-testid="meeting-duration-select"
      value={String(value || DEFAULT_MEETING_MINUTES)}
      onChange={(e) => onChange(Number(e.target.value))}
      options={options}
      disabled={disabled}
      className={className}
    />
  );
}
