// The duplicate scan's result cache (#1434). Dependency-free; unit-tested in
// scripts/test/duplicate-scan-cache.test.mjs.
//
// The scan reads every MENTEE of an org and compares the ones that could
// match: about 1 s of CPU at 5 000 mentees, paid again on every visit to
// /admin/duplicates, after every merge and on every reload. Its result depends
// only on those mentees' rows, so it is reused while a cheap fingerprint of
// them (row count + the latest updatedAt, one indexed aggregate) is unchanged.
// A merge or an edit moves the fingerprint, so the next visit rescans.
// MAX_AGE_MS bounds the reuse anyway, for a write that bypasses @updatedAt
// (a raw SQL statement): such a row is at most that stale.

export const DUPLICATE_SCAN_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 64;

export interface ScanCacheEntry<T> {
  fingerprint: string;
  at: number;
  value: T;
}

/** The fingerprint of an org's mentee rows. Pure: the caller runs the aggregate. */
export function scanFingerprint(count: number, latestUpdatedAt: Date | null, cap: number): string {
  return `${count}:${latestUpdatedAt ? latestUpdatedAt.getTime() : 0}:${cap}`;
}

export function makeScanCache<T>(maxAgeMs = DUPLICATE_SCAN_MAX_AGE_MS) {
  const entries = new Map<string, ScanCacheEntry<T>>();
  return {
    /** The stored value when the fingerprint still matches and it is young enough, else null. */
    get(orgKey: string, fingerprint: string, now: number): T | null {
      const hit = entries.get(orgKey);
      if (!hit || hit.fingerprint !== fingerprint || now - hit.at >= maxAgeMs) return null;
      return hit.value;
    },
    set(orgKey: string, fingerprint: string, value: T, now: number) {
      entries.delete(orgKey);
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      entries.set(orgKey, { fingerprint, at: now, value });
    },
    clear() {
      entries.clear();
    },
  };
}
