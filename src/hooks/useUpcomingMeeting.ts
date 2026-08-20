'use client';

import { useEffect, useState } from 'react';

// Shared source for "is a meeting about to start / happening now" (#51 follow-up).
//
// Two components want the same answer — the dashboard banner and the header's
// join pill — and both are mounted at once. A module-level store means one poll
// for the pair instead of two, and a component mounting later gets the current
// answer immediately instead of waiting for its own request.

export interface UpcomingMeeting {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  meetLink: string | null;
  ongoing: boolean;
  minutesUntilStart: number;
  projectId: string | null;
  projectName: string | null;
  /** Who is in the video room right now — null when unknown (no JaaS webhook feed). */
  live: { count: number; names: string[] } | null;
}

const POLL_MS = 60_000;

let current: UpcomingMeeting | null = null;
let loaded = false;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(m: UpcomingMeeting | null) => void>();

async function refresh() {
  try {
    const res = await fetch('/api/meetings/upcoming');
    if (!res.ok) {
      // 401 on a public page is normal; treat any failure as "nothing to show"
      // rather than leaving a stale meeting on screen forever.
      current = null;
    } else {
      const d = await res.json();
      current = (d.meeting ?? null) as UpcomingMeeting | null;
    }
  } catch {
    current = null;
  }
  loaded = true;
  subscribers.forEach((fn) => fn(current));
}

// "This meeting is over" — any participant may say so, and the banner then
// disappears for *everyone* (the server hides it from the shared endpoint).
// The local store refreshes immediately so the marker sees it vanish at once;
// other participants pick it up on their next poll. Errors are swallowed: the
// worst case is the banner living out its assumed window, exactly as before.
export async function endUpcomingMeeting(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/meetings/${encodeURIComponent(id)}/end`, { method: 'POST' });
    if (!res.ok) return false;
    await refresh();
    return true;
  } catch {
    return false;
  }
}

export function useUpcomingMeeting() {
  const [meeting, setMeeting] = useState<UpcomingMeeting | null>(current);
  const [ready, setReady] = useState(loaded);

  useEffect(() => {
    const onChange = (m: UpcomingMeeting | null) => {
      setMeeting(m);
      setReady(true);
    };
    subscribers.add(onChange);
    // First subscriber starts the poll; the rest ride along.
    if (!timer) {
      void refresh();
      timer = setInterval(() => void refresh(), POLL_MS);
    } else if (loaded) {
      onChange(current);
    }
    return () => {
      subscribers.delete(onChange);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return { meeting, ready };
}
