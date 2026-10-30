# 2026-10-30 — Adding a locale without adding one (#2082 slice 2)

- To measure what a new language would break, generate it into a scratch copy
  (`i18n:export --locale fr` → fill targets → `i18n:import --create --dict
  <tmp> --config <tmp>`), copy both files over the real ones, run
  `npx tsc --noEmit` and `git checkout` them back. It took about 3 minutes and
  gave the exact list (755 errors / 34 files, 636 in `releaseNotes.ts`). Run `prisma generate` first: a stale client added ~20 unrelated errors to my first count.
- `tsc` can't see a hand-written `['en', 'tr', 'de']` or `z.enum([...])`.
  Those need a grep ratchet (`check:locale-list`); its comment stripper has to
  leave `https://` URLs alone, which `(^|[^:'"\`])//` does.
- When an orchestrator message asks for a product decision, keep building what
  doesn't depend on it.
