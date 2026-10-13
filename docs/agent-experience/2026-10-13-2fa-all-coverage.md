## 2026-10-13 — require2fa 'all' and the enrolment coverage report (#1644)

- **A gate that runs after a redirect protects nothing on the other side of it.** The portal and
  mentor layouts checked 2FA at the very end, after a vertical redirect that sends a MARKETING
  MENTEE to `/account` — a page that is deliberately outside the gate. Under `all`, a MARKETING
  lead was never held. Put the gate right after the session check, before any redirect, in every
  shell. An adversarial review workflow found this; the single-reviewer pass had not.
- **Don't widen the gate to `/account` to close a hole like that.** `/account` holds account
  self-service, including deleting the account; gating it would put the right to erasure behind
  2FA enrolment in every mode. Move the check earlier on the path instead, and document which
  pages are intentionally ungated.
- **Paginate a list of people with a total order.** `orderBy: [role, fullName]` plus
  `skip/take` can show one person twice and another never when names repeat. Add `id` last —
  `src/app/api/mentors/route.ts` already did this for the same reason.
- **Read the flash text from the dictionary block the page uses.** `grep "saved: '"` hits a dozen
  blocks; the settings page renders `t.settings.saved` = "Settings saved", not "Changes saved".
  Anchor the grep on the block (`awk 'NR>=<settings: line>'`) before writing the assertion.
- **`releases/unreleased/` can vanish after a compaction merge.** An empty directory is not in
  git, so after `release-compact.yml` folded every fragment the folder was gone and a heredoc into
  it failed with "No such file or directory". `mkdir -p releases/unreleased` first.
- **A shared helper's weakness is a follow-up, not this PR's scope.** `toCsv` does not
  neutralise formula-leading cells; every export has the same exposure. Filed as a separate task
  instead of silently changing every export's output from inside a 2FA PR.
