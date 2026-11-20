## 2026-11-20 — affiliate price list, two commission bases, invoice CSV (#3842: #3843–#3847; #3853; #3852)

- **A red `audit` check may be an advisory that is about to be withdrawn. Check that before
  touching the gate.** GHSA-fc5q-39xc-vjpf (picomatch) turned `audit` red on every PR, and an
  exception plus a gate change were drafted for #3852. The advisory was withdrawn a day later,
  and a plain re-run went green. Read `gh api /advisories/<GHSA-id>` (`withdrawn_at`,
  `updated_at`) and compare with a PR opened after yours. Gate and dependency changes for
  `audit` are the maintainer's call. Do not merge while `audit` is red without asking, even
  though it is not a required check.
- **When `set_auto_merge` answers "Pull request is in clean status", CI has already passed.**
  GitHub does not enable auto-merge on a PR that can be merged now. Check `gh pr checks <n>`
  and merge it directly (`gh pr merge <n> --squash`).
- **Closing the last task does not close its Story.** #3347 kept all three tasks closed for
  days while staying open. After a task's PR merges, read
  `gh api repos/<o>/<r>/issues/<story>/sub_issues`. When nothing is open, write a closing
  summary that lists each task and the PR that closed it
  (`gh issue view <n> --json closedByPullRequestsReferences`), close the story and move it to
  Done.
- **The affiliate e2e on the marketing host needs the host header on the page too.** Use
  `page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST))` before
  `signInAndSettle(page, email, pw, '/admin')`. The 4th argument is the landing path, not the
  host. The API context needs the same host (`signInViaApi(api, …, { host: MARKETING_HOST })`):
  a session belongs to the world of the host it was signed in on.
- **Use `BigInt(0)`, not `0n`, in `src/`.** `tsc` rejected the BigInt literals. The
  price list (`affiliatePriceListRule.ts`) computes in milli-minor units with BigInt and
  rounds the month's total to the cent once, never per step.
- **In a serial spec, put new tests at the end of the file.** Later tests there count rows
  that earlier tests wrote (payments, commissions). A test inserted in the middle shifted
  every count after it.
- **Assert on the newest line, not a row count, for a card that shows a few rows and then
  "show more".** The payment history card shows `FIRST_ROWS = 3`, so a count-based assertion
  failed once the test had written more payments than that.
- **A client dialog used on a server-rendered page must refresh the page itself.** The
  planned meeting from `/sales/leads/[id]` (#3853) appeared only one save late, because the
  dialog called `onCreated` and the page passed none. `PlanMeetingDialog` now calls
  `router.refresh()` when no `onCreated` is given. Check other create dialogs the same way.
- **The first look at a file with no saved column choice is not an error.** The invoice
  import asks the server with no columns to learn the header. A `400 { code: 'columns' }` on
  that first call only fills the selects. Show the error toast only after the admin has
  picked columns. Otherwise every first upload greets the user with a red toast.
- **A new importer is a `runImport` consumer, never its own preview branch.** The invoice CSV
  (`src/lib/affiliateInvoiceImport.ts`) is pure rule + store. The dry run passes the same
  plan through an `apply` that does not write, and every payment goes through the one writer
  (`recordAffiliatePayment`). That is why the preview could not drift from the import.
