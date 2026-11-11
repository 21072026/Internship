## 2026-10-29 — notification router: channel adapters (#1711, slice 1)

- **Fetch main right before you build on a "stub" a ticket names.** The router's e-mail
  consumer I had written landed on main from a sibling session (#1719, `emailJob.ts`) while this
  branch was open; the merge showed it as duplicate identifiers in `src/jobs/index.ts` and
  `src/lib/jobs/types.ts`. Take main's files (`git checkout origin/main -- …`) and keep only the
  part nobody else did — here the adapter port, the registry and the ledger module.
- **Code a spec imports must not reach `enqueue()`'s lazy store import** — the Playwright
  process cannot resolve `@/` inside a dynamic import. Pass `store: prismaQueueStore()` from a
  static import in server modules a spec may load directly.
- **A dead local MariaDB looks like seven failing tests** (`PrismaClientInitializationError`):
  `service mariadb start` after the container idles, before blaming the change.
