## 2026-11-13 — postal-campaigns.md retention line after MKT-3 (#3676)

- **When an orchestrator sequences a docs edit behind another worker's PR, branch the edit
  fresh from `origin/main` after that PR lands.** Do not carry it on the feature branch. The
  feature can merge early, and the docs edit then neither conflicts with nor reverts the other
  worker's lines.
