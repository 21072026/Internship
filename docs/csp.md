# Content-Security-Policy: from `unsafe-inline` to a nonce (#1552)

The policy lives in **one** file, [`src/lib/cspPolicy.cjs`](../src/lib/cspPolicy.cjs).
It is CommonJS because `next.config.js` loads it before any TypeScript exists. Both
policies are built from the same host lists:

| Policy | Header | Where it is set | `script-src` |
|---|---|---|---|
| **Permissive** | `Content-Security-Policy` | `next.config.js`, every response (on pages only until the middleware replaces it) | `'self' 'unsafe-inline' 'unsafe-eval'` + hosts. Pinned byte-for-byte by `scripts/test/csp-policy.test.mjs` |
| **Strict** | `Content-Security-Policy-Report-Only`, or `Content-Security-Policy` with `CSP_ENFORCE=1` | `src/middleware.ts`, page requests only | `'self' 'nonce-<per request>' 'strict-dynamic'` + hosts. `'unsafe-eval'` is added only outside production, because React's dev runtime evaluates code |

### Modes

| Env | Pages enforce | Pages report |
|---|---|---|
| default | permissive | strict (report-only) |
| `CSP_ENFORCE=1` | **strict** — the middleware's header replaces next.config.js's, so a page carries ONE enforced policy | strict violations too (`report-uri` stays) |
| `CSP_REPORT_ONLY=0` (and no `CSP_ENFORCE=1`) | permissive | nothing |

Both are read per request at runtime: switching is an env change and a restart,
not a rebuild. `/embed` (the Teams tab) follows the same mode, with its own
`frame-ancestors`. The e2e servers run with `CSP_ENFORCE=1`
(`playwright.config.ts`; `E2E_CSP_MODE=report` for the report-only mode).

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
4. `'strict-dynamic'` trusts EXTERNAL scripts that a nonced script inserts, such
   as Next's chunks, the JaaS `external_api.js`, the analytics loaders and the
   consent-gated chat widget (and the modules those import). It does **not**
   trust an inline `<script>` we insert: inline code needs the nonce. That is why
   the analytics `init` is a function call after the loader's `load` event
   (`src/lib/analytics.ts`), not an inline script. Hosts in `script-src` are
   ignored by CSP3 browsers under `'strict-dynamic'` and kept for older ones.
5. JSON-LD (`<script type="application/ld+json">`) is not executable, so it needs
   no nonce.
6. zod 4's `eval` probe is switched off in the browser; see **Zod's `eval` probe
   (#3642)** below.

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

Turn the header off with `CSP_REPORT_ONLY=0`; enforce it with `CSP_ENFORCE=1`.

**Zod's `eval` probe (#3642).** Zod 4 probes `new Function("")` once per page to
decide whether it may compile schemas; under the strict policy (no
`'unsafe-eval'` in production) that probe is a `blocked: eval` report even though
zod catches the throw. It was every `eval` report the stream carried — the
sign-in page above all — and in CI the reports filled the endpoint's per-IP
limit, so later reports got 429 and the smoke test read the browser's console
error as a failure. The browser therefore runs zod `jitless`
(`src/lib/zodBrowserConfig.ts`, installed in `src/instrumentation-client.ts`,
which runs before any app module: zod probes while a `z.object()` is
*constructed*, and schemas are built at module load); the server keeps the JIT. `scripts/test/zod-browser-config.test.mjs` pins that a
browser-configured parse never calls `new Function`.

## Steps

1. **Report-only, nonce, endpoint** — this change. The print popup of the document
   templates (`TemplatesLibrary.tsx`) used to print itself from an inline
   `<script>`. That popup inherits our CSP, so it now prints from the opener.
2. **Read the stream.** The middleware matcher covers `/auth/*` too, so the
   sign-in, register, reset, magic-link, SSO and 2FA pages carry the nonce like
   every other page. None of the middleware's redirects applies there:
   `wantsResume()` returns false for `/auth/*` (so `/auth/resume` cannot loop),
   the `/en` 308 and the language rewrite cover public pages only, and the write
   gates refuse only writes, which nothing sends to a page (no server actions).
   `e2e/security-headers.spec.ts` pins this with a remembered browser. Run the
   e2e suite and the deployed environments under report-only, and bind every
   remaining inline script or `eval` to the nonce or remove it.
3. **Enforce behind a flag** (default off) — done. `CSP_ENFORCE=1` makes the
   strict policy the page's `Content-Security-Policy`. The stream's only real
   violation, zod's eval probe, is closed (`jitless`), and the analytics init no
   longer inserts inline scripts. The e2e servers enforce, and
   `e2e/security-headers.spec.ts` asserts one enforced policy per page with
   neither `'unsafe-inline'` nor (in a production build) `'unsafe-eval'`.
   **Left to the operator:** set `CSP_ENFORCE=1` on preview, then production,
   once their `csp.violation` stream is quiet with this build deployed.

`style-src` keeps `'unsafe-inline'` in both policies. React writes `style`
attributes, which a nonce cannot cover, and #1552 is about `script-src`.
