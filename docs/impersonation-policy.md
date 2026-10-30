# Impersonation policy (#1586)

"Sign in as a user" (`POST /api/admin/impersonate`, the `impersonate`
NextAuth provider) is the most-questioned support feature. A tenant's works
council or data-protection officer asks two things about it: can we turn it
off, and can it be made read-only? `Organization.impersonationPolicy` answers
both.

The rule is `src/lib/impersonationPolicyRule.ts`. It is pure, imports nothing
(middleware runs on the edge), and is tested in `scripts/test/impersonation-policy.test.mjs`.

| Policy | What happens |
|---|---|
| `full` (default) | Today's behaviour; nothing changed on upgrade. Every start and stop is audited, and the person is told. |
| `read_only` | The admin may look but not change anything. The START grant carries `readOnly`, and the session carries the `impersonationReadOnly` JWT claim. **Middleware refuses every API write** from that session: `403 { code: 'impersonation_read_only' }`. |
| `off` | The start answers `403 { code: 'impersonation_off' }`. No grant is minted, no audit row or notice is written, because no access happened. |

**The TARGET's organization decides**, not the admin's: the policy protects
the people being viewed.

**Read-only is ONE central refusal.** It sits in `src/middleware.ts`, beside
the unverified-user rule, and runs before the general write allowlist. A route
written tomorrow is therefore covered by default, with no per-route block. The
only writes that pass are the ways out:

- `/api/impersonate/stop`
- NextAuth's own `/api/auth/*`: the stop grant is redeemed at
  `/api/auth/callback/impersonate`, and sign-out posts there too
- `/api/csp-report`

The public forms on the unverified-user allowlist (apply, RSVP, …) are **not**
let through. A form posted from someone else's session is still a write made
as them.

The claim is fixed when the session starts. Changing the policy mid-session
does not upgrade or downgrade a running impersonation; that ends at its
30-minute cap or at stop. The policy is set:

- on `/admin/organizations` (the "Sign in as a user" card), or
- at `PATCH /api/admin/organizations/[id]/impersonation-policy`.

Either way it needs the org's own ADMIN (`org.settings.write`) or a super
admin of its world. Every change is an `org.impersonation_policy_changed`
audit entry at warning level. The banner shows "Read-only" during such a
session.
