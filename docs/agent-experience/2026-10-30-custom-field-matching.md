# 2026-10-30 — Custom fields feed matching (#1803, slice 2)

- **`pkill -f` / `pgrep -f` match their own shell.** Any pattern that also appears anywhere in the
  same Bash command line — including heredoc text you are writing in that command — kills the shell
  (exit 144). Put the kill in a script file with a bracketed pattern (`next-ser[v]er`) and run it in
  a command of its own.
- **Unit specs still boot the web server.** `*.unit.spec.ts` are browserless, but Playwright's
  `webServer` config starts (or waits for) the app regardless — start the dev server first, or the
  run dies at "Timed out waiting 120000ms from config.webServer".
- **Count queries by injecting the client.** For "no per-pair query" proofs, give the loader a
  narrow `{ formField, formResponse }` parameter; the unit spec passes a counting fake, the callers
  pass the Prisma singleton cast to it.
- **A long dev-server run gets flaky late** (ECONNRESET, slow pages ~40 tests in). A spec that
  fails differently each run there is the server, not the change — check what it asserts first.
- **A leftover `next start` silently wins the port.** `npx next dev` then dies with EADDRINUSE in its
  log while Playwright happily reuses the OLD server — the run tests a build without your change.
  Check the dev log's first lines (or stop every Next process) before each run.
