// Who hears that a new lead was put on their book (#3968) — the pure half of
// src/lib/leadAssignedNotice.ts, unit-tested in scripts/test/lead-assigned-notice.test.mjs.
// ZERO imports.

/** Whether a new lead's owner hears about it: someone else assigned it, to staff. */
export function leadAssignedNoticeDue(input: {
  ownerId: string | null | undefined;
  ownerRole: string | null | undefined;
  actorId: string | null | undefined;
}): boolean {
  if (!input.ownerId) return false;
  if (input.actorId && input.ownerId === input.actorId) return false;
  return input.ownerRole === 'ADMIN' || input.ownerRole === 'MENTOR';
}
