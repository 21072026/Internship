## 2026-11-15 — MARKETING vertical gates: company portal, dashboard links, analytics reports, hover card (#2348, #3679, #3689, #3698, #3708, #3750)

- **Run the e2e against a production build, not `next dev`.** On a cold dev server every first
  hit compiles the route, so specs fail with `apiRequestContext` timeouts, `ECONNRESET` and
  `waitForURL` timeouts that have nothing to do with the code. Use `npm run build` once, then
  `CI=1 npx playwright test …`: the config then runs `npm run start` itself, with the right env.
  71 related specs took 2.2 min that way, while the same set had not got past 10 tests in
  25 min on dev.
- **`CI=1` locally also means `reuseExistingServer: false`.** Mock servers left over from a
  killed run (`e2e/support/*-mock.mjs` on :4599…) make the next run die on "port already used".
  Run `pkill -f "e2e/support/"` before each run.
- **Local schema drift shows up as `prisma.user.create()` errors in unrelated specs.** After
  merging main, run `npx prisma db push --skip-generate --accept-data-loss` against the local
  `internship_e2e` (check `.env` first), not only `prisma generate`.
- **`check:demo-fidelity` needs a seeded demo DB, exactly as the CI job seeds it.** Against the
  e2e DB it is always red. Run it like this:
  `DATABASE_URL=…/internship_test npx prisma db push && npm run seed:demo && npm run check:demo-fidelity`.
- **A `notFound()` in a nested layout under an async parent `<I18nScope>` renders the 404 screen
  with HTTP 200.** The parent is already streaming when the nested gate fires (seen under
  `admin/analytics/{outcomes,closure,roi}`). Top-level sections such as `/admin/mentors` get a
  real 404, because their gate runs before their own scope. Assert the visible "Page not
  found" heading; the orchestrator accepted that rather than touching the shared layout.
- **`requireCapability()` answers `capability_unavailable`.** A route whose UI branches on
  `capability_missing` (the admin company-login provisioning) builds its own 403.
- **Gate a shared resolver once instead of each handler.** All six
  `/api/company/integrations/*` handlers go through `ownCompany()`
  (`src/lib/companyIntegrations.ts`), so one `requireCapability` there covers them all.
- **Look beyond the listed routes.** `GET /api/companies/[id]` returned a COMPANY reader the
  funnel through `include.mentorships`: names, e-mails and stage. The fix was the relation
  scope (`{ id: NO_MATCH }`), not a 403, because the company record itself stays readable.
- **An empty list, not a 403, where shared components call the route.** In MARKETING,
  `/api/mentorship` answers a COMPANY login `[]`, because MeetingsManager and the composers
  mount for that session and a refusal would break them.
- **A pure link helper takes the capability as a parameter.** `personHref(viewer, person,
  { mentorship })` defaults to the base product, so existing callers are unchanged. The client
  caller reads the capability from `useHasCapability()` (`src/lib/capabilitiesClient.tsx`).
- **GitHub git/HTTPS 503s come and go in this container.** Wrap `git fetch`/`push` in a retry,
  and after a push compare `git ls-remote origin <branch>` with `git rev-parse HEAD`. Once a
  "successful" `git merge origin/main` was really a no-op because the fetch before it had
  failed.
- **Main moves every few minutes.** When the only new commits on main touch none of the PR's
  files, merge the PR at the head the local gate verified. Re-run the gate when they do overlap.
