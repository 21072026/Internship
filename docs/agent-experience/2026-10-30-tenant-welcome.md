# 2026-10-30 — Tenant welcome page (#1664)

- Two host→org resolvers exist and mean different things:
  - `resolveOrgFromHost()` (`src/lib/hostOrg.ts`) accepts only a DNS-verified `publicHost` or a
    `<slug>.<APP_ROOT_DOMAIN>` host. Use it for anything that speaks *as* the tenant: SSO
    discovery, the welcome page.
  - `hostBrandFor()` / `resolvePublicInquiryTarget()` follow the operator's mapping, verified or
    not. Those are for cosmetics and the demo form.
- To keep the most-hit page free of new queries, gate on `isServedHost()` before any lookup: our
  own hosts are never a tenant's.
- A new Organization text column fails `check:text-limits` until it has a TEXT_LIMITS key and a
  row in `src/lib/textLimitsRegistry.ts`. List the editor page in its `files` so its `maxLength`
  is pinned too.
- `Textarea` (`src/components/ui/Textarea.tsx`) has no `label` prop, unlike `Input`. Render a
  `<label htmlFor>` yourself.
