# 2026-10-29 — Generated Google Meet rooms (#2009)

- **A later success erases an earlier failure note.** `pushMeeting()` cleared
  `GoogleCalendarConnection.lastError` on every successful mirror. A Meet generation failure
  noted in the same request was therefore wiped a moment later, and the e2e saw `""`. Notes now
  carry a prefix (`MEET_NOTE_PREFIX`), and the mirror only clears errors without it. Before you
  rely on an error column, check who else writes `null` into it.
- **A container restart stops MariaDB and leaves the dev server cold.** Run
  `service mariadb start` first. The first test of every run then hits Next's on-demand compile
  (`signInAndSettle`'s 20 s `waitForURL`, or a 15 s card wait). `--repeat-each=2 --timeout=180000`
  gives you a warm second iteration in the same run, which is the honest functional result.
  Report both iterations.
- `gh` against GraphQL is blocked here (403). Use `gh api repos/...` (REST), or the GitHub MCP
  tools, for issue and PR reads.
- An `enum` gaining a value (`ConferencingPolicy.GENERATE_PROVIDER`) passes `check:schema-push`;
  it is additive for `db push`.
