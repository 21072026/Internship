// Per-organization impersonation policy (#1586) — the rule, pure and
// dependency-free: middleware (edge runtime) imports it, so it must import
// nothing (scripts/test/impersonation-policy.test.mjs).
//
// THE POLICY, `Organization.impersonationPolicy`, of the TARGET user's org:
//   full       — today's behaviour, the default: nothing changes on upgrade.
//   read_only  — the admin may look, never change: the session carries an
//                `impersonationReadOnly` claim and middleware refuses EVERY
//                write from it centrally — one refusal, not a list of routes,
//                so a write route added tomorrow is covered by default.
//   off        — `POST /api/admin/impersonate` answers 403 and mints nothing.
//
// The refusal's only exceptions are the ways OUT and the plumbing a session
// needs: the stop route, NextAuth's own endpoints (the stop grant is redeemed
// through /api/auth/callback/impersonate; sign-out posts there too) and the
// browser's CSP reports. Deliberately NOT the general write allowlist of the
// unverified-user rule: the public apply form or an RSVP posted from an
// impersonated session is still a write made as someone else.

export const IMPERSONATION_POLICIES = ['full', 'read_only', 'off'] as const;
export type ImpersonationPolicy = (typeof IMPERSONATION_POLICIES)[number];

export function isImpersonationPolicy(v: unknown): v is ImpersonationPolicy {
  return typeof v === 'string' && (IMPERSONATION_POLICIES as readonly string[]).includes(v);
}

/** An unknown or missing value reads as the default, `full` — what every org had before. */
export function effectivePolicy(v: unknown): ImpersonationPolicy {
  return isImpersonationPolicy(v) ? v : 'full';
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isWayOut(pathname: string): boolean {
  return pathname === '/api/impersonate/stop' || pathname.startsWith('/api/auth/') || pathname === '/api/csp-report';
}

/** Does a read-only impersonation session's request get refused? */
export function readOnlyImpersonationBlocks(method: string, pathname: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase()) && pathname.startsWith('/api/') && !isWayOut(pathname);
}
