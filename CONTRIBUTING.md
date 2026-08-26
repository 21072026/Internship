# Contributing

Thanks for contributing to Internship CRM. This guide covers the workflow.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md)
([Türkçe](docs/code-of-conduct.tr.md), [Deutsch](docs/code-of-conduct.de.md)).
Report unacceptable behaviour to **ersahin@bcsit-gmbh.de**.

## Contributor terms (IP)

Read this before your first pull request. Opening a PR means you accept these terms —
the PR template asks you to confirm it.

- **Sole rights holder.** All rights in Internship CRM are held by **Mehmet Erşahin**
  (a natural person, not a company). Only the rights holder may license the software.
- **Your contribution.** You license your contribution under **AGPL-3.0-or-later** and
  grant the rights holder an **exclusive, perpetual, worldwide, sub-licensable right to
  use it** (assignment of economic rights where the law permits; under German copyright
  law the copyright itself cannot be transferred, § 29 UrhG, so the mechanism is an
  exclusive exploitation right, § 31 (3) UrhG).
- **Dual licensing.** You agree the rights holder may also offer your contribution under
  a separate **commercial license**, without AGPL obligations.
- **No claims.** Contributions are made within the mentorship, without additional
  remuneration, and give rise to **no copyright, license, fee, partnership, or equity
  claim** over the application.
- **Portfolio grant-back.** You keep the right to present your own contributions in a
  personal portfolio or for educational purposes (non-commercial).
- **Originality.** You confirm your contribution is your own work and does not infringe
  third-party rights. Don't paste in code you don't have the right to contribute.
- **Beyond the mentorship.** Paid, external, or corporate contributors sign a short
  written agreement instead of relying on the PR confirmation — see
  [docs/legal/cla-contributor-agreement.md](docs/legal/cla-contributor-agreement.md).

Trademarks are **not** covered by the AGPL: the "Internship CRM" name, logo, and the
`crm.ersah.in` domain stay with the rights holder (see [README](README.md#trademarks)).

## Workflow

1. **Branch** off `main`: `feat/<issue>-slug`, `fix/<issue>-slug`, `docs/...`, `test/...`.
2. **Commit** in small, focused changes. Reference the issue (`Closes #123`).
3. **Open a PR** into `main`. CI must pass before merge (see below).
4. `main` is protected: merging requires the **CI**, **Playwright smoke** and
   **Preview Deploy** checks to be green and the branch to be up to date.

## Local checks (run before pushing)

```bash
npm run lint          # ESLint
npx tsc --noEmit      # type check
npx prisma validate   # schema check
npm run build         # production build
npm run test:e2e      # Playwright (starts the app; needs a DB)
```

## Database & schema

- This project uses **`prisma db push`** — there is **no `migrations/` folder**.
- Change `prisma/schema.prisma`, then `npx prisma generate`. After switching
  branches, regenerate so the client matches the schema.
- Do **not** run `db push` against the shared preview/prod DB — CI does it on deploy.

## Tests

- E2E tests live in `e2e/` (Playwright). Add one for each user-facing change.
- Tests seed their own data via `e2e/helpers/db.ts` and clean up after.
- Load tests live in `k6/` (k6, a standalone binary — not an npm dependency) and run on a
  nightly cron. `npm run test:load` is **optional locally**; if you do run it, point
  `BASE_URL` at your own dev server or the preview env, **never at production from a
  laptop**. See [docs/testing.md](docs/testing.md) for the safety rules a k6 script here
  must follow.

## Conventions

- Match the surrounding code's style; keep components small.
- User-facing strings go through the i18n dictionary (`src/i18n/dictionaries.ts`)
  via `useT()` (client) or `getServerDictionary()` (server).
- Co-author trailer on commits when pairing with an assistant.

## Deployment

Push to `main` deploys production; every PR deploys a preview. See
[CLAUDE.md](CLAUDE.md) for the full architecture and deploy topology.

## Project board

New issues/PRs should appear on the board automatically. If they don't, enable
the built-in **Auto-add to project** workflow in the Project's *Workflows*
settings (no token needed) — this is preferred over a GitHub Action (which would
require a PAT with `project` scope).
