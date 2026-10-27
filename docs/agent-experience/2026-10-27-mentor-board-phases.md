# 2026-10-27 — Mentor board phases + shared board pieces (#2076)

- **Read the issue against `main`, not its line numbers.** #2076 was written before #1366
  (empty-stage strips), #1367 (mentor search) and #1439 (configurable WIP limit) landed; the
  mentor board had also moved to `src/components/board/MentorBoard.tsx` (#2580, shared with
  `/sales/board`). Half the "what to build" was already done — the remaining work was the
  extraction and the grouping.
- **A board that a mentor sees cannot read `/api/admin/*`.** The WIP limits lived only on
  `GET /api/admin/stage-sla` (ADMIN). The fix is a read-only `GET /api/board/wip-limits` over the
  *same* resolvers (no second limit source), and `useBoardWipLimits()` so both boards fetch it
  the same way. A new route must pass `check:route-auth` and `check:openapi` — both did with a
  plain `getServerSession` + role check.
- **Stacked phases break the #1366 promise.** The admin board stacks phases vertically; doing
  that on the mentor board pushes the outcome phase below the fold at 1280×900 and
  `board-empty-stages.spec.ts` (all mentees `toBeInViewport`) would fail. `BoardPhaseGroups`
  therefore has a `row` layout: phases side by side in one scroller that keeps the
  `board-columns` testid. Same toggle, same collapse state, different arrangement.
- **Playwright 1.64 wants `chromium_headless_shell-1248`; the container has `-1243`.** A
  directory symlink (`ln -sfn …-1243 …-1248`) is enough — no `playwright install`.
