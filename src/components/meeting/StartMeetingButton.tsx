'use client';

import { Video } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { useMeetingLauncher, type MeetingTarget } from '@/components/meeting/MeetingLauncher';

// One click from wherever the person already is (#1053). The heavy lifting —
// asking for the topic, calling the API, opening the panel — belongs to the
// launcher mounted in Providers, so this stays a button that names a target.
export function StartMeetingButton({
  target,
  defaultTitle,
  size = 'sm',
  variant = 'outline',
  label,
  className,
  testId = 'start-meeting',
}: {
  target: MeetingTarget;
  defaultTitle?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  // Icon-only when false; defaults to showing the text.
  label?: boolean;
  className?: string;
  testId?: string;
}) {
  const t = useT();
  const start = useMeetingLauncher();
  const showLabel = label !== false;

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      data-testid={testId}
      aria-label={t.meetings.instant.start}
      title={t.meetings.instant.start}
      onClick={() => start({ target, defaultTitle })}
    >
      <Video className="h-4 w-4" />
      {showLabel && t.meetings.instant.start}
    </Button>
  );
}
