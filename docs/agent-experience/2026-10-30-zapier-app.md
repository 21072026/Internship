# 2026-10-30 — The Zapier app (#2004)

- **The CLI's bin is `zapier-platform`, not `zapier`** (zapier-platform-cli 19).
  `zapier-platform validate --without-style` needs no login and catches schema
  mistakes; style checks need an account.
- **`node --test test/` does not pick up a directory on Node 22.** Pass the glob
  (`node --test test/*.test.js`).
- **nock hands request headers over as arrays.** Take `[].concat(h)[0]` before
  you compare one.
- **Testing a connector without touching preview:** `createAppTester` + nock
  offline. For a live check, run `npm run smoke` against a PR environment or a
  local `next dev` with a seeded key; the shared preview DB is off limits.
- **Checking a story is not the same as coding it.** #1987 had every sub-task
  closed and every acceptance item already on main, so verify with evidence and
  close it rather than invent work.
