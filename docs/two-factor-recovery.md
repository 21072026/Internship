# 2FA recovery codes (#1542)

The way back into an account whose authenticator is gone. Before this, an
organisation that switched `require2fa` on had no answer for a lost phone except
an admin editing MySQL by hand — which is the real reason the setting was
frightening to turn on.

## The rule, in one paragraph

Enabling 2FA mints **ten single-use codes**. The plaintext is returned by that
one response and **never again**; only an HMAC of each code is stored. At
sign-in, a submission that is not a live TOTP code is tried as a recovery code;
a match is consumed, audited at `warning`, and disclosed to the account holder.
The account page shows **how many are left**, never which, and can replace the
whole set at any time.

## Where each piece lives

| Concern | File |
|---|---|
| Format: alphabet, normalisation, "is this a recovery code?" | `src/lib/recoveryCodeFormat.ts` (dependency-free, unit-tested) |
| Mint / count / consume / clear | `src/lib/recoveryCodes.ts` |
| Sign-in wiring + the two failure buckets | `src/lib/auth.ts` (the `twoFactorEnabled` branch) |
| Enrolment, regeneration, counts | `src/app/api/account/2fa/route.ts` |
| The card | `src/components/AccountSettings.tsx` (`recoveryBlock`) |
| Table | `TwoFactorRecoveryCode` in `prisma/schema.prisma` |
| Spec | `e2e/two-factor-recovery.spec.ts`, `scripts/test/recovery-code-format.test.mjs` |

## The decisions that are not preferences

**Hashed at rest, with a keyed hash.** A code carries ~38 bits, so a bare
SHA-256 digest would be enumerable offline from a database dump in minutes. The
stored value is `HMAC-SHA-256(NEXTAUTH_SECRET, "2fa-recovery:" + normalised)` —
the same pattern as the unsubscribe and e-mail-action tokens. bcrypt, what a
*password* gets, is deliberately **not** used: verification compares against up
to ten stored hashes, and ten cost-12 comparisons per attempt is a
denial-of-service lever bolted onto the sign-in path. A work factor protects
low-entropy *human* input; these are CSPRNG output.

**Single-use, decided in the database.** `usedAt` is stamped by a conditional
`updateMany` (`where: { id, usedAt: null }`). Reading `usedAt` in JavaScript and
then writing would let two tabs spend the same code; here the loser writes zero
rows and is refused like any wrong code.

**Two failure buckets, not one, and not a replacement.** A failed recovery
attempt is recorded against the **`totp`** bucket (5 / 15 min) *and* its own
**`recovery`** bucket (5 / 60 min).

- Sharing the TOTP bucket is what stops the recovery path being a way to
  brute-force *around* the authenticator's limit.
- Having its own is what stops it *inheriting* that allowance: a second door to
  the account cannot be given the same budget as the first, and the longer
  window catches guessing paced to stay under the 15-minute limit.

Only a submission **shaped** like a recovery code is tried as one, so a fumbled
6-digit code is never charged to the recovery bucket. The refusal message is the
same in every case — the form asks for one thing and refuses one thing.

**Shown once.** The plaintext is returned by `enable` and `regenerate-codes` and
by nothing else. `GET /api/account/2fa` answers with counts. The component holds
the set in state for that one render; there is no localStorage, no URL and no
re-fetch.

**Regeneration is not gated on a fresh authenticator code**, unlike `disable`.
The person who most needs a new set is the one who just signed in *with* a
recovery code because the authenticator is gone; asking them for a TOTP code
would lock the door behind them. The session is the proof — they are through the
second factor by one of its two routes, and impersonation is refused as it is for
every other 2FA mutation.

**The audit is louder than a normal sign-in.** A recovery sign-in writes
`2fa.recovery_used` at `warning` and notifies the owner through
`security.recoveryCodeUsed`, which sits in an essential e-mail group and
therefore ignores preferences: it is a disclosure, not a notification. If the
reader did not do it, the printed codes are in somebody else's hands.

**`lastTotpStep` is left alone** on a recovery sign-in. No TOTP step was
consumed, and writing one would move the replay floor the authenticator still
depends on (#865).

## Not in scope here

- **Admin-side 2FA reset** is #1543. This task is the mint/consume side only.
- **`disable` still requires a TOTP code.** A user with no authenticator can get
  *in* with a recovery code and refill the set, but cannot switch 2FA off
  unaided; that is the admin path above.
