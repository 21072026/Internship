## 2026-10-14 — cutting hosted minutes: arm64-only image, no CI re-run on push to main (#2916)

- **Before removing a workflow trigger, grep the workflow for `github.event_name`.** In
  `e2e.yml`, `push: main` looked like it only re-tested the merged commit. It was also the only
  run that *saved* the Next.js build cache (`if: github.event_name == 'push'`), and every PR
  run restores that cache. Dropping the trigger alone would have left every PR build on an
  ever-older cache: slower builds, and fewer minutes saved. The save moved to the scheduled
  `e2e-full.yml` run on main (shard 1). A cache saved on `main` is readable from every PR
  branch, but a cache saved on a PR ref is not readable from other PRs, so the save has to
  happen on main.
- **When a build matrix might grow back, make the count it checks a list, not a number.**
  `build-image.yml`'s merge job hard-coded "2 digests" and `for want in amd64 arm64`. Both now
  read `EXPECTED_ARCHES`, so bringing amd64 back is one matrix entry plus one word.
- **Neither Python's `yaml` nor the `yaml` npm package is installed here; `js-yaml` is (via
  node_modules).** `node -e "require('js-yaml').load(…)"` is the quick parse check for a
  workflow edit when `actionlint` is missing.
