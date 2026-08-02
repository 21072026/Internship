'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';

// Reminder emails render meeting times in the recipient's saved zone
// (lib/timezone.ts). Only the mentee profile form exposes a zone picker, so most
// users never save one and would read every time on the deployment's default
// clock. This reports the browser's zone once per browser session; the server
// stores it only when the profile has none (#1030).
//
// Mounted once globally in Providers; self-gates on an authenticated session.
const SENT_KEY = 'tzSynced';

export function TimezoneSync() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== 'authenticated') return;
    let tz: string | undefined;
    try {
      if (sessionStorage.getItem(SENT_KEY)) return;
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return; // storage blocked or no Intl data — nothing to do
    }
    if (!tz) return;
    fetch('/api/profile/timezone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: tz }),
    })
      .then(() => {
        try {
          sessionStorage.setItem(SENT_KEY, '1');
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, [status]);

  return null;
}
