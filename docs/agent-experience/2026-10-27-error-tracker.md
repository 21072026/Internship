# 2026-10-27 — error tracker without an SDK (#1600)

- **`src/instrumentation.ts` can import a module as long as that module is edge-safe**
  (`fetch` + the dependency-free seams `requestId.ts` / `tenantAmbient.ts`). Next 15's
  `onRequestError` export lives there and gets the route *template* in `context.routePath`
  — use that as the route tag, it carries no ids.
- **Sentry's envelope protocol is three NDJSON lines over one POST**; implementing it directly
  (~200 lines) avoided a vendor SDK, its edge-compile trouble and its auto-collected request
  bodies, and keeps GlitchTip/Bugsink as drop-in receivers.
- **An ORM error's message is multi-line, and line two onward is the argument dump** (Prisma
  prints the `data:` object with the e-mail in it). Keep the first line only; `maskText` alone
  removes the address but not the name.
- The tag value alphabet rejects `*`, `?`, `&` — so `maskUrl()` output with a query is not a
  valid tag; strip the query for route tags.
- `*.unit.spec.ts` that touch `globalThis.fetch` / `console.warn` must restore both in `finally`.
