'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Drops the client router cache once, after the server changed something that
// other, already-visited pages show — the Back button restores those pages from
// that cache without asking the server (#3894: the lead page marking a record
// seen, while /sales still held the "Assigned to you" card). router.refresh()
// clears the cache and re-renders the current route; mount this only on the
// render that made the change, so it runs once.
export function RefreshRouterCache() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}
