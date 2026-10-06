## 2026-10-06 — product tour captures per language (#2808)

- **A capture script that clicks by visible label breaks in every other language.** Select a stage
  by its key (`selectOption({ value: 'LEAD_CONTACTED' })`) and find screens by testid
  (`funnel-kpi-card`). Keep any text the clip has to type or click in a small per-locale table.
- **Viewing prod in the sandbox browser:** Chromium does not trust the agent proxy's CA, and you
  must not switch verification off. Route the page through Node instead:
  `ctx.route('**/*', …)`, then `fetch()` with `NODE_USE_ENV_PROXY=1`. Node reads
  `NODE_EXTRA_CA_CERTS`, so verification stays on. Drop `content-encoding` / `content-length`
  from the fulfilled headers.
