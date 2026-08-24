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

- **Re-anonymizing preview is now a script, not a plan (#1186).**
  `npm run sanitize:preview` rewrites a preview database into synthetic data:
  every account becomes `userN@demo.example.com` with a fake name and one shared
  password, phones/addresses/bios/links are cleared, uploaded files and every
  credential are deleted, and all free text written by or about a person
  (notes, messages, evaluation comments, weekly reports, notification text,
  activity-log details) is replaced. Relationships, pipeline history, dates and
  counts survive — that is where preview's test value lives.

  Two guarantees worth knowing before running it:
  - It **refuses to run** unless the database *name* contains `preview` or
    `internship_pr`, and there is deliberately **no force flag** — it must not
    be possible to point it at production. (The mirror image of `seed:demo`,
    which refuses to write anywhere but a local/demo database.)
  - It **verifies itself** afterwards and exits non-zero if any real address,
    phone, file, note or credential survived. `npm run sanitize:verify` runs
    that check alone, changing nothing — use it to answer "is preview still
    clean?" after a restore or an import.

  Still true: take a backup before running anything destructive against preview.
- Preview isolation is tracked in #39 (all PRs share one preview container/DB).
  Until it lands, keep contributor credentials off the preview DB.
- This policy is referenced from `CLAUDE.md` so agents and humans onboard with it.
