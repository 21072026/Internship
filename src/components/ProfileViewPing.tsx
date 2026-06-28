'use client';

import { useEffect } from 'react';

// Fires once on mount to record a public-profile view (dedupe/owner checks
// happen server-side).
export function ProfileViewPing({ userId }: { userId: string }) {
  useEffect(() => {
    fetch('/api/profile-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    }).catch(() => {});
  }, [userId]);
  return null;
}
