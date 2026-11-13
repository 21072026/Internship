## 2026-11-13 — nonce CSP steps 2 and 3 (#1552, #3626)

- **Read the report stream from the scheduled e2e logs.** `csp.violation` lines reach the job log
  through the webServer's stderr. Fetch one shard's log (`get_job_logs`, ~600 KB), then group the
  lines by `source:line:column`. For #1552 that showed 132 reports from ONE place, zod 4's eval
  probe (`chunks/<id>.js:1:<col>`, mapped by reading the column in the local build).
- **`'strict-dynamic'` trusts inserted EXTERNAL scripts only.** An inline `<script>` built with
  `createElement` + `textContent` is blocked. The report stream never showed it because CI
  configures no analytics. Grep for `textContent` / `innerHTML` on script elements before
  enforcing anything.
- **A crawler gives better evidence than "the suite is green".** List every `page.tsx` without a
  `[param]`, sign in as each role, `goto` each page with `networkidle`, and listen for
  `securitypolicyviolation`. Run it once against the old build as a control: 48 hits there vs 0
  here proves the detector works. For the marketing host, add
  `--host-resolver-rules=MAP <host> 127.0.0.1` to Chromium and start the server with
  `MARKETING_HOSTS=<host>`.
- **In this container, Chromium cannot load tawk.to's CDN.** It fails CORS even on a page with no
  CSP. curl through the proxy gets `access-control-allow-origin: *`. Feed those files to the page
  through `ctx.route()` + `execFileSync('curl')`. Playwright's `route.fetch()` skips the proxy and
  aborts.
- **A `NEXT_PUBLIC_*` read through a parameter (`fn(env = process.env)`) is NOT inlined.** The
  browser bundle then reads an empty `process.env`. Check the built chunk for the literal value.
- **The middleware's `Content-Security-Policy` replaces the one from `next.config.js` `headers()`
  on the same response.** It is not appended, so a page carries exactly one enforced policy
  (`headersArray()` length 1).
- **The unit suite's `schema-push-safety` test fails on a deepened shallow clone.** It passes
  after `git fetch --unshallow`.
