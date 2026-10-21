# 2026-10-20/21 — Report segmentation (#1920) and the company → candidate channel (#1840)

Shipped: #3021, #3029, #3064 (#1920 in three slices), #3102 (CodeQL + mobile-layout follow-up), #3088 (#1840).

## Lessons

- **Slice a large issue by dependency, and stack carefully.** Models + CRUD → import →
  report slicing worked well as three PRs. A PR stacked on an unmerged one (base `main`)
  shows both commits until the first merges; don't enable auto-merge on the upper one
  until the lower one is in.
- **Segment filters as relation subqueries.** Passing a `Prisma.UserWhereInput` "person"
  filter into existing loaders (`mentee: { is: person }`) sliced seven reports without
  touching their logic or building id lists; screens that pass no filter are unchanged.
- **A new sidebar entry needs a mobile-layout inventory entry in the same PR.**
  `e2e/mobile-layout-coverage.spec.ts` reads the rendered drawer and goes red on main
  (scheduled suite only, not the PR gate) — easy to miss. Same for the mobile app's
  `apps/mobile/src/lib/menu.ts` icon (a unit test enforces that one).
- **CodeQL `js/xss-through-dom` fires on hrefs built from form values**, even relative
  ones through `URLSearchParams`. Build URLs from trusted keys (definition key, the
  server-listed attribute key) and `encodeURIComponent` the free text.
- **New settings need two entries now:** `SETTING_DEFAULTS` *and* the typed settings
  schema below it (`{ type, scopes }`), or `e2e/settings-resolution.unit.spec.ts` fails
  typecheck.
- **A second `<textarea>` on a page breaks specs that `page.fill('textarea')`.** Keep a
  new composer collapsed behind a button when the page already has one.
- **Status first, side effects after → poll the side effect in e2e.** The approval route
  commits APPROVED before posting the message; a spec polling the status raced the post.
- **Local env:** after a container restart run `service mysql start` and `npx prisma
  generate`; when `db push` refuses an index change from main (`Cannot drop index
  Setting_orgId_key_key`), drop and recreate the local test DB. On a 4-CPU box `next dev`
  cold compiles exceed 10–20 s spec timeouts — verify on a warm server
  (`--repeat-each=2`) and compare against clean `main` (`git stash -u`) before calling a
  failure yours. CI runs `next start`, so it does not see this.
- **Avoid MARKETING leak words in new copy** ("mentor", "mentee", "internship") when a
  neutral phrasing exists ("the candidate's programme team") — the leak ratchet is 0.
