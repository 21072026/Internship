# Two-factor policy and enrolment coverage (#1644)

`require2fa` is a per-org setting (read through the #1553 chain: the org's row → the
global row → `off`). It decides which roles are held at `/security-setup` until they turn
two-factor authentication on.

| Mode | Held at the gate |
|------|------------------|
| `off` (default) | nobody |
| `admins` | ADMIN |
| `admins_mentors` | ADMIN, MENTOR |
| `all` | every role: ADMIN, MENTOR, MENTEE, COMPANY, SOURCE |

## One vocabulary

`src/lib/twoFactorPolicyRule.ts` is pure and dependency-free, so the settings form (a
client component), the server gate and `scripts/test/two-factor-policy.test.mjs` read the
same rule: `rolesCoveredBy(mode)`, `roleCoveredBy(mode, role)`, `isStricterMode(next,
current)` (set inclusion: `next` covers a role `current` does not), and the coverage
arithmetic. `src/lib/twoFactorPolicy.ts` is the server half: `is2faRequiredFor(role,
orgId)` and `require2faModeOf(orgId)`. An unknown stored value reads as `off`.

## The gate

Every authenticated role shell runs the same server-side check before it renders:

```ts
if (!session.user.impersonatorId && !me?.twoFactorEnabled &&
    (await is2faRequiredFor(session.user.role, await settingsOrgOf(session)))) {
  redirect('/security-setup');
}
```

It lives in `src/components/RoleShell.tsx` and the admin, mentor, portal, sales,
company and source layouts — the last two were added by #1644, because `all` is a false
claim if a role can walk around it. Impersonation always skips it: the admin behind the
session is already authenticated and cannot enrol on someone else's behalf. The gate page
(`src/app/security-setup/page.tsx`) sends anyone the policy does not hold back home.
Never gate on the client.

## Coverage report

`GET /api/admin/2fa-coverage` — admin-only (401 without a session, 403 for a non-admin),
the org taken from the session through `tenantWhere(session)`, never from a parameter:

- `roles[]`: per role, `{ total, enabled, percentage }` over **active** accounts — a
  deactivated account cannot sign in, so the gate never holds it and counting it would
  understate the coverage. A role nobody holds reads as 100 %.
- `overall`, and `inScope` (the roles the current policy covers).
- `missing`: the active accounts without 2FA, paginated (`page`, `perPage` ≤ 100), with
  name, e-mail, role and last sign-in. `?format=csv` returns the whole list as a file.

`/admin/settings` shows it as a card next to the policy select, and the line under the
select gives the coverage of the **selected** mode.

## The lockout guard

The gate holds people on their next page load, so turning `all` on at 0 % mentee
enrolment locks the whole tenant out at once. Saving a mode that `isStricterMode()` than
the saved one opens a confirmation that names how many active accounts without 2FA the
newly covered roles hold (`newlyHeldAtGate()`), and points at the recovery story: recovery
codes (#1542) and the admin 2FA reset (#1543). Relaxing a policy never asks.

## Tests

- `npm run test:two-factor-policy` — the vocabulary and the arithmetic.
- `e2e/two-factor-all-mode.spec.ts` — `all` holds a mentee, a company and a source login
  at the gate and `off` releases them (`@smoke`); two orgs with different policies; the
  report's tenant scoping, 401/403 and CSV; the stricter-mode confirmation.
- `e2e/two-factor-enforcement.spec.ts` — the `admins` mode, unchanged.
