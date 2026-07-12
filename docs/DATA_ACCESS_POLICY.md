# Data Access Policy (contributors)

Status: **binding** for everyone contributing code to this repository (staff,
interns/mentees, external contributors). Issue: #550 · Epic: #517.

## Principle

Contributors work on **synthetic data only**. Real user data (production, and
the shared preview database) contains personal data of real mentees, mentors
and companies; access to it is limited to the operator (admin) and is never
required to develop or review a change.

## Rules

1. **Local development uses seeded fake data.**
   - `npx prisma db push` against your **local** MySQL, then:
   - `npx prisma db seed` — first admin account (env-driven), and
   - `npm run seed:demo` — a rich, fully synthetic data set (mentors, mentees
     across all pipeline stages, companies + needs, relations, interactions,
     goals, evaluations, a project, a cohort). All demo accounts use the
     `@demo.example.com` domain; no real person is represented.
   - The demo seeder **refuses to run** against a non-local `DATABASE_URL`
     (override only with `SEED_DEMO_FORCE=1`, and only if you are certain the
     target is not the shared preview/prod DB).

2. **No contributor access to production or preview PII.**
   - Do not point your local `.env` at the production database, ever.
   - The shared preview DB (see the warning in `CLAUDE.md` and issue #39) is
     operated by the maintainer. Contributors should not browse, export, or
     copy its contents. If a change needs realistic data, extend
     `prisma/seed-demo.mjs` instead.
   - E2E tests create and clean up their own namespaced records; they do not
     read pre-existing user rows.

3. **Who can access what**
   | Data | Contributors | Maintainer/operator |
   |------|--------------|---------------------|
   | Local seeded DB | ✅ full | ✅ |
   | Shared preview DB | ❌ (no PII browsing; CI deploys only) | ✅ |
   | Production DB | ❌ | ✅ (admin duties only) |
   | Backups/exports | ❌ | ✅ |

4. **Incident rule.** If you accidentally receive or view real PII (e.g. a
   screenshot with real data in an issue), tell the maintainer; don't copy it
   further, and scrub it from the issue/PR.

## Operational follow-ups (maintainer)

- Preview isolation is tracked in #39 (all PRs share one preview container/DB).
  Until it lands, keep contributor credentials off the preview DB and consider
  periodically re-anonymizing it (replace names/emails/phones with synthetic
  values) — do **not** run destructive SQL against preview without a backup.
- This policy is referenced from `CLAUDE.md` so agents and humans onboard with it.
