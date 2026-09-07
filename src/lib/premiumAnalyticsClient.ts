'use client';

import { useEffect, useState } from 'react';

// Client-side read of the premium analytics tier (#1442).
//
// One request that answers the question, instead of four that fail: the screen
// used to learn the tier was off by calling `/api/admin/analytics/cohorts` and
// reading the 403 back. `/api/admin/analytics/entitlements` says so directly.
//
// The answer is `null` while the request is in flight, which is deliberately
// NOT the same as `false`: the premium sections must not flash their locked
// panel for a tenant that turns out to be entitled, and the gated fetches must
// not fire before we know. Callers therefore branch on all three states.
//
// This is a rendering decision only. Every premium endpoint re-checks the
// setting server-side and still returns 403 `feature_locked` — a tampered value
// here changes what is drawn, never what is served.
export function usePremiumAnalytics(): boolean | null {
  const [premium, setPremium] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    // A failed or non-OK read resolves to `false` rather than staying unknown:
    // the locked panel is the safe thing to draw, and it keeps this hook from
    // becoming a new source of console noise.
    fetch('/api/admin/analytics/entitlements')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setPremium(d?.premiumAnalytics === true); })
      .catch(() => { if (alive) setPremium(false); });
    return () => { alive = false; };
  }, []);

  return premium;
}
