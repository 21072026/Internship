// Busy-window arithmetic (#1995) — pure, client-safe, unit-tested
// (scripts/test/busy-windows.test.mjs). Every interval is HALF-OPEN,
// [start, end): a meeting 09:00–10:00 and one 10:00–11:00 are back to back,
// not a clash — the convention /api/availability already uses for slots.
// Instants are absolute (Date / epoch ms), so a DST change in anybody's zone
// cannot make two meetings overlap or stop overlapping.

export interface Window {
  start: Date;
  end: Date;
}

export interface BusyWindow extends Window {
  /** What occupies it — named back to the caller in a 409. */
  title: string;
}

/** Whether two half-open windows share any instant. */
export function overlaps(a: Window, b: Window): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** Sorted, merged windows: overlapping ones become one; back-to-back ones stay apart. */
export function mergeWindows(list: Window[]): Window[] {
  const sorted = [...list].filter((w) => w.end.getTime() > w.start.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start.getTime() < last.end.getTime()) {
      if (w.end.getTime() > last.end.getTime()) last.end = new Date(w.end.getTime());
    } else {
      out.push({ start: new Date(w.start.getTime()), end: new Date(w.end.getTime()) });
    }
  }
  return out;
}

/** The earliest busy window `candidate` collides with, or null. */
export function firstConflict<T extends Window>(candidate: Window, busy: T[]): T | null {
  return [...busy].sort((a, b) => a.start.getTime() - b.start.getTime()).find((w) => overlaps(candidate, w)) ?? null;
}

/** Slot occurrences that do not collide with anything already booked. */
export function filterBookedOccurrences<T extends Window>(occurrences: T[], busy: Window[]): T[] {
  return occurrences.filter((o) => !busy.some((b) => overlaps(o, b)));
}
