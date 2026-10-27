# Content-Security-Policy: from `unsafe-inline` to a nonce (#1552)

The policy lives in **one** file, [`src/lib/cspPolicy.cjs`](../src/lib/cspPolicy.cjs).
It is CommonJS because `next.config.js` loads it before any TypeScript exists. Both
policies are built from the same host lists:

| Policy | Header | Where it is set | `script-src` |
|---|---|---|---|
| **Enforced** | `Content-Security-Policy` | `next.config.js`, every response | `'self' 'unsafe-inline' 'unsafe-eval'` + hosts. Unchanged by #1552 and pinned byte-for-byte by `scripts/test/csp-policy.test.mjs` |
| **Strict** | `Content-Security-Policy-Report-Only` | `src/middleware.ts`, page requests only | `'self' 'nonce-<per request>' 'strict-dynamic'` + hosts. `'unsafe-eval'` is added only outside production, because React's dev runtime evaluates code |

## How the nonce travels

1. The middleware mints `btoa(crypto.randomUUID())` per page request. It writes the
   strict policy to the **request** (`content-security-policy-report-only`) and to
   `x-nonce`, and the policy alone to the response. Both inbound headers are
   deleted first, so a client can never choose the nonce.
2. Next.js reads the nonce from that request header (it accepts the report-only
   one) and stamps it on every `<script>` it renders. The root layout is dynamic
   (it reads `headers()`), so every page gets a fresh one.
3. Our single inline script, the theme no-flash snippet in `src/app/layout.tsx`,
   reads `x-nonce`. It carries `suppressHydrationWarning` because a browser hides
   a parsed nonce from the DOM, so hydration would read `""` there.
4. `'strict-dynamic'` trusts scripts that a nonced script inserts, such as Next's
   chunks, the JaaS `external_api.js` and the consent-gated chat widget. Hosts in
   `script-src` are ignored by CSP3 browsers under `'strict-dynamic'` and kept for
   older ones.
5. JSON-LD (`<script type="application/ld+json">`) is not executable, so it needs
   no nonce.

## The report stream

Browsers post violations to `POST /api/csp-report`, in either the legacy
`application/csp-report` shape or the Reporting API batch shape:

- The endpoint is anonymous by nature. It is rate-limited to 60 per 10 min per IP,
  the body is capped at 64 KB, and nothing is stored.
- Each violation is logged as `csp.violation` with only the fields
  `src/lib/cspReport.ts` lets through: the directive, the blocked origin or
  keyword, the page **path**, and the source origin+path with line and column.
- The query string, fragment, `script-sample`, referrer and original policy are
  dropped, because query strings carry tokens.
- The endpoint is exempt from the e-mail-verification gate (the browser sends it
  for any account). It passes the cross-site write gate as an ordinary
  same-origin POST.

Turn the header off with `CSP_REPORT_ONLY=0`.

## Steps

1. **Report-only, nonce, endpoint** — this change. The print popup of the document
   templates (`TemplatesLibrary.tsx`) used to print itself from an inline
   `<script>`. That popup inherits our CSP, so it now prints from the opener.
2. **Read the stream.** Note that the middleware matcher skips `/auth/*`, so the
   sign-in pages carry no report-only policy yet. Widening the matcher is part of
   this step. Run the e2e suite and the deployed environments under
   report-only, and bind every remaining inline script or `eval` to the nonce or
   remove it.
3. **Enforce behind a flag** (default off). Once the stream is quiet, a flag swaps
   the strict policy into the enforced header. When it is on,
   `e2e/security-headers.spec.ts` asserts that `script-src` has neither
   `'unsafe-inline'` nor `'unsafe-eval'`.

`style-src` keeps `'unsafe-inline'` in both policies. React writes `style`
attributes, which a nonce cannot cover, and #1552 is about `script-src`.
