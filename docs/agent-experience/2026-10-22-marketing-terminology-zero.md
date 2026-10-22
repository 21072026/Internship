## 2026-10-22 — MARKETING terminology ratchet to zero, last internship surfaces gated, topic deploy skip on conflict (#2981, #2983, #2984, #3133, #3142)

- **Bulk overlay work: generate JSON, merge it with a script, never hand-edit 1,000 lines.** The
  ~400 leaking keys × 3 locales were written by parallel agents as nested JSON, then merged into
  `src/i18n/verticalOverlays.ts` with a small text merger that finds `key: {` at the exact indent,
  expands one-line objects (`nav: { a: 'x' }`) and appends missing keys. `check:i18n` validates
  the result (existing keys only, same `{placeholder}` set). Keys can contain dots
  (`notifications.events['outcome.placedElsewhere']`): carry key paths as arrays, never as
  `split('.')`.
- **Read the translations for claims, not only for forbidden words.** A mechanical
  mentor→rep pass turned "free for mentees and mentors, always" into a false MARKETING pricing
  promise (MARKETING bills per user). `grep -iE "free|kostenlos|ücretsiz"` over the added lines
  found it; the leak regex never would.
- **Triage before translating: an argued `LEAK_EXEMPT` beats overlaying an unreachable screen.**
  Nineteen namespaces sit behind `gatePage`/`requireCapability`, the mentor shell or the portal;
  verify each gate (`ls src/app/admin/<x>/layout.tsx`, the API's `requireCapability`) and write
  the gate into the exempt reason.
- **Check what a "missing gate" protects before adding one.**
  `POST /api/mentorship/[id]/transfer` has no `mentorship` capability check *on purpose*:
  MARKETING hands a lead to another rep with it (`e2e/deal-value.spec.ts`). Grep `e2e/` for
  the route on the marketing host first.
- **Next emits a page's metadata on its 404.** Gating a page with `notFound()` still leaks its
  title and `og:image` into the head. `generateMetadata` must return `{}` off the vertical, and
  an `opengraph-image` must return `renderCard(null)`. `requestVerticalHas()` and
  `requestIsDefaultVertical()` in `src/lib/verticalPage.ts` do both.
- **Dead i18n keys: find them by word search, then rule out dynamic lookups.** 128 `landing.*`
  keys had no reader after the landing was slimmed. Compare every leaf key against the set of
  identifiers in `src`, `e2e`, `scripts` and `apps` (excluding `dictionaries.ts` /
  `verticalOverlays.ts`), then grep for `L[` / template-built keys before deleting.
- **Container quirks this session:** `npx tsc --noEmit` ran out of memory at the default heap
  (`NODE_OPTIONS=--max-old-space-size=6144`). After fetching a newer `main`, run
  `npx prisma generate` *and* `npm install` before `tsc`, or you chase stale-client and
  missing-module errors. `npm install` rewrites `package-lock.json`; `git checkout -- package-lock.json`
  before committing. `pkill -f "<pattern>"` also kills the shell whose command line contains the
  pattern.
- **`npm run test:unit` had one red test on `main`** (`marketing-ops-clis.test.mjs`,
  `ExternalProfileLink`). Confirm a failure on a clean `git stash` before blaming the diff.
