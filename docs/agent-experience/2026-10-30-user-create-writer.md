# 2026-10-30 — One writer for User rows (`createUser`) + `user.created`

- **Ghost events in transactions have three cures, pick by shape.** A post-commit
  note (`stageTransaction`) suits a writer called from many transactions; an
  owned-tx-only emit suits one that sometimes runs on a caller's tx;
  `emitInTransaction(tx, …)` (DomainEvent row + `event.deliver` jobs written by
  `tx`) is the simplest when the producer already holds `tx`. `prismaQueueStore(db)`
  now takes the client for exactly this.
- **`Prisma.SelectSubset<T, Prisma.UserCreateArgs>`** keeps each call site's
  `select` return type when wrapping `user.create`; add the ids the event needs
  to `select` only when the caller passed one.
- **Bracket-matching codemods break on apostrophes in comments** (`don't`).
  Strip comments before matching, or edit those sites by hand.
- **GitHub issue creation via MCP intermittently returned 500** (twice in a row,
  also with `parent_issue_number`); PR creation kept working.
