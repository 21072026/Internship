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

## Media on a release note (#2233)

A note that says *"mentees can now request a mentor straight from the directory
card"* tells a reader who has never seen that screen nothing at all. One small
picture answers it — and Playwright is already driving that exact screen, so the
picture is nearly free.

A fragment may therefore carry an **optional** `media` block:

```json
{
  "bump": "minor",
  "changelog": "- **Request a mentor from the card** (#1234). …",
  "notes": { "en": ["…"], "tr": ["…"], "de": ["…"] },
  "media": {
    "poster": "release-media/request-mentor-cta.png",
    "video": "release-media/request-mentor-cta.webm",
    "alt": {
      "en": "The mentor card with its new Request mentor button",
      "tr": "Yeni \"Mentor talep et\" butonuyla mentor kartı",
      "de": "Die Mentorenkarte mit der neuen Schaltfläche \"Mentor anfragen\""
    }
  }
}
```

**Optional, permanently.** A backfill, a CI guard, an API fix has no screen to
show. A fragment without `media` is completely valid and renders exactly as it
always has — this is never a checklist item that blocks a PR, and reviewers must
not treat it as one.

### When it is worth adding

| Add a **still** | Add a **clip** | Add **nothing** |
|---|---|---|
| A new control, badge, column, empty state — anything a reader could recognise on the screen | Motion is the point: a drag, a reveal, a live update, a transition that explains the change | Backend, CI, schema, performance, a fix with no visible surface |

A still is **always required**; the clip is always optional and rides on top of
it. Three surfaces show this media and **none of them can play video**:
`CHANGELOG.md` is markdown, an older iOS PWA install may not decode WebM, and a
reader who has asked for reduced motion must be shown something that does not
move. One poster PNG serves all three, so "clip + poster" is the natural shape
rather than extra work — and a `video` without a `poster` is rejected.

**WebM, never GIF.** Playwright records WebM natively with no `ffmpeg`
dependency, and the same clip as a GIF is roughly ten times the bytes.

### How to capture

`e2e/release-media.spec.ts` is the capture spec. It is a **producer, not a
test**: it does not run in the PR gate and it does not run in the scheduled full
suite (`playwright.config.ts` only declares its project when
`CAPTURE_RELEASE_MEDIA` is set). Copy one of the two templates in it, point it
at your screen, then:

```bash
npm run test:e2e:media                      # capture everything in the spec
npm run test:e2e:media -- --grep "poster"   # just one
```

- **Stills** use `locator.screenshot()` — an **element**, never `page`. A
  cropped component stays small and does not churn every time unrelated page
  chrome moves.
- **Clips** use Playwright's `recordVideo`, which records **per BrowserContext,
  whole viewport, for the whole test**. Playwright cannot crop to an element or
  trim to the interesting seconds, so do not try: keep the capture test minimal,
  so the whole test *is* the content, and set `recordVideo.size` modestly.
- Captures are **light theme only** — two themes would mean two files per note.
  The page frames the picture in a visible border and pins a white background,
  so a light capture still reads as *a screenshot* on the dark page.

Commit the files with the PR, under `public/release-media/`, named after the
fragment slug: `release-media/<fragment-slug>.{png,webm}`.

### The caps, and what enforces them

`npm run check:release-fragments` reads the actual bytes (no `ffmpeg` — the PNG
header for the size, the EBML header for the duration) and fails on:

| Rule | Why |
|---|---|
| `poster` present whenever `media` is | Markdown, WebM-less browsers and reduced motion all need a still |
| `poster` is a `.png` under `release-media/`, `video` a `.webm` | One directory, one naming convention, no GIFs |
| the referenced file exists under `public/` | A broken image on a page that must always render |
| poster ≤ **150 KB** | A cropped element screenshot is 40-80 KB; the cap catches a full-page capture pasted in by mistake |
| clip ≤ **1.5 MB** | Bounded repo growth — the media is committed, not uploaded off-site |
| clip ≤ **5 seconds** | WCAG 2.2.2: longer auto-playing motion would need a pause control on every card |
| `alt` in all of EN/TR/DE | Same rule as `notes` — the picture carries meaning, so its description is localized |

Why committed to `public/` rather than object storage: R2 exists here for
backups, but putting release media there would add a deploy-time dependency and
a broken-image failure mode to a page that must always render. Bounded by the
caps, this costs roughly 20 MB a year.

### Accepted trade-off: it goes stale

A note from three months ago will show a screen that no longer looks like that.
For a historical changelog that is **correct**, not a bug — every entry already
carries its version, date and commit. There is deliberately no re-capture job,
and stale media is never a CI failure.

### Where it ends up

- `/release-notes` — at most 480px wide, rounded, framed, with localized `alt`
  and the poster's own pixel size set so the list does not reflow. With a clip:
  `autoplay loop muted playsinline`, poster as the fallback, and under
  `prefers-reduced-motion: reduce` the **poster** renders and the video is never
  mounted at all.
- `CHANGELOG.md` — the compaction writes the **poster** as a markdown image
  under the section, because markdown cannot play a video.
- `src/lib/releaseNotes.ts` — the compaction carries the whole `media` block
  (including the pixel size) into the permanent entry, so the picture survives
  long after the fragment is deleted.

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
