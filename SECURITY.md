# Security overview

This document summarizes the security model of Internship CRM and the controls
added in the security-hardening epic (#182).

## Authentication
- **NextAuth (Credentials)** with JWT sessions. Passwords hashed with **bcrypt** (cost 12).
- **Password policy** (`src/lib/password.ts`): min 8 chars, at least one upper- and one lower-case letter. Enforced on register, reset and password change.
- **No user enumeration**: sign-in returns a single generic *“Invalid email or password”* for both unknown email and wrong password.
- **Brute-force throttle**: failed logins are counted per email (10 / 15 min); successful logins reset the counter. Failed attempts are written to the activity log (`auth.login_failed`).
- **Email verification**: unverified accounts are read-only (write APIs blocked by `src/middleware.ts`).
- **Deactivation**: admins can disable accounts; inactive users cannot sign in.

## Re-authentication for sensitive actions
- Changing **email**, changing **password**, and **deleting the account** all require the current password (`/api/account`).
- Impersonation (`/api/admin/impersonate`) is ADMIN-only, single-use grant based, audited, and cannot be used to delete the impersonated account.

## Authorization (RBAC + ownership)
Every API route checks the session and the appropriate role; resource routes additionally verify ownership to prevent IDOR:

| Area | Rule |
|------|------|
| `/api/admin/*`, `/api/users`, `/api/candidates`, `/api/search`, `/api/status-changes`, `/api/invite`, `/api/companies` | ADMIN only |
| `/api/mentorship/[id]`, `/api/interactions[/id]`, `/api/meetings` | ADMIN **or** the mentor who owns the relation |
| `/api/cv/[userId]`, `/api/avatar` | owner, ADMIN, or the mentee’s mentor (`src/lib/cvAccess.ts`) |
| `/api/profile`, `/api/account[/export]`, `/api/notifications` | the authenticated user, scoped to their own data |
| `/api/apply`, `/api/rsvp`, `/api/auth/*`, `/api/profile-view` | public by design (unguessable token or anti-enumeration) |

## Rate limiting
`src/lib/rateLimit.ts` (in-memory, per-process fixed window) guards auth and public endpoints: forgot, reset, register, apply, rsvp, and login. Returns **429** with `Retry-After` when exceeded. For a multi-instance deployment, back this with Redis.

## HTTP security headers
Set for all routes in `next.config.js`: Content-Security-Policy (self by default), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and HSTS.

## Auditing & privacy
- **Activity log** (`ActivityLog`) records auth events, profile/stage changes, account email/password change and deletion, impersonation, and failed logins. Viewable by admins at `/admin/activity`.
- **Data export** (`/api/account/export`) lets a user download all their own data; **consent** is recorded at registration; see `/privacy`.

## Reporting a vulnerability
Email the maintainer (see repository owner). Do not open public issues for sensitive reports.
