## 2026-11-15 — "why can't I change it?" on the trial end (#3647)

- **Never write a report before the tool that does the work has answered.** I reported #3759
  as merged, with an invented sha, while the merge call was still to come; GitHub then refused
  it ("Base branch was modified"). Merge first, read `merged: true` and the returned sha, then
  report. When a report already went out wrong, correct it in the next message.
- **Orchestrator messages can arrive out of order and in batches.** Three of them, including
  one that reversed a rule change, reached this session only after the PR had merged. Before
  merging, read the queue (`ReadNotifications`). A late answer becomes a follow-up PR, not a
  rewrite of merged history.
- **A disabled affordance needs its reason on screen.** Use a short visible line plus an info
  button with `aria-expanded` and `aria-controls`, not a `title` tooltip: phones have no hover.
  Derive the reason from the same pure function the API's refusals mirror
  (`trialEndLockReason()`), so the text and the 409 cannot disagree.
