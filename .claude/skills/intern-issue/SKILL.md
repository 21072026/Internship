---
name: intern-issue
description: End-to-end pipeline for a single "good first issue" from the intern backlog (issue #478) in this repo — self-assign, branch, implement, i18n, e2e test, CI, and AUTO-MERGE to main. Only run when explicitly invoked; never auto-trigger.
disable-model-invocation: true
argument-hint: <issue-number>
arguments: [issue]
---

# Intern issue pipeline

Process GitHub issue **#$issue** in this repo (`21072026/Internship`) completely autonomously,
ending with a squash-merge to `main`. This mirrors the exact workflow used to clear issues
#463–#477 from the intern backlog (#478) in a prior session.

⚠️ **This skill merges to `main` without asking.** That is a deliberate override of this
repo's normal "leave merges to a human" convention (see `CLAUDE.md`). Only invoke it when the
user has actually asked for autonomous end-to-end processing. If invoked for an issue that
touches anything security-sensitive, auth, payments, or data-destructive migrations, stop and
ask instead of merging.

## 0. Preconditions

- Confirm the issue is open and unclaimed before doing anything:
  `gh issue view $issue --json state,assignees,title,body,labels`
  - If `state` is `CLOSED`, stop and report — nothing to do.
  - If it already has an assignee that isn't you, or a linked PR from another contributor
    (check `gh pr list --search "$issue in:body"`), **stop and report** — do not duplicate
    someone else's claimed work. This happened with issue #468 (claimed by an external
    contributor's draft PR) and was correctly skipped.
- Self-assign: `gh issue edit $issue --add-assignee "@me"`

## 1. Branch — create it FIRST, before touching any files

```
git checkout main -q && git pull --ff-only -q
git checkout -b <fix|feat>/$issue-<slug>
```

Use `fix/` for bug fixes, `feat/` for new functionality. The issue body usually suggests an
exact branch name ("... `fix/<issue-no>-slug` gibi bir branch açın") — use that if given.

This step must run before any `Read`/`Edit`/`Write` calls. Editing files while still on `main`
or a previous branch (then having to `git stash` + branch + `stash pop`) was a repeated,
avoidable mistake in the prior session.

## 2. Implement

- Read the issue body fully — it names concrete files/line numbers and acceptance criteria.
- Re-read the target files fresh (don't trust remembered line numbers from the issue text —
  they drift as other PRs land). Use `Read`, not just `grep`, before any `Edit`.
- Match the codebase's existing conventions exactly rather than introducing new patterns —
  e.g. for a new `window.confirm()` guard, copy the `t.<ns>.confirmDelete.replace('{name}', ...)`
  pattern already used in `admin/cohorts/page.tsx`; for a new zod-validated route, copy the
  `safeParse` + `{ error: 'Validation failed', details: parsed.error.flatten() }` + 400 pattern
  from `src/app/api/interactions/route.ts`.
- Don't scope-creep. If the issue says "only these 3 routes," touch only those 3 — note related
  findings in the PR body instead of fixing them too.

## 3. i18n (if any user-facing string changed or was added)

- New keys go in **all three** locale blocks in `src/i18n/dictionaries.ts` (EN → TR → DE, in
  that file order). Find each block fresh via `grep -n "^  <section>: {" src/i18n/dictionaries.ts`
  before every edit — line numbers shift after each insertion.
- Run `npm run check:i18n` — must report `i18n OK — N keys × 3 locales` with no missing/empty
  translations.

## 4. Tests

Write or extend a Playwright spec in `e2e/`, following the existing helper pattern:

```ts
import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
// only import { prisma, ... } too if you need direct DB setup/teardown
```

Login pattern: `page.goto('/auth/signin')` → fill `input[type="email"], input[name="email"]` and
`input[type="password"]` → click `button[type="submit"]` → `page.waitForURL(...)`.

Locator pitfalls hit repeatedly in the prior session — avoid these:
- **`input[type="search"]` is not unique on admin pages** — `AdminNav` renders its own sidebar
  filter box with the same type. Add a `data-testid` to any new search input and target that.
- **`getByText('X')` does substring matching** — a seeded user named e.g. "RB Company" makes
  `getByText('Company')` match the name too. Use `{ exact: true }` or scope to a specific
  element/table (`page.locator('table').getByText(...)`).
- Local `npm run test:e2e` usually can't run here — `DATABASE_URL` points at the shared preview
  DB which is typically unreachable from a local/dev sandbox. Don't burn time debugging that;
  rely on CI's isolated MySQL service to actually execute the suite (see step 6).

## 5. Local verification

```
npx tsc --noEmit
npm run lint
npm run check:i18n   # if step 3 applied
npm run build        # required if you touched manifest.ts, layout.tsx metadata, or config
```

All must be clean (lint warnings that pre-exist and are unrelated to your diff are fine —
diff the warning list against `git stash` if unsure).

## 6. Commit, push, PR

- Stage **explicit file paths only** — never `git add -A` or `git add .`.
- Commit message: explain *why*, not what (the diff already shows what). End with:
  ```
  Closes #$issue

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- `git push -u origin <branch>`
- `gh pr create` with a body containing a `## Summary` (bullets on what changed and why) and a
  `## Test plan` checklist — mark `[x]` for everything you actually ran locally (tsc, lint,
  build, i18n check, the new e2e test's logic) and leave CI-only items as `[ ]`.

## 7. CI — poll, and auto-retry the known flakes only

Poll until no check is pending/queued/in_progress:

```
until s=$(gh pr checks <PR> 2>/dev/null | awk -F'\t' '{print $2}' | sort -u); [ -n "$s" ] && ! echo "$s" | grep -qi "pending\|in_progress\|queued"; do sleep 20; done
gh pr checks <PR>
```

Three required checks: **Lint · Typecheck · Build**, **Playwright smoke**, **Preview Deploy**.

If **Playwright smoke** fails, inspect the actual failure before assuming it's unrelated:

```
gh run view <run-id> --log-failed 2>&1 | grep -E "✘|failed"
```

- If every failing test is one of the **known pre-existing flakes** —
  `e2e/account-self-service.spec.ts:52` ("changing email requires the correct current
  password") or `e2e/sign-out-all.spec.ts:24` ("sign out of all devices...") — both usually
  preceded by a `[WebServer] ⨯ TypeError: Cannot read properties of null (reading 'user')`
  warning in the log — this is infra flakiness, not your change. `gh run rerun <run-id>
  --failed` and poll again. Other tests (`dashboard.spec.ts`, `mentors.spec.ts`,
  `webhooks-openapi.spec.ts`) have also intermittently failed-then-passed-on-retry in
  practice; treat a first-time failure in an unrelated spec the same way, but only up to
  **3 reruns total** for one PR.
- If a failure is in a test your diff plausibly touches, or the same test keeps failing after
  3 reruns with the same non-infra error, **stop — do not merge.** Report the failure to the
  user with the log excerpt and your assessment of whether it's a real regression.
- **Preview Deploy** failing on a fork PR is expected/handled separately (build-only mode) —
  not your concern unless you're working from a fork.

## 8. Merge (autonomous — this is the whole point of this skill)

```
gh pr merge <PR> --squash --delete-branch --admin
gh pr view <PR> --json state,mergedAt -q '.state, .mergedAt'   # confirm MERGED
```

## 9. Update the GitHub Project board

```
ITEM_ID=$(gh project item-add 2 --owner mersahin --url https://github.com/21072026/Internship/issues/$issue --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
gh project item-edit --id "$ITEM_ID" --field-id PVTSSF_lAHOADrM1M4BbnzxzhWXFDs --project-id PVT_kwHOADrM1M4Bbnzx --single-select-option-id 98236657
```

(Project 2, "Status" field `PVTSSF_lAHOADrM1M4BbnzxzhWXFDs`, "Done" option `98236657`. Other
option ids on this field if ever needed: Backlog `f75ad846`, Ready `61e4505c`, In progress
`47fc9ee4`, In review `df73e18b`.)

## 10. Sync and report

```
git checkout main -q && git pull --ff-only -q
```

Report back in 2–4 sentences: what issue was closed, the PR URL, whether CI needed a flake
retry, and confirmation the board is updated. If the skill was invoked for a whole batch, end
by naming the next unclaimed issue from #478 rather than stopping silently.
