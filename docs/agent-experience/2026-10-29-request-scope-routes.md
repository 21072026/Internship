# 2026-10-29 — request scope on the remaining logging routes (#1601)

- Only **8** route files imported `logger` without `withRequestScope` once #1601 and its
  follow-ups had landed: `comm -23 <(grep -rl logger …) <(grep -rl withRequestScope …)` finds
  them in a second. The cheapest uniform wrap is a rename: `export async function GET(...)` →
  `async function handleGET(...)` plus a thin exported `GET` that calls it inside
  `withRequestScope(request, …)` — no re-indentation of a 200-line body.
- `check:route-auth` follows calls into same-file functions, so moving `getServerSession` one
  level down into `handleX` keeps it green; the anonymous-route baseline is unaffected.
- A first `next dev` compile of several heavy routes outlasts a 10-minute foreground Bash call;
  run multi-spec e2e batches in the background from the start.
- **Correction:** the rename-and-wrap shape (`handleGET` + a thin exported `GET`) breaks two
  static guards — `check:capability-writers` wants every gated write *inside* an exported
  handler, and `signup-org`'s source tests read the exported handler's own body. Wrap
  **inline** instead: `export async function GET(request, …) { return withRequestScope(request,
  async () => { …body… }); }`. Rename a `_request` parameter to `request` and its uses.
- A dev server you start yourself is reused by Playwright **without** the webServer `env:` block
  (`SELF_SERVE_SIGNUP`, mock ports, `TRUSTED_PROXY_COUNT`…), so many specs fail for the wrong
  reason. For a real run: `npm run build`, then `CI=1 npx playwright test …` and let it start
  `npm run start` itself.
