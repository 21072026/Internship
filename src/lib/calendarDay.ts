// A calendar day typed as `YYYY-MM-DD` → its UTC midnight, or null. PURE.
//
// `new Date('2026-02-31T00:00:00Z')` does not fail: it rolls over to 3 March, so a
// regex alone lets an impossible day through and silently moves a payment (and
// its commission window and due date). The parts are checked to come back
// unchanged.

export function parseCalendarDay(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}
