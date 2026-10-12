# Security notices (#1717)

"Something changed on your account" mail — and the in-app row beside it — for the
events an account owner must hear about even when they did not cause them:

| Kind | When | Context quoted |
|------|------|----------------|
| `newDevice` | A password or magic-link sign-in from a browser the account has not signed in from before | browser, IP |
| `deviceTokenReuse` | A superseded "keep me signed in" cookie was replayed (the device was just revoked, `docs/remember-me.md`) | the **replayer's** browser and IP |
| `passwordChanged` | `/api/account` password change, or a completed reset link | browser, IP |
| `emailChanged` | `/api/account` e-mail change — sent to the **old and the new** address | browser, IP |
| `twoFactorEnabled` / `twoFactorDisabled` | `/api/account/2fa` enable / disable | browser, IP |
| `recoveryCodesRegenerated` | `/api/account/2fa` regenerate-codes | browser, IP |
| `sessionsRevoked` | The owner's own "sign out of all devices" | browser, IP |
| `adminSignedOutAll` | An administrator signed the account out of everything | none (the request is the admin's) |

The admin 2FA reset keeps its own, older mail (`sendTwoFactorResetEmail`, #1543): it
names the administrator, which this family deliberately does not.

## One sender

`src/lib/securityNotices.ts` is the only place a notice is composed or sent:

- `sendSecurityNotice(kind, { userId, request?, device?, ip?, emailChange? })` — awaited
  by the account routes. Never throws: a failed notice must not fail the action.
- `fireSecurityNotice(...)` — the detached variant for a path where a person is waiting
  (the remember-me refresh route).
- `observeSignInDevice(userId, request)` — called by the `credentials` and `magic`
  providers in `src/lib/auth.ts` after a successful sign-in. Writes the device row
  **before** returning (the next sign-in from that browser must find it) and detaches the
  mail.

Each call produces the in-app row through `notifyEvent(..., { channels: ['inApp'] })` —
the catalogue entries are `security.<kind>` in `src/lib/notifications/catalog.ts` — and the
mail inline through `sendEmail({ category: 'security', userId, orgId })`. The router's
e-mail channel is not used because it only enqueues a `notification.email` job that no
worker consumes yet; when that worker lands, this module is the one place to switch.

The mail is rendered in the recipient's `preferredLanguage` from the
`securityNoticeEmail` dictionary block (EN/TR/DE), with the instant in their `timezone`
(`formatDateTimeWithZone`), the device label `deviceLabel()` composes, the IP as the
proxy chain reports it, a CTA to `/account` on the recipient org's own host
(`emailBrand(orgId).appUrl`, `docs/worlds.md`) and a fixed "not you?" line.

## Why nothing can silence it

`category: 'security'` resolves to the **essential** `account_security` e-mail group
(`src/lib/emailGroups.ts`): `sendEmail()` skips every preference, quiet hour and
unsubscribe for it and adds no footer or `List-Unsubscribe` header. The in-app row is in
an essential group as well, so the category switches on `/account` do not hide it.
`scripts/test/sign-in-device.test.mjs` pins that every kind stays in that group, and
`e2e/security-notices.spec.ts` drives the routes for a user with every switch off and
reads the `EmailLog` row: SKIPPED `SMTP not configured`, never `Unsubscribed`.

## The new-device rule

`src/lib/signInDeviceRule.ts` (pure, unit-tested) + `src/lib/signInDevice.ts` (Prisma):

- A **device** is `sha256(userAgent)`, the agent capped at 512 bytes. Two tabs of one
  browser are one device; a browser upgrade is a new one. Deliberately coarse — a harder
  fingerprint would be a tracking technique, and the point is a label the owner recognises.
- One `SignInDevice` row per `(userId, fingerprint)` (user-keyed, no `orgId`, like
  `TrustedDevice`), with the label, the agent, the last IP and first/last seen.
- A notice is due **only when the sign-in created the row and the account already had
  one**. The first browser is the baseline — nothing to compare against — so the rollout
  is silent: every existing account's next sign-in writes its baseline and mails nobody.
- A concurrent first sign-in from the same browser loses the unique race and is reported
  as "not created": two tabs cannot earn two notices.
- Rows are capped at 20 per account (oldest by last use dropped) and forgotten after 180
  days without a sign-in by the nightly trusted-device purge (`emailService.ts`,
  `purgeStaleSignInDevices`), so a long-unused browser is "new" again.

Not covered, by design: SSO and Google sign-ins reach NextAuth's `events.signIn` with no
request, so there is no browser to compare; the `remember` provider is the same browser
by definition; impersonation is already disclosed by its own notice.

## What a notice never carries

A token, a hash, a password, a recovery code (the regenerate notice says only that the old
set is dead), the raw user-agent (only the label), or a geolocation — the IP is quoted as
reported so the reader can recognise their own network; nothing is looked up.

## Tests

- `npm run test:sign-in-device` — the rule, the catalogue/dictionary/group contract, the
  placeholders the copy may use.
- `e2e/security-notices.spec.ts` — password change under total opt-out (`@smoke`), e-mail
  change to both addresses, baseline / new browser / repeat browser.
- `e2e/remember-me.spec.ts` — the replay test now also asserts the `deviceTokenReuse`
  notice.
