/**
 * Demo-mode detection and utilities.
 *
 * When DEMO_MODE=true the app runs as a public, read-mostly demo instance
 * (e.g. crm-demo.ersah.in).  All write operations are blocked at the
 * middleware level; a prominent banner is shown on every page; and the demo
 * data is periodically reset by an external scheduler that calls
 * `/api/demo/reset` with the `DEMO_RESET_SECRET`.
 *
 * Key environment variables (server-side only — never NEXT_PUBLIC_):
 *   DEMO_MODE          — "true" activates demo mode
 *   DEMO_RESET_SECRET  — shared secret that authorises the reset endpoint
 *
 * This module is safe to import in both server and client components; the
 * `isDemoMode` flag is evaluated at server render time and injected into the
 * page via the layout.
 */

/** True when running as the public demo instance. */
export const IS_DEMO_MODE: boolean =
  process.env.DEMO_MODE === 'true';

/**
 * Paths that must remain writable even in demo mode so that visitors can
 * sign in / out and the reset cron can run.
 */
export const DEMO_WRITE_ALLOWLIST: readonly string[] = [
  '/api/auth/',        // NextAuth sign-in / sign-out / session
  '/api/demo/reset',  // scheduled reset endpoint
];

/**
 * Returns true for paths that are allowed to mutate data in demo mode.
 * The comparison is prefix-based (same convention as the unverified-user gate
 * in middleware.ts).
 */
export function isDemoAllowlisted(pathname: string): boolean {
  return DEMO_WRITE_ALLOWLIST.some((prefix) => pathname.startsWith(prefix));
}
