# Roster feeds: automatic deprovisioning and its safety valves (#1966)

This is the page for a security reviewer. It states, exactly, when a roster feed switches
an account off, when it refuses to, and how it decides to switch one back on. The engine
that imports the file (parsing, the diff, dry runs, resume) is described in
[`roster-feed.md`](roster-feed.md); this page is only about the people the file **no longer
mentions**.

The rules live in one pure, unit-tested module, `src/lib/rosterDeprovisionRule.ts`
(`e2e/roster-deprovision.unit.spec.ts`). The database half is the deprovisioning port in
`src/lib/rosterIngestStore.ts`, and `e2e/roster-deprovisioning.spec.ts` runs the whole path
against MySQL. Where this page and the code disagree, the code is right and this page has a
bug.

## The promise

> When HR removes someone from the feed, their access ends on the next run after the grace
> period, without anyone doing anything.

"Access ends" means all of it, in one step:

- `User.isActive = false`. The next sign-in is refused.
- `User.sessionsValidFrom = now`. Every session token minted before this moment is rejected
  on its next request, so the person's live 12-hour session dies as well.
- Every remembered device ("keep me signed in") is revoked, along with the native app's push
  tokens (`revokeTrustedDevicesForUsers`). Without this the browser would trade its
  remember-me cookie for a fresh session on the next page load. The stamp and the revocation
  always happen together; the e2e suite checks that a remembered browser does **not** sign
  itself back in.
- `User.deactivatedBy = "roster:<feedId>"`, so the system knows a feed made this decision and
  not a person.

A feed **never deletes and never anonymises** anyone. Deactivation is reversible. Erasure
stays a deliberate human action (`/api/admin/users/[id]/erase`).

Deprovisioning is **off by default** (`RosterFeed.deprovision = false`). A feed with it off
still imports and still reports who is absent (`RosterRun.absentKeys`), but switches nobody
off.

## Who a feed covers

A feed covers the **mentees of its own organization**, the same people it creates and
updates. Staff accounts (admins, mentors) are never in its scope. The last-admin guard below
is still built in, so widening the scope later cannot make a feed the way an organization
locks itself out.

## The four safety valves

A bad file looks exactly like "everyone left": a truncated download, a wrong path, an empty
export, a column renamed in the HR system. Every valve below is checked **before the first
write** of the run. When one fires, the run is recorded as `ABORTED_SAFETY` with the reason
in `RosterRun.safetyReason`, an alert is sent, and **nothing** is written: no creates, no
updates, no stamps, no deactivations.

| Valve | Setting (default) | Fires when |
|---|---|---|
| Row floor | `minRowCount` (1) | the file has fewer data rows than the floor. Set it close to the real roster size: a file of 3 rows for a roster of 300 is not a roster. |
| Deactivation ceiling | `maxDeactivatePercent` (10) | the people the feed is offboarding exceed this share of the organization's active people the feed covers. |
| Grace period | `deprovisionGraceDays` (1) | does not abort. It holds each person back: see below. |
| Protected accounts | always on | the last active admin of the organization, and any account with an SSO exemption (the break-glass account, #1950), are never deactivated. Each refusal is written to the run log and to the activity log (`roster.deprovision_refused`). |

### The ceiling counts everyone on the way out

The ceiling is measured against **everyone the feed is offboarding**: people absent for the
first time tonight, people still inside their grace period, and people due tonight. It does
not count only the people due tonight. A broken file is therefore stopped on the night it
arrives, not one grace period later when the harm would be done.

With the default of 10%, an organization with 20 mentees can lose 2 in one go. A third
leaver on the same night aborts the run and alerts. Raise the setting for a small
organization or a known mass leaving, or approve the run (below).

### The grace period

A person is deactivated only on a **successful run at least `deprovisionGraceDays` UTC
calendar days after the run that first found them absent**.

- The first successful run that does not mention a person stamps `User.rosterAbsentSince`,
  and does nothing else.
- A later run on the same UTC day changes nothing: two runs in one night are not two nights.
- A run on a later day, past the grace period, deactivates the person.
- If the person **reappears** in any run, the stamp is cleared. A later absence starts the
  count again from zero.

An **unchanged file** keeps the grace period counting. HR exporting the same file two
nights running is the normal case. The file is not re-imported (its hash matches the last
successful run), but the deprovisioning rules are applied to it again.

### A run the feed cannot trust deprovisions nobody

If any row of the file could not be read (an `ERROR` row, for example an invalid e-mail
address), the run is `FAILED` and the deprovisioning step does not run at all. An unreadable
row is a person who looks absent.

## Reactivation

A person who comes back into the feed is reactivated **only if a feed switched them off**
(`deactivatedBy = "roster:<feedId>"`). Reactivation sets `isActive = true` and clears
`deactivatedBy` and `rosterAbsentSince`.

The feed never undoes a person's decision. An admin deactivating an account through the user
editor records the admin's own id in `deactivatedBy`. Accounts deactivated before this
column existed have `deactivatedBy = null`, which also counts as a person's decision. A file
can never switch either kind back on.

When an admin re-activates an account by hand, `deactivatedBy` and `rosterAbsentSince` are
cleared. If the feed still does not mention that person, they will be stamped again on the
next run and deactivated again after the grace period, because the feed is the record the
tenant asked it to be. To keep such a person, add them to the export or switch
deprovisioning off.

## Approving a stopped run

An admin can **approve** a run the ceiling stopped. The engine accepts `approved: true`
(the console button is #1967). Approval lifts **the ceiling only**. The row floor, the grace
period and both protected-account refusals still apply.

## Alerts

Two outcomes always send mail, category `ops-alert`, which is essential and never held for
approval:

- any run a safety valve stopped;
- any run that deactivated at least one account.

The mail goes to the operator (`ALERT_EMAIL_TO`) and to the organization's
`supportEmail`. It names the feed and gives counts, never people: the support address may be
a shared inbox. The names are in the run log (`RosterRowResult`: one row per person
deactivated, reactivated or refused, with a negative row number because there is no file
row for a person the file did not contain). A dry run never alerts and never writes.

## Audit trail

| Where | What |
|---|---|
| `RosterRun` | status (`ABORTED_SAFETY` included), `safetyReason`, `deactivatedCount`, `reactivatedCount`, `absentKeys` |
| `RosterRowResult` | `DEACTIVATE` / `REACTIVATE` / refused (`SKIP`) rows per person, kept 90 days |
| `ActivityLog` | `roster.deprovisioned` (warning, with the count), `roster.deprovision_refused` |
| `User` | `deactivatedBy`, `rosterAbsentSince`, `sessionsValidFrom` |
