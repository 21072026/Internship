// The public status page's rules (#1604) — dependency-free and unit-tested
// (e2e/status.unit.spec.ts). What counts as healthy, how a 90-day figure is
// computed from samples, and what the page may show all live here, so the page,
// the sampler and the test cannot disagree.
//
// THE MEASUREMENT, HONESTLY. `status.sample` writes one `StatusSample` row per
// 5-minute slot, from inside the app, through its database, on its scheduler.
// So a row proves all three were up in that slot, and a MISSING row is
// downtime — of the app, the database, the scheduler or the whole host; the
// page cannot tell which, and does not pretend to. Mail and jobs are graded
// inside a row ('ok' | 'degraded'): degraded is still available.
//
// What the page never shows: a version, a git sha, a hostname, a port, a
// container name, an error text or a count that sizes a tenant.

export const SLOT_MINUTES = 5;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;
export const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Grade = 'ok' | 'degraded';
export type ComponentKey = 'web' | 'mail' | 'jobs';
export type ComponentState = 'operational' | 'degraded' | 'down' | 'unknown';
export type DayState = 'up' | 'partial' | 'down' | 'nodata';

/** The slot an instant falls in (UTC, floored to SLOT_MINUTES). */
export function slotOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SLOT_MS) * SLOT_MS);
}

/** Mail delivery, from the EmailLog-derived health (src/lib/emailHealth.ts). */
export function gradeMail(h: {
  failuresSinceOk: number;
  deferredSinceOk: number;
  firstDeferredSinceOkAt: string | null;
}, now: Date): Grade {
  if (h.failuresSinceOk >= 3) return 'degraded';
  // A short relay throttle is normal; deferrals with no delivery for 30 min are not.
  if (h.deferredSinceOk > 0 && h.firstDeferredSinceOkAt) {
    const since = now.getTime() - Date.parse(h.firstDeferredSinceOkAt);
    if (since > 30 * 60 * 1000) return 'degraded';
  }
  return 'ok';
}

/** Background jobs, from the queue health (src/lib/jobs/health.ts). */
export function gradeJobs(h: { oldestPendingAgeSec: number | null }): Grade {
  // Due work waiting 15 minutes means the worker is not keeping up (or stopped).
  return h.oldestPendingAgeSec !== null && h.oldestPendingAgeSec > 15 * 60 ? 'degraded' : 'ok';
}

export interface Sample {
  at: Date;
  mail: string;
  jobs: string;
}

export interface ComponentReport {
  key: ComponentKey;
  state: ComponentState;
  /** Share of expected slots in the window this component was available, 0…100, or null without data. */
  uptimePct: number | null;
}

export interface StatusReport {
  overall: ComponentState;
  components: ComponentReport[];
  /** Oldest first, WINDOW_DAYS entries (fewer only when the history is younger). */
  days: { date: string; state: DayState }[];
  /** The 90-day availability figure of the service (the `web` component). */
  uptimePct: number | null;
  /** When the history starts — the page says "since" when it is younger than the window. */
  since: Date | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Builds the page's report from the window's samples. Expected slots are
 * counted from the first sample on (a deployment is not "down" for the days
 * before the sampler existed), up to the last COMPLETED slot.
 */
export function buildReport(samples: Sample[], now: Date): StatusReport {
  const end = slotOf(now).getTime(); // the current slot is still open
  const windowStart = slotOf(new Date(now.getTime() - WINDOW_DAYS * DAY_MS)).getTime();
  const inWindow = samples.filter((s) => s.at.getTime() >= windowStart && s.at.getTime() < end + SLOT_MS);
  const bySlot = new Map<number, Sample>();
  for (const s of inWindow) bySlot.set(slotOf(s.at).getTime(), s);
  const first = inWindow.length ? Math.min(...inWindow.map((s) => slotOf(s.at).getTime())) : null;

  const expected = first === null ? 0 : Math.max(0, (end - first) / SLOT_MS);
  const counted = [...bySlot.keys()].filter((t) => t < end);
  const pct = (n: number) => (expected > 0 ? round3(Math.min(100, (n / expected) * 100)) : null);
  const web = pct(counted.length);
  const mailOk = pct(counted.filter((t) => bySlot.get(t)!.mail === 'ok').length);
  const jobsOk = pct(counted.filter((t) => bySlot.get(t)!.jobs === 'ok').length);

  // Current state: the newest sample must be from this slot or the one before,
  // else the service is down right now (or the sampler is).
  const newest = first === null ? null : Math.max(...bySlot.keys());
  const fresh = newest !== null && newest >= end - SLOT_MS;
  const latest = newest !== null ? bySlot.get(newest)! : null;
  const stateOf = (grade: string | undefined): ComponentState =>
    !latest ? 'unknown' : !fresh ? 'down' : grade === 'ok' ? 'operational' : 'degraded';
  const components: ComponentReport[] = [
    { key: 'web', state: !latest ? 'unknown' : fresh ? 'operational' : 'down', uptimePct: web },
    { key: 'mail', state: stateOf(latest?.mail), uptimePct: mailOk },
    { key: 'jobs', state: stateOf(latest?.jobs), uptimePct: jobsOk },
  ];
  const overall: ComponentState = components.some((c) => c.state === 'down')
    ? 'down'
    : components.some((c) => c.state === 'degraded')
      ? 'degraded'
      : components[0].state;

  const days: StatusReport['days'] = [];
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  for (let d = today - (WINDOW_DAYS - 1) * DAY_MS; d <= today; d += DAY_MS) {
    const dayEnd = Math.min(d + DAY_MS, end);
    const from = first === null ? null : Math.max(d, first);
    let state: DayState;
    if (from === null || from >= dayEnd) state = 'nodata';
    else {
      const want = (dayEnd - from) / SLOT_MS;
      const have = counted.filter((t) => t >= from && t < dayEnd).length;
      state = want <= 0 ? 'nodata' : have === 0 ? 'down' : have / want >= 0.99 ? 'up' : 'partial';
    }
    days.push({ date: new Date(d).toISOString().slice(0, 10), state });
  }

  return { overall, components, days, uptimePct: web, since: first === null ? null : new Date(first) };
}

/**
 * The published uptime commitment, from `STATUS_SLA_TARGET` (e.g. "99.5").
 * Unset, empty or outside 90…99.999 → null, and the page publishes no number:
 * a percentage on a public page is a commercial promise, so it exists only
 * when the operator has set one on purpose.
 */
export function slaTarget(raw: string | undefined): string | null {
  const s = (raw || '').trim();
  if (!/^\d{2}(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 90 && n <= 99.999 ? s : null;
}

export type IncidentSeverity = 'S1' | 'S2' | 'S3' | 'S4';
