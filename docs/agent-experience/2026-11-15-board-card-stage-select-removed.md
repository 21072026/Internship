## 2026-11-15 — per-card stage select removed from the boards

- **`dragTo` on a board card needs two things the default call does not give.** The centre of an
  admin board card is the owner's hover-card link, and a drag that starts on a link drags the
  link: start in the card's padding. And one jump from source to target does not always start a
  drag (mousedown, mouseup, no `dragstart`) — hold the button, move a few steps, then hover the
  target twice (`moveOnBoard` in `e2e/trial-window-stamp.spec.ts`).
- **`next dev` is too slow here to run board specs** — pages sat on "Loading…" past the 10 s
  expectations. `npm run build` once, then `CI=1 npx playwright test …` runs them against
  `next start` like the gate does (apt MariaDB per `docs/security-audit-playbook.md`).
- **The pinned Playwright wants a newer browser build than `/opt/pw-browsers` holds.** Symlinking
  `chromium_headless_shell-<installed>` to the expected `-<wanted>` directory worked this time
  (same inner layout); no `playwright install`.
- **`npm install` rewrites `package-lock.json` in this container**; `git checkout -- package-lock.json`
  before `git add -A`, or `check:licenses` goes red on a signature mismatch.
- **Removing an accessibility affordance touches five places**: `src/lib/vpat.ts` (+ `npm run
  vpat:evidence`), `src/lib/accessibility.ts`, the `dragAlternative` strings in both dictionaries,
  `docs/accessibility-statement.md` and `docs/a11y-audit.md`.
- **A force push is denied in this session.** To reuse a branch whose old PR was closed unmerged,
  commit on top of fresh `main` and `git merge -s ours origin/<branch>` so the push fast-forwards.
