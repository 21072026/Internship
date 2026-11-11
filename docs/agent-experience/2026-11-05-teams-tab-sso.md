# 2026-11-05 — A sign-in door inside a cross-site iframe

- **NextAuth's credentials flow does not work in a cross-site iframe.** `signIn()` posts with the
  `next-auth.csrf-token` cookie, which is `SameSite=Lax`, and a browser never sends a Lax cookie
  to a frame that sits under another site (Teams). Redeem the grant in your own route, and pass
  the user through `authOptions.callbacks.jwt` plus `next-auth/jwt` `encode()`. Claims are then
  still decided only in the jwt callback.
- **Keep the embed session in its own cookie and translate at the edges.** Middleware hands the
  embed cookie over as the session cookie, on the request side only and only when no real one is
  present, and marks the request (strip any inbound marker first). The `[...nextauth]` route
  rewrites any session Set-Cookie on a marked request back to the embed cookie. Main cookie
  name and SameSite stay untouched.
- **`getToken()` in middleware takes a `cookieName`.** Pass the embed name when that cookie is
  the session in play, so the write gates see the same token the handlers will.
- **Framing is set per request for one path.** A `next.config.js` `source` regex
  (`/:path((?!embed(?:/|$)).*)`) keeps the global DENY headers off `/embed`. The middleware then
  sets that path's CSP: Teams hosts when configured, `'none'` + DENY otherwise. A header test
  should cover a look-alike path (`/embedded`) too.
- **The Bot Framework e2e stub doubles as Entra.** Its `/__sign` signs arbitrary claims with a
  key it publishes at `/keys`; point `TEAMS_SSO_JWKS_URL` there. `{ foreign: true }` gives a
  forged signature.
- **NextAuth's `/api/auth/session` answers `null`, not `{}`, for a revoked token.**
