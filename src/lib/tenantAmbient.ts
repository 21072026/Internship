// A client-safe seam onto the tenant context engine (#1553).
//
// `src/lib/orgContext.ts` is SERVER-ONLY: it imports `node:async_hooks`, and
// webpack fails the whole build ("Reading from node:async_hooks is not handled
// by plugins") the moment that module lands in a client graph. `src/lib/
// settings.ts` is in one — a client component imports a constant from
// `documentAccess.ts`, which reaches `settings.ts` through `retention.ts` — so
// settings.ts cannot import orgContext.ts, even though it genuinely needs two
// things from it: the org bound to the current request, and a way to run its own
// queries with the tenant auto-filter off so the global fallback row stays
// visible.
//
// This module is that seam. It holds two function slots and imports nothing, so
// it is safe anywhere. `orgContext.ts` fills the slots as a side effect of being
// loaded, which happens on every request that binds a tenant — `withTenantScope`
// lives there. When it has NOT been loaded the fallbacks below are the correct
// answers anyway: there is no bound context to read, and no middleware installed
// to escape from.

export type TenantAmbient = {
  // The orgId bound to the current async context; `undefined` when there is none.
  currentOrgId: () => string | null | undefined;
  // Run `fn` with the tenant auto-filter switched off for its queries.
  runUnscoped: <T>(fn: () => T) => T;
};

let ambient: TenantAmbient | null = null;

// Called once by src/lib/orgContext.ts when that module is evaluated.
export function registerTenantAmbient(impl: TenantAmbient): void {
  ambient = impl;
}

// The org bound to the current request, or `undefined` when nothing is bound
// (including when the server-only engine was never loaded).
export function ambientOrgId(): string | null | undefined {
  return ambient?.currentOrgId();
}

// Run `fn` outside any tenant scope. Without the engine loaded nothing is
// scoping in the first place, so calling `fn` directly is the same thing.
export function runUnscoped<T>(fn: () => T): T {
  return ambient ? ambient.runUnscoped(fn) : fn();
}
