# 2026-10-27 — Settings history: one writer, outside the client-reachable module (#1623)

- **`src/lib/settings.ts` is client-reachable** (documentAccess → retention), so a
  writer that emits events (node:crypto, async_hooks, the job queue) cannot live
  there. The writer moved to `src/lib/settingsWrite.ts`; `settings.ts` exports
  `unscopedSettings()` and `noteSettingsWritten()` for it. Add any new server-side
  settings module to `SETTINGS_MODULES` in `scripts/check-settings-accessor.mjs` —
  and note that guard scans **tracked** files only, so `git add` before trusting it.
- **A form that PUTs every field turns "save" into "set everything here".** Once
  history rows exist per change, an unchanged inherited field becomes an org row
  and a history entry on first save. The admin form now diffs against the raw
  values it loaded and sends only what changed.
- **A cold `next dev` compiles `/admin/settings` + its API for >15 s here.** Wait
  for `data-state="ready"` on `settings-form` with a long timeout before asserting.
- Calling `writeSetting()` from a spec logs "Domain event delivery could not be
  queued … Cannot find module '@/lib/prisma'" from the test process (the queue
  store's lazy require); harmless — the event row is written, the spec passes.
- Local `db push` after a rebase may need `--accept-data-loss` (local DB only).
