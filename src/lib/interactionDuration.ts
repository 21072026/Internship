// Session length on an interaction log (#3521) — client-safe, no Prisma import.
//
// One bound for every door (the app form, the edit route, /api/v1, the chat
// card): a whole number of minutes, 1…600. The chat card offers PRESETS; the
// app form takes any value inside the bound. A log without a length is NULL —
// nothing here ever fills one in.

export const DURATION_MIN = 1;
export const DURATION_MAX = 600;
export const CHAT_DURATION_PRESETS = [15, 30, 45, 60, 90] as const;

export function isValidDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= DURATION_MIN && value <= DURATION_MAX;
}

/** A form's text as a duration: '' → null (cleared), a valid whole number → it, anything else → undefined (invalid). */
export function parseDurationInput(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return isValidDuration(n) ? n : undefined;
}

/** "45 min", "1 h", "1 h 30 min" — the unit words come from the caller's dictionary. */
export function formatDuration(minutes: number, units: { minutes: string; hours: string }): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(units.hours.replace('{n}', String(h)));
  if (m > 0 || h === 0) parts.push(units.minutes.replace('{n}', String(m)));
  return parts.join(' ');
}

/** The minutes a list of logs adds up to — logs without a length count as nothing, never as a guess. */
export function totalDuration(rows: readonly { durationMinutes?: number | null }[]): number {
  return rows.reduce((sum, r) => sum + (isValidDuration(r.durationMinutes) ? r.durationMinutes : 0), 0);
}

/** The chat card's button value: "<minutes>:<interactionId>", parsed back strictly. */
export function encodeDurationChoice(interactionId: string, minutes: number): string {
  return `${minutes}:${interactionId}`;
}

export function decodeDurationChoice(value: string | null | undefined): { minutes: number; interactionId: string } | null {
  const match = /^(\d{1,3}):([A-Za-z0-9_-]{1,64})$/.exec(value ?? '');
  if (!match) return null;
  const minutes = Number(match[1]);
  return isValidDuration(minutes) ? { minutes, interactionId: match[2] } : null;
}
