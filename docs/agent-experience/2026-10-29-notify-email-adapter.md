## 2026-10-29 — notification router: adapters + a real e-mail channel (#1711)

- **A queue job name nobody registered is silently a black hole.** `notification.email` rows
  had been written since #1710 with no handler; the worker never claims an unregistered name
  and nothing alerts. When you finally register one, rows from the gap wake up — give the
  handler a staleness cut-off (here: older than a day → SKIPPED `stale`).
- **`sendEmail()` reads lane, transport and outbound hold from the CATEGORY, not the `group`
  argument.** A generic category would put every routed mail in one lane. One `notify-<group>`
  category per e-mail group keeps each mail on its group's lane; the outbound-approval unit test
  then forces an explicit `OUTBOUND_CATEGORIES` entry for each, and the exempt list is pinned to
  the account_security group's own categories.
- **Code a spec imports must not reach `enqueue()`'s lazy store import** — the Playwright
  process cannot resolve `@/` inside a dynamic import. Pass `store: prismaQueueStore()` from a
  static import in server modules a spec may load directly.
- **A dead local MariaDB looks like seven failing tests** (`PrismaClientInitializationError`):
  `service mariadb start` after the container idles, before blaming the change.
