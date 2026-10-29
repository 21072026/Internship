# 2026-10-29 — business-day stage SLAs (#1638)

- **One pure rule shared by TS and the deploy's plain Node: write it once as `.mjs`.**
  `prisma/business-days.mjs` (JSDoc types) is imported by the app through a tiny
  typed wrapper (`src/lib/businessDays.ts`, allowJs) and by `stage-sla-rule.mjs`
  directly — no TS/ESM twin, no mirror test to keep in step.
- **Next.js route files may export only handlers** (`GET`, `POST`, …, `dynamic`,
  …). Shared zod schemas and limits between `route.ts` and `[id]/route.ts` go into
  `src/lib/…`; exporting them from the route fails the build, not `tsc`.
- **`Intl.DateTimeFormat` throws when `dateStyle`/`timeStyle` meet `weekday`/`month`**,
  and `formatInTimeZone()` sets the styles by default — pass `dateStyle: 'full'`
  instead of component options.
- **`fillTemplate()` returns React nodes**, not a string; a `useState<string>` error
  message wants `.replace('{x}', …)`.
- **Local DB e2e on `next dev` times out where CI does not**: a cold route compile
  costs 6–13 s, so a spec's first `signInAndSettle` or a 15 s `request` timeout fails
  on the run that compiles it and passes on the next. Re-run before suspecting the
  change; `/api/cron` (every cron job over the accumulated local DB) never fits 15 s.
  The `admin@example.com` specs need `npx prisma db seed` first.
- `pkill -f "next dev"` inside a `&&` chain kills the chain itself (exit 144) — run it
  as its own command.
