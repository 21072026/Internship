// Self-serve tenant signup (#1749/#1751) — the ONE reading of the switch, so
// the endpoint (the control) and the pages that link to it (cosmetic) can
// never disagree about whether it is on. Dependency-free on purpose: the unit
// test loads it with plain `node --test`.
//
// OFF unless SELF_SERVE_SIGNUP is exactly 'true'. It stays off in production
// until the multi-tenancy isolation epic lands: a live second tenant is a
// data-exposure risk while MT_ENFORCE_ISOLATION is dormant.
export function selfServeSignupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SELF_SERVE_SIGNUP === 'true';
}

/** 5 signups per IP per hour: an unauthenticated write that creates a tenant. */
export const SIGNUP_ORG_RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 } as const;
