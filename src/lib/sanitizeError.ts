// The ONE sanitizer every connector's error text passes through before it is
// rendered or returned by an API (#2008). Grown out of `sanitizeEmailError`
// (#1190), which only knew about e-mail addresses because EmailLog was the only
// ledger being surfaced.
//
// A second sanitizer must not exist. Each connector leaks something different —
// an SMTP rejection echoes the recipient, a Google token refresh failure echoes
// the account and sometimes the refresh token, an SSO failure echoes the
// certificate subject or the PEM itself — and a per-connector scrubber means the
// next connector ships with whichever rule its author happened to remember.
// Add the rule here instead, and every existing surface gets it for free.
//
// No prisma import, so this stays safe to pull into a client component.

export function sanitizeError(error: string | null | undefined): string | null {
  if (!error) return null;
  return (
    error
      // A certificate/key body pasted into an error message. Whole block, not
      // just the base64 — the headers alone are worthless but very noisy.
      .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '<redacted>')
      // `Authorization: Bearer …`, `token=…`, `secret: …` and friends.
      .replace(/(?:bearer|token|secret|key|password)["'\s:=]+[^\s"',;]+/gi, '<redacted>')
      // Addresses BEFORE the opaque-blob rule below: a 32+ character local part
      // would otherwise be blanked first, leaving the domain behind because the
      // address rule no longer recognises `<redacted>@example.com`.
      .replace(/[\w.+-]+@[\w.-]+/g, '<redacted>')
      // Long opaque values with no separators — this repo's `icrm_` API keys,
      // Google refresh tokens, session ids, HMAC digests.
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
      .slice(0, 300)
  );
}
