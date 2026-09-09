// What an external system is allowed to overwrite on a user (#1943 / #1965).
//
// Two things in this product write user profile fields on somebody else's
// behalf: SSO/SCIM sync (#1943) and the scheduled roster feed (#1965). Both
// face the same question on every field, and it must have exactly ONE answer in
// the tree — two policies would mean the same tenant's data is treated
// differently depending on which pipe it arrived through, and the difference
// would only show up as a support ticket ("the app keeps resetting my phone
// number").
//
// THE POLICY
//   • An empty field is a gap the feed may fill, always. Nobody typed the empty
//     string, so nothing is being overwritten.
//   • A non-empty field is the tenant's own data. A NON-authoritative feed
//     leaves it alone even when it disagrees — a user who fixed their own phone
//     number in the app must not have it reverted at 03:00.
//   • An AUTHORITATIVE feed (the tenant said "the HR system is the record of
//     truth for these people") overwrites a disagreeing value.
//   • A field the feed does not mention at all is never touched, whatever the
//     mode. `undefined` means "no opinion"; only an explicit value is an
//     opinion. An explicit empty value from the feed is a no-opinion too: we do
//     not blank a field because a column was left empty in a spreadsheet.
//
// Pure, dependency-free and unit-tested (scripts/test/roster-ingest.test.mjs)
// so both consumers can share it without either importing the other's world.

/** A field value an external system can carry for a user. */
export type SyncableValue = string | number | boolean | Date | null | undefined;

export interface FieldUpdatePlan<T extends Record<string, SyncableValue>> {
  /** The fields to write, in the order they were declared. */
  changes: Partial<T>;
  /** Names of the fields in `changes` — the report's `changed` list. */
  changed: string[];
  /**
   * Fields the feed disagreed with and was not allowed to overwrite. Reported
   * so a preview can say "3 fields left alone" instead of silently dropping
   * them.
   */
  withheld: string[];
}

function isBlank(value: SyncableValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}

function sameValue(a: SyncableValue, b: SyncableValue): boolean {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : NaN;
    const bt = b instanceof Date ? b.getTime() : NaN;
    return at === bt;
  }
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
}

/**
 * Decide which of `incoming`'s fields may be written over `current`.
 *
 * `incoming` carries only the fields the external system mapped; a key that is
 * absent (or blank) is "no opinion" and never produces a change.
 */
export function planFieldUpdates<T extends Record<string, SyncableValue>>(
  current: T,
  incoming: Partial<T>,
  options: { authoritative: boolean },
): FieldUpdatePlan<T> {
  // Written through a widened alias: TypeScript cannot see that a key of `T`
  // indexes `Partial<T>` with the same value type once `keyof T` is narrowed to
  // its string members, and the cast is confined to this one line.
  const changes: Partial<T> = {};
  const write = changes as Record<string, SyncableValue>;
  const changed: string[] = [];
  const withheld: string[] = [];

  for (const [field, next] of Object.entries(incoming) as [keyof T & string, T[keyof T]][]) {
    if (isBlank(next)) continue; // the feed said nothing about this field
    const now = current[field];
    if (sameValue(now, next)) continue; // already agrees — not a write
    if (!isBlank(now) && !options.authoritative) {
      withheld.push(field);
      continue;
    }
    write[field] = next;
    changed.push(field);
  }

  return { changes, changed, withheld };
}
