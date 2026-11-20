'use client';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import { track, ANALYTICS_EVENTS } from '@/lib/track';
import type { EventProps } from '@/lib/analyticsEvents';

export function RoleCardLink({ role, ...props }: ComponentProps<typeof Link> & { role: NonNullable<EventProps['role']> }) {
  return <Link {...props} onClick={() => track(ANALYTICS_EVENTS.ROLE_CARD_SELECTED, { role })} />;
}
