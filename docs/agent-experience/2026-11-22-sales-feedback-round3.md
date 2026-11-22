## 2026-11-22 — sales team feedback, round 3 (#3865: #3870–#3876, #3879; #3869: #3877, #3878)

- **A red `Build image / Build topic-pr<N>` right after an auto-merge is usually a cancellation,
  not a broken build.** `topic-preview.yml` cancels the PR's run when the PR closes. When CI
  finishes before the image build, auto-merge closes the PR mid-build, and `gh pr checks` shows
  `fail` for the build and the manifest jobs. Run
  `gh run view <run> --json jobs -q '.jobs[]|"\(.name) \(.conclusion)"'`: you should see
  `cancelled` with a completion time at the merge minute. Then check the deploy runs of the merge
  commit (`gh run list --commit <sha>`). Those are the ones that matter, above all for a schema change.
- **A component mounted once in `Providers` keeps its React state across sessions.**
  `ImpersonationBanner` never reset `busy` after a successful "return to your account", so a
  second impersonation in the same tab found the button disabled (#3876). Reset that kind of state
  on the session identity, for example a `useEffect` keyed on `${user.id}|${impersonatorId}`.
  In e2e, reproduce it without `page.goto` between rounds, because a reload hides the bug.
- **A session cap that rewrites the JWT silently looks like "the banner vanished".** The 30-minute
  impersonation cap reverted the token in the `jwt` callback with nothing on screen. The fix
  exposes the deadline and the revert moment on the session (`impersonationExpiresAt` /
  `impersonationEndedAt`), calls `update()` at the deadline and shows a notice. To test it in e2e,
  age the real token: `decode` → set the deadline in the past → `encode` with `next-auth/jwt` and
  `NEXTAUTH_SECRET`, then `context.addCookies`.
- **A filter remembered in `localStorage` must not apply where its control is not rendered.**
  The lead page's "All / Interactions / System" choice hid every interaction on a lead with no
  system line, because there the control was hidden (#3879). It surfaced under impersonation,
  since the admin's browser had the choice stored. Derive the effective value
  (`systemEvents.length > 0 ? remembered : 'all'`) and keep the stored choice.
- **In a transfer that creates a new record, read "the state before" from the OLD record.**
  `handOffLead()` read the previous follow-up from the record the recipient now owns. In
  `transferred` mode that record carries no follow-up (`CARRIED_OVER_FIELDS`), so the history line
  always showed none (#3870). The same trap applies to any field outside `CARRIED_OVER_FIELDS`.
- **Make a router mail without changing a bell's exact link by sending only the mail through
  `notifyEvent`.** The hand-off bell keeps its `notify(…, '/sales/leads/<id>')`, and the mail is
  `notifyEvent(key, …, { channels: ['email'], email: { … } })` with a dedupe key from the record's
  pre-write `updatedAt` (#3871). A catalogue `link` kind cannot produce `/sales/leads/<id>` for an
  ADMIN recipient: `salesRecordLink` answers for MENTOR only.
- **A new notification link kind touches four places.** `LinkKind`, `LinkIds` and
  `notificationLink()` in `src/lib/notificationLink.ts`; `LINK_ID_KEYS` and `NotificationLinkIds`
  in `catalog.ts`; `LINK_KINDS` in `scripts/test/notification-catalog.test.mjs`; and the
  `kinds` × roles table in `e2e/notification-link.unit.spec.ts` (#3878). A notification param is
  stored raw and is not translated per reader, so a translated status label cannot be a param.
  Word the bell generically and let the linked page show the status.
- **Make an "assigned to you" / "seen" signal three nullable columns, not a log.** For #3874 the
  columns are `assignedAt`, `assignedById` (a plain id, no FK) and `assignmentSeenAt`. They are
  written by the only two paths that put a record on someone else's book (`transferMentorship`,
  admin `POST /api/mentorship`) and cleared by the owner opening the page, not under
  impersonation. Rows from before the columns read as seen, so the rollout floods no one.
  `db push` applied it on prod and preview without an expand step.
- **A git worktree for a second fix needs two local steps before `tsc` passes.** Symlink
  `node_modules` from the main checkout, and run `node scripts/i18n-scopes.mjs`: the gitignored
  `src/i18n/scopes.generated.ts` is not in a fresh worktree. Remove the symlink before
  `git worktree remove`.
- **Don't run `prettier --write` on an existing component.** The repo does not format with it, and
  one run rewrote all of `LeadHandoff.tsx` (+272/−87). Re-apply the edit by script and indent by
  hand.
- **`scripts/test/gitignore-exports.test.mjs` failed locally on macOS on a branch that never
  touched `.gitignore`.** Its failing case is the letter case of spreadsheet exports, and the
  macOS default filesystem is case-insensitive, which is the likely cause (not verified further).
  CI on Linux passed it; don't let it block a PR that does not touch ignore rules.
- **`git pull --ff-only` after a merge sometimes fails with `cannot lock ref
  'refs/remotes/origin/main'`.** A second run succeeds. Chain it as `(git pull -q --ff-only ||
  git pull -q --ff-only) && git switch -c …`, so a single failure doesn't leave you branching
  from a stale `main`.
