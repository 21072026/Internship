## 2026-10-06 — Playwright smoke gate split into parallel shards (#2811)

- **Measure CI step-by-step before cutting tests.** `gh run view <id> --json jobs --jq '.jobs[].steps[]'`
  gives per-step start/end; the list reporter's `(12.3s)` suffixes give per-spec cost. The 19-min
  smoke job was 4 min of apt font downloads, not just "too many tests".
- **`playwright install --with-deps chromium` on ubuntu-latest only installs fonts.** The runner
  image already has every Chromium library; the step logs `9 newly installed` — all `fonts-*` /
  `xfonts-*`, ~4 min from the Azure mirror. Drop `--with-deps` where no spec compares screenshots.
- **A matrix job can never carry a required check's exact name.** Matrix jobs are named
  `Name (…)`; keep the required name on a small aggregator job that `needs:` the matrix and treats
  `skipped` as green only when the skip was the intended one (docs-only PR).
- **A serial spec with an aggregating last test (a11y-scan) cannot be sharded** — give it its own
  matrix row; it then sets the wall-clock floor (~3 min).
