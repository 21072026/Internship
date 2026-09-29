// Spending a single-use sign-in grant (#2548).
//
// The SSO, impersonation and remember-me grants are one-shot tokens: a session
// may be minted from each exactly once. The providers in src/lib/auth.ts used to
// read the grant, check `used` in JavaScript and then write it — and between the
// read and the write a second redemption of the same grant (two tabs, a
// double-fired effect on /auth/sso/complete, a leaked URL raced against its
// owner) passed the same check and got a session too.
//
// The spend is therefore ONE conditional UPDATE: the database checks `used` and
// the expiry in the same statement that flips the flag, so of any number of
// concurrent callers exactly one sees `count === 1`. Same rule as the 2FA
// recovery codes (src/lib/recoveryCodes.ts). The earlier read stays in each
// provider for the grant's other fields; it is no longer the gate.
//
// Dependency-free on purpose (the caller passes its own Prisma delegate call),
// so the rule is unit-tested in scripts/test/grant-spend.test.mjs.

export interface GrantSpendWhere {
  id: string;
  used: false;
  expiresAt: { gt: Date };
}

/**
 * Flip a grant to used if — and only if — it is still unused and unexpired.
 * `updateMany` is the caller's `(where) => prisma.<grant>.updateMany({ where,
 * data: { used: true } })`. True means this caller, and nobody else, spent it.
 */
export async function spendGrant(
  updateMany: (where: GrantSpendWhere) => Promise<{ count: number }>,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await updateMany({ id, used: false, expiresAt: { gt: now } });
  return result.count === 1;
}
