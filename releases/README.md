# Release fragments (#1275)

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
- **`changelog`**: developer-facing Keep-a-Changelog bullet(s), markdown.
- **`notes`**: user-facing highlights for `/release-notes` — all three of
  EN/TR/DE or none. Omit the field for changes users don't see.
- Trivial non-user-facing changes (pure docs, CI config) still need **no**
  fragment at all, same as before.

## How the version stays correct

- `next.config.js` reads the fragments at **build time** and derives the real
  version (base from `package.json`, +minor/+patch per fragment, sorted by
  filename) plus one synthetic release-notes entry. The sidebar footer,
  `/api/health`, and `/release-notes` all show the derived version immediately
  after a merge deploys.
- A scheduled workflow (`release-compact.yml`, daily 04:45 UTC + manual
  `workflow_dispatch`) folds pending fragments into the three canonical files
  with the real date and deletes them — via a **normal PR** that passes the
  usual checks, so branch protection stays intact. That PR is the only thing
  that ever edits the version line again.
- `npm run check:release-fragments` (in CI) fails a PR whose fragment is
  malformed or missing a locale.

## For agents & reviewers

The old three-file versioning checklist is replaced by: **does the PR that
ships a change carry a fragment?** One file, no numbering, no rebase churn.
