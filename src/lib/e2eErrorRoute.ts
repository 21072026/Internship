import { notFound } from 'next/navigation';

/**
 * Test-only hatch for the route-level error boundaries (#1602).
 *
 * A boundary is only worth anything if a real server throw actually reaches it,
 * and nothing in the app throws on demand — so `/mentor/e2e-error` and
 * `/portal/e2e-error` exist to do exactly that, and nothing else.
 *
 * Gated on `E2E_ERROR_ROUTES`, which is set by `playwright.config.ts` and by
 * nothing else. A `NODE_ENV` check would not do: CI serves a production build
 * (`npm run start`), so the guard has to be an explicit opt-in rather than a
 * dev-mode inference. Everywhere the flag is unset — preview, topic envs,
 * production — these routes are a plain 404.
 */
export function throwForE2E(scope: string): never {
  if (process.env.E2E_ERROR_ROUTES !== '1') notFound();
  throw new Error(`Forced ${scope} error for the e2e boundary spec`);
}
