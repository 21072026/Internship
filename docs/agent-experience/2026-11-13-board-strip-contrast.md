## 2026-11-13 — collapsed board strip contrast (#3675, after #3692)

- **Retinting a surface re-asks every text colour on it.** #3692 moved the collapsed strip from
  `bg-gray-50` to the stage tint (`-100`). 10px `text-gray-500` passes at about 4.6:1 on
  gray-50 and fails on sky-100. The a11y baseline caught it, but only after merge. When a
  background changes, check the text sitting on it (`gray-700` holds on every `-100` tint).
- **To pin down the source, revert the suspect commit with `git revert --no-commit` and
  re-run the scan on a prod build.** Then `git revert --abort`. It costs one build and is
  conclusive.
- **The local a11y scan can surface data-dependent violations that CI's fresh DB never
  renders.** Example: the overdue badge (`text-red-600` on `bg-red-50`, 4.4:1 at 10px) only
  appears when a card is overdue. When the local scan shows something CI doesn't, it is
  usually real, just unrendered in CI. Fix it rather than dismiss it.
- **axe skips text it cannot measure.** A `0` count with `opacity-60` was about 2:1 and was
  never reported. Opacity on small text hides the problem from the scan.
