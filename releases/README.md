# Release fragments (#1275, per-change versions #1457)

**PRs no longer edit `package.json`'s version, `CHANGELOG.md`, or
`src/lib/releaseNotes.ts`.** Those three files changed on the same lines in
every PR, so any two open PRs conflicted textually *and* raced for the same
version number — every parallel PR needed a manual rebase + renumber.

Instead, a PR **adds one new file** under `releases/unreleased/` (new files
never conflict):

```json
{
  "bump": "minor",
  "changelog": "- **Mentees can own projects** (#1222). ProjectOwnerType gains MENTEE; resolveOwner verifies the role.",
  "notes": {
    "en": ["Projects can now be owned by a mentee."],
    "tr": ["Projelerin sahibi artık bir mentee olabilir."],
    "de": ["Projekte können jetzt einem Mentee gehören."]
  }
}
```

- **Filename**: short kebab-case slug, e.g. `mentee-project-owner.json`.
- **`bump`**: `minor` for features, `patch` for fixes/tweaks (semver, as before).
  Pick what describes the change; do not use `patch` to keep the minor counter
  down.
- **`changelog`**: developer-facing Keep-a-Changelog bullet(s), markdown.
- **`notes`**: user-facing highlights for `/release-notes` — all three of
  EN/TR/DE or none. Omit the field for changes users don't see.
- Trivial non-user-facing changes (pure docs, CI config) still need **no**
  fragment at all, same as before.

## One fragment = one release (#1457)

Every fragment gets **its own version number, its own date and time, and the
commit that brought it in**. In this repo a merge *is* a release — prod and
preview both follow `main` — so the unit of versioning is the merged change,
not "whatever the compaction cron happened to sweep up".

```
0.114.0-beta   2026-08-24 23:48 UTC   29e072a   growth-analytics.json
0.114.1-beta   2026-08-25 01:36 UTC   d1133e4   a11y-gate-actually-gates.json
0.115.0-beta   2026-08-25 09:25 UTC   b174c20   availability-timezone-overlap.json
```

`npm run check:release-fragments` prints exactly that table for the pending
set, so a PR can see which version it will ship as.

**Order is merge order, read from git** — the commit that *added* the fragment
file (`--diff-filter=A`, walked in `--topo-order`), not the filename order.
That is what makes the number the app displayed when a change went live equal
the number the changelog later records for it: a fragment's version depends
only on the fragments that shipped *before* it, so a later merge can never
renumber an earlier one.

Filename order used to be the rule, and it was wrong in a way nobody saw for
two months: a `patch` fragment whose filename sorted *before* the last `minor`
fragment's was erased by that minor's `patch = 0` reset. Three consecutive
merges in 2026-08 all shipped as `0.114.0-beta`, and the compaction then folded
45 changes into a single `## [0.110.1-beta]` section while the 25 versions the
app had actually served vanished. `scripts/test/release-derive.test.mjs`
asserts both properties (`npm run test:release`).

## How the version stays correct

- `next.config.js` reads the fragments at **build time** and derives the real
  version (base from `package.json`, one bump per fragment in merge order) plus
  one release-notes entry **per pending change**. The sidebar footer,
  `/api/health` and `/release-notes` are all correct immediately after a merge
  deploys.
- Dates and commits come from git — except inside the Docker build, where
  `.dockerignore` excludes `.git`. `build-image.yml` therefore resolves them on
  the runner (`node scripts/release-derive.cjs --stamps`) and passes them in as
  the `RELEASE_STAMPS` build arg. A build without them still derives the version
  numbers, just without dates.
- A scheduled workflow (`release-compact.yml`, daily 04:45 UTC + manual
  `workflow_dispatch`) folds pending fragments into the three canonical files —
  one CHANGELOG section and one release-notes entry per fragment, each with its
  own version, timestamp and linked commit — and deletes them, via a **normal
  pull request** so branch protection stays intact. That PR is the only thing
  that ever edits the version line.
- `npm run check:release-fragments` (in CI) fails a PR whose fragment is
  malformed or missing a locale. `npm run test:release` guards the arithmetic.

## When compaction is stuck (#2142)

A delayed compaction is harmless **to the app** — the build derives the version
and the release-notes entries from base+fragments, so the sidebar footer,
`/api/health` and `/release-notes` stay correct however long the fragments sit
there. It is *not* harmless to the **record**: while compaction is stuck,
`CHANGELOG.md` and `src/lib/releaseNotes.ts` keep saying whatever they said
when it last succeeded, so merged PRs appear nowhere in the repo's history of
what shipped.

That is exactly what happened between 2026-08-24 and 2026-09-02: all ten runs
failed, 57 fragments accumulated, and 25 versions never reached the changelog.
Two causes, chained — and both are now designed against:

- **`RELEASE_BOT_TOKEN` was unset**, and this org forbids the default
  `GITHUB_TOKEN` from opening pull requests, so `gh pr create` was refused.
  The workflow now warns about the missing secret up front and, if creation
  still fails, emits an `::error` naming the branch that is ready to open.
- **The branch name carried the version** (`bot/release-compact-<version>`),
  so every retry rebuilt the *same* name with a *different* commit sha and was
  rejected as non-fast-forward — one failed run wedged the pipeline for good.
  There is now **one stable branch, `bot/release-compact`, force-pushed**. That
  is safe by construction: the branch only ever holds an earlier compaction
  attempt built from the same `main`, which the new commit strictly supersedes,
  because compaction always folds *everything* pending. A failed run therefore
  leaves the branch correct and current, and the next run recovers by itself.
- **Nothing announced the failure.** The workflow now has a `notify` job that
  emails through `scripts/send-alert-email.mjs`, like `e2e-full`, `k6-load`,
  `stress` and `backup-verify`.

To compact by hand at any time — no secret needed, and the right move if the
scheduled run is red:

```bash
git fetch origin main && git checkout -b chore/release-compact origin/main
node scripts/release-compact.mjs --dry-run   # inspect
node scripts/release-compact.mjs             # write + delete the fragments
```

It needs **full git history** (each fragment's date and commit come from the
commit that added it); in a shallow clone it fails closed rather than invent a
date, so `git fetch --unshallow` first.

## Edge cases, so they are not reported as bugs

- **Two fragments in one commit** share a date and a sha and get consecutive
  versions (only the later one was ever displayed). Filename breaks the tie.
- **Editing an already-merged fragment** keeps the original add-commit, so the
  release keeps its place in the timeline while the text changes. Never
  re-stamp on edit — that would renumber versions people have already seen.
- **On a PR's own preview env** (`crm-pr<N>`) the fragment's add-commit is the
  branch commit; after the squash merge it is a different sha. The topic env can
  therefore show a sha that main's history never had.
- **A shallow checkout cannot date a release.** Compaction *fails closed*
  rather than write today's date over the real one — the workflows that stamp
  check out with `fetch-depth: 0`. An **uncommitted** fragment (the one you just
  wrote) is allowed to be undated: it sorts last and shows no commit.

## For agents & reviewers

The old three-file versioning checklist is replaced by: **does the PR that
ships a change carry a fragment?** One file, no numbering, no rebase churn.
