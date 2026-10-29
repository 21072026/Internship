# 2026-10-28 — closing out stories whose tasks are all done (#1972, #1974)

- **A story with 100 % closed sub-issues can still be open for one acceptance line.** #1972's
  tasks had all shipped, but its own criteria asked for the move → cancel spec to be `@smoke`,
  and no task carried that line. Read the story's acceptance list against the tree before
  starting new work on it; the remaining gap may be a one-line tag rather than a feature.
- **`get_sub_issues` output is large** (≈55 KB per story with full bodies). Parse it to
  `number state title` with a short script instead of reading it raw.
