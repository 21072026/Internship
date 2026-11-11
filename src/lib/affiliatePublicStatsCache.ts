// The per-organisation, time-boxed cache behind the public partner page's live
// figures (#3364). Dependency-free so its timing is unit-tested
// (scripts/test/affiliate-landing-rule.test.mjs); the reader that fills it is
// src/lib/affiliatePublicStats.ts.
//
// One entry per org, kept for `ttlMs`. A failed load is cached as null for the
// same window — the page then shows no live card rather than retrying the
// database on every visitor.

export function makeTtlCache<T>(ttlMs: number) {
  const entries = new Map<string, { at: number; value: T | null }>();
  return {
    async get(key: string, load: () => Promise<T>, now: number = Date.now()): Promise<T | null> {
      const hit = entries.get(key);
      if (hit && now - hit.at < ttlMs) return hit.value;
      let value: T | null;
      try {
        value = await load();
      } catch {
        value = null;
      }
      entries.set(key, { at: now, value });
      return value;
    },
    clear(key?: string) {
      if (key) entries.delete(key);
      else entries.clear();
    },
  };
}
