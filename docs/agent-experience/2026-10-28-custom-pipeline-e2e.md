# 2026-10-28 — Custom pipeline end-to-end smoke (story #1632)

- **A story whose sub-tasks are all closed can still be missing one acceptance line.** #1632's
  three tasks (#1634, #1635, #1637) each shipped their own spec, but the story asked for ONE
  `@smoke` spec driving a fully custom set end to end. Check the story body, not only
  `sub_issues_summary`.
- **A stage saved without `phase` lands in the board's trailing `custom` group by design**
  (`groupResolvedStages`). An end-to-end assertion like "no custom group at all" is wrong as
  soon as the set holds an off-path stage with no phase — assert where the phased stages are.
- **The local MariaDB does not survive a container restart** (`service mariadb start` again),
  and after `main` moves the local schema needs `prisma db push --accept-data-loss` — fine on
  the throwaway local DB, never on a shared one.
