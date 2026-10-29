// The sandbox key's rules (#1992) — pure, no imports beyond the scope list,
// unit-tested in e2e/sandbox-key.unit.spec.ts. `sandboxKey.ts` mints.
//
// WHO MAY MINT ONE: nobody, unless THIS deployment is the public demo AND its
// database is a demo database. Both, on purpose:
//   • DEMO_MODE=true alone is an env var — set by mistake on a real deployment
//     it would hand out keys to real tenant data;
//   • the database name ending in `_demo` is the same guard prisma/reset-demo.mjs
//     uses before it wipes anything, so the two can only be wrong together.
// The key is then bound to the deployment's default organisation, which on the
// demo is the synthetic seed (prisma/seed-demo.mjs) — never chosen by the caller.
//
// WHAT IT CAN DO: read only. Every `*:read` scope, nothing that writes, no hook
// subscriptions (the demo refuses /api/v1/hooks anyway — DEMO_BLOCKED_WRITES),
// and `interactions:read_notes` is not a `:read` scope. It expires after a day
// and carries a daily request allowance on top of the per-minute limit.
import { API_SCOPES, type ApiScope } from '../apiScopes';

export const SANDBOX_KEY_NAME = 'Sandbox key (developer portal)';
export const SANDBOX_KEY_TTL_MS = 24 * 60 * 60 * 1000;
export const SANDBOX_DAILY_QUOTA = 1000;
/** Live sandbox keys at once, deployment-wide — past it the portal answers 429. */
export const MAX_LIVE_SANDBOX_KEYS = 200;
/** Mints per address per hour. */
export const SANDBOX_MINTS_PER_HOUR = 3;

export const SANDBOX_SCOPES: readonly ApiScope[] = API_SCOPES.filter((s) => s.endsWith(':read'));

/** The database name of a `mysql://user:pass@host:port/NAME?params` URL, or ''. */
export function databaseName(url: string | undefined | null): string {
  const m = /^[a-z]+:\/\/[^/]*\/([^?#]*)/i.exec((url ?? '').trim());
  return m ? decodeURIComponent(m[1]) : '';
}

export function sandboxEnabled(env: Record<string, string | undefined>): boolean {
  return env.DEMO_MODE === 'true' && /_demo$/.test(databaseName(env.DATABASE_URL));
}
