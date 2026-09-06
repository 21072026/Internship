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
      // `token=…`, `secret: …`, `password="…"` — an EXPLICIT assignment. The
      // `:` or `=` says the next thing is a value, so it goes however short it
      // is.
      .replace(/(?:bearer|token|secret|key|password)\s*["']?\s*[:=]\s*["']?[^\s"',;]+/gi, '<redacted>')
      // `Authorization: Bearer eyJ…` — only whitespace between the word and the
      // value. Here the word may just be an English word in a sentence, so what
      // follows is redacted only when it LOOKS like a credential: at least 12
      // characters and carrying non-alphabetic material. Without that guard this
      // rule ate the next word of every provider message it touched — Google's
      // own "Token refresh failed" rendered as "<redacted> failed", and
      // "invalid_grant: Token has been expired or revoked." lost the word that
      // told the user what happened. A short space-separated secret escapes this
      // rule, which is the trade: an unquoted six-character bearer token is not
      // a thing, a sentence starting with "Token" is.
      .replace(/(?:bearer|token|secret|key|password)["'\s]+(?=\S*[\d_\-.])[^\s"',;]{12,}/gi, '<redacted>')
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
