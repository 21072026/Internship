# 2026-10-29 — terminology in mail, per programme (#1631)

- **Writing `''` to a settings layer is not "reset"**: `pickSetting()` returns the first row
  it finds at the most specific layer, so an empty programme row masks its org. Resetting a
  layer means deleting its row — `revertSetting()` in `src/lib/settingsWrite.ts` (#1623). I
  first wrote my own `clearSetting()`; a parallel PR had landed the real one overnight. Rebase
  before adding a writer to a shared module.
- `check:settings-accessor` flags any `prisma.setting` read outside the settings modules —
  ask "does this programme have its own row?" through `resolveSettings(scope).sources[key]`.
- **Mail copy that bypasses `emailDictionary()` was invisible**: ~30 bare `getDictionary()`
  calls sat in mailing files although CLAUDE.md forbids it. A ratchet
  (`check:mail-dictionary`) made the count a number that can only go down.
- `Notification` has no `orgId`; scope cleanup in a spec through `user: { email: { in } }`.
